import type { CoreDeps } from "./context.js";
import type { Message, MessageBody, DispatchableMessage } from "../domain/message.js";
import { ProviderError } from "../domain/errors.js";
import { isExhausted, backoffMs } from "./pipeline/retry-policy.js";
import { validateRecipient, MxCache, extractDomain } from "./pipeline/domain-validation.js";
import { sanitizeRecipient, sanitizeSubject, assertBodyWithinLimits } from "./pipeline/sanitize.js";

export type DispatchOutcome =
  | { kind: "sent"; providerMessageId: string }
  | { kind: "retry"; nextAttemptAt: Date }
  | { kind: "rate_limited"; nextAttemptAt: Date }
  | { kind: "failed"; reason: string }
  | { kind: "skipped"; reason: string };

/**
 * DispatchMessage — processes ONE message already claimed (state `sending`) by
 * the send worker. Implements the outbound pipeline (TDR §3.2):
 *
 *   1. Idempotency / state guard  (no double-send under concurrency)
 *   2. Decrypt PII                (READ-side encryptor, only here)
 *   3. Re-sanitize decrypted data (defense in depth)
 *   4. Domain validation          (syntax + cached MX)
 *   5. Rate limiting              (global / provider / domain)
 *   6. Dispatch                   (provider.send)
 *   7. State transition + audit
 *
 * Decryption happens as late as possible — immediately before dispatch — so
 * plaintext never lives in the queue (TDR §5.4).
 */
export class DispatchMessage {
  private readonly mxCache: MxCache;

  constructor(private readonly deps: CoreDeps) {
    this.mxCache = new MxCache(deps.config.domainValidation.mxCacheTtlMs ?? 3_600_000);
  }

  async execute(message: Message): Promise<DispatchOutcome> {
    const { deps } = this;
    return deps.telemetry.span(
      "outpost.dispatch",
      { messageId: message.id, provider: message.provider },
      async () => {
        // 1. State guard — only act on a message we still own in `sending`.
        const fresh = await deps.outbox.findById(message.id);
        if (!fresh || fresh.state !== "sending") {
          return { kind: "skipped", reason: "no longer in sending state" };
        }

        const provider = deps.providers.get(fresh.provider);
        if (!provider) {
          return this.fail(fresh, `No provider registered for "${fresh.provider}"`);
        }

        try {
          // 2. Decrypt (read-side) -----------------------------------------
          const to = await deps.openEncryptor.open(fresh.recipientSealed);
          const bodyJson = await deps.openEncryptor.open(fresh.bodySealed);
          const body = JSON.parse(bodyJson) as MessageBody;

          // 3. Re-sanitize decrypted values --------------------------------
          const cleanTo = sanitizeRecipient(to, deps.config.sanitize);
          const cleanSubject = sanitizeSubject(fresh.subject, deps.config.sanitize);
          assertBodyWithinLimits(body, deps.config.sanitize);

          // 4. Domain validation -------------------------------------------
          await validateRecipient(cleanTo, deps.config.domainValidation, {
            mxResolver: deps.mxResolver,
            mxCache: this.mxCache,
            nowMs: deps.clock.now().getTime(),
          });

          // 5. Rate limiting ------------------------------------------------
          const limited = await this.checkRateLimits(fresh.provider, cleanTo);
          if (limited) {
            return this.requeueRateLimited(fresh);
          }

          // 6. Dispatch -----------------------------------------------------
          const dispatchable: DispatchableMessage = {
            id: fresh.id,
            to: cleanTo,
            subject: cleanSubject,
            body,
            headers: this.buildHeaders(),
            metadata: fresh.metadata,
          };
          const receipt = await provider.send(dispatchable);

          // 7. Transition to `sent` ----------------------------------------
          await deps.outbox.updateState(fresh.id, {
            state: "sent",
            providerMessageId: receipt.providerMessageId,
            lastError: null,
          });
          await deps.audit.append({
            messageId: fresh.id,
            eventType: "dispatch_accepted",
            actor: `provider:${fresh.provider}`,
            detail: { providerMessageId: receipt.providerMessageId },
          });
          deps.telemetry.counter("outpost.dispatch.sent", 1, { provider: fresh.provider });
          return { kind: "sent", providerMessageId: receipt.providerMessageId };
        } catch (err) {
          return this.handleError(fresh, err);
        }
      },
    );
  }

  /** Classify the error and either retry-with-backoff or dead-letter. */
  private async handleError(message: Message, err: unknown): Promise<DispatchOutcome> {
    const permanent = err instanceof ProviderError && err.errorClass === "permanent";
    const reason = err instanceof Error ? err.message : String(err);

    if (permanent) {
      return this.fail(message, reason);
    }

    // Transient (or unknown → treated as transient). Increment attempts.
    const attempts = message.attempts + 1;
    if (isExhausted(attempts, this.deps.config.retry)) {
      return this.fail(message, `Retries exhausted (${attempts}): ${reason}`, attempts);
    }

    const delay = backoffMs(attempts, this.deps.config.retry, this.deps.random());
    const nextAttemptAt = new Date(this.deps.clock.now().getTime() + delay);
    await this.deps.outbox.updateState(message.id, {
      state: "queued",
      attempts,
      nextAttemptAt,
      lastError: reason,
    });
    await this.deps.audit.append({
      messageId: message.id,
      eventType: "retry_scheduled",
      actor: `provider:${message.provider}`,
      detail: { attempts, nextAttemptAt: nextAttemptAt.toISOString(), reason },
    });
    this.deps.telemetry.counter("outpost.dispatch.retry", 1, { provider: message.provider });
    return { kind: "retry", nextAttemptAt };
  }

  /** Move to `failed` (terminal) and record in the Dead Letter Queue. */
  private async fail(message: Message, reason: string, attempts?: number): Promise<DispatchOutcome> {
    await this.deps.outbox.updateState(message.id, {
      state: "failed",
      attempts: attempts ?? message.attempts,
      lastError: reason,
    });
    await this.deps.audit.append({
      messageId: message.id,
      eventType: "dead_lettered",
      actor: `provider:${message.provider}`,
      detail: { reason },
    });
    this.deps.telemetry.counter("outpost.dispatch.failed", 1, { provider: message.provider });
    return { kind: "failed", reason };
  }

  /** Re-queue without counting a failed attempt; short, jittered backoff. */
  private async requeueRateLimited(message: Message): Promise<DispatchOutcome> {
    const delay = 1_000 + Math.floor(this.deps.random() * 4_000); // 1–5s
    const nextAttemptAt = new Date(this.deps.clock.now().getTime() + delay);
    await this.deps.outbox.updateState(message.id, {
      state: "queued",
      nextAttemptAt,
    });
    this.deps.telemetry.counter("outpost.dispatch.rate_limited", 1, { provider: message.provider });
    return { kind: "rate_limited", nextAttemptAt };
  }

  private async checkRateLimits(provider: string, to: string): Promise<boolean> {
    const checks = [
      this.deps.rateLimiter.acquire({ kind: "global" }),
      this.deps.rateLimiter.acquire({ kind: "provider", key: provider }),
      this.deps.rateLimiter.acquire({ kind: "recipientDomain", key: extractDomain(to) }),
    ];
    const results = await Promise.all(checks);
    return results.some((ok) => ok === false);
  }

  /** List-Unsubscribe and other always-on headers (TDR §3.11). */
  private buildHeaders(): Record<string, string> {
    // Transactional messages still benefit from List-Unsubscribe hygiene.
    // Consumers can extend via provider config; kept minimal here.
    return {};
  }
}
