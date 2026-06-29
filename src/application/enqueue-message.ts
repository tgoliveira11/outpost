import type { CoreDeps } from "./context.js";
import type { Message, MessageBody } from "../domain/message.js";
import { ValidationError } from "../domain/errors.js";
import {
  sanitizeSubject,
  sanitizeRecipient,
  assertBodyWithinLimits,
  stripDangerousHtml,
} from "./pipeline/sanitize.js";
import { validateSyntax } from "./pipeline/domain-validation.js";

/**
 * Input accepted by `outpost.send(...)` and `POST /messages` (TDR §4.3).
 * Either `template` OR (`subject` + `html`/`text`) must be supplied.
 */
export interface EnqueueInput {
  /** Required. Dedupes re-enqueues (TDR §3.1, decision #3). */
  readonly idempotencyKey: string;
  readonly to: string;
  readonly template?: { id: string; version?: number; vars: Record<string, unknown> };
  readonly subject?: string;
  readonly html?: string;
  readonly text?: string;
  /** Override the default provider for this message. */
  readonly provider?: string;
  /** Clear, queryable metadata. Never put PII here. */
  readonly metadata?: Record<string, unknown>;
  /** Phase 2 scheduling; if set, the worker won't claim it until then. */
  readonly scheduledFor?: Date;
}

export interface EnqueueResult {
  readonly id: string;
  readonly state: Message["state"];
  readonly idempotencyKey: string;
  /** True when an existing message was returned (idempotent replay). */
  readonly deduplicated: boolean;
}

/**
 * EnqueueMessage — persist-before-dispatch ingestion (TDR §3.1, decision #1).
 *
 * Order of operations is load-bearing:
 *   1. Validate + sanitize (reject bad input synchronously, before any write).
 *   2. Idempotency guard — return the existing message if the key is known.
 *   3. Suppression check — suppressed recipients are recorded, never dispatched.
 *   4. Seal PII (recipient + body) with the WRITE-side encryptor.
 *   5. Insert as `queued`. The row exists before anything tries to send it.
 *   6. Append an `enqueued` audit event.
 *
 * The send worker (a separate process) picks it up later by polling — the
 * ingestion path NEVER publishes to a queue, avoiding the dual-write hazard
 * (decision #2).
 */
export class EnqueueMessage {
  constructor(private readonly deps: CoreDeps) {}

  async execute(input: EnqueueInput, actor: string): Promise<EnqueueResult> {
    const { deps } = this;
    return deps.telemetry.span("outpost.enqueue", { idempotencyKey: input.idempotencyKey }, async () => {
      if (!input.idempotencyKey || input.idempotencyKey.trim() === "") {
        throw new ValidationError("idempotencyKey is required");
      }

      // 1. Validate + sanitize ----------------------------------------------
      const to = sanitizeRecipient(input.to, deps.config.sanitize);
      validateSyntax(to); // syntax always; MX check happens in the send worker
      const { subject, body } = await this.resolveContent(input);
      const cleanSubject = sanitizeSubject(subject, deps.config.sanitize);
      const cleanBody = this.sanitizeBody(body);
      assertBodyWithinLimits(cleanBody, deps.config.sanitize);

      const recipientHmac = deps.recipientHasher.hash(to);
      const provider = input.provider ?? deps.defaultProvider;

      // 2. Idempotency guard ------------------------------------------------
      const existing = await deps.outbox.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        deps.telemetry.counter("outpost.enqueue.deduplicated", 1);
        return {
          id: existing.id,
          state: existing.state,
          idempotencyKey: existing.idempotencyKey,
          deduplicated: true,
        };
      }

      // 3. Suppression check ------------------------------------------------
      const suppressed = await deps.suppressions.isSuppressed(recipientHmac);

      // 4. Seal PII (write-side encryptor) ----------------------------------
      const [recipientSealed, bodySealed] = await Promise.all([
        deps.sealEncryptor.seal(to),
        deps.sealEncryptor.seal(JSON.stringify(cleanBody)),
      ]);

      const now = deps.clock.now();

      // 5. Insert -----------------------------------------------------------
      const message = await deps.outbox.insert({
        idempotencyKey: input.idempotencyKey,
        recipientHmac,
        recipientSealed,
        bodySealed,
        subject: cleanSubject,
        templateId: input.template?.id ?? null,
        templateVersion: input.template?.version ?? null,
        provider,
        metadata: input.metadata ?? {},
        state: suppressed ? "suppressed" : "queued",
        scheduledFor: input.scheduledFor ?? null,
        nextAttemptAt: input.scheduledFor ?? now,
      });

      // 6. Audit ------------------------------------------------------------
      await deps.audit.append({
        messageId: message.id,
        eventType: suppressed ? "suppressed" : "enqueued",
        actor,
        detail: suppressed ? { reason: "recipient_on_suppression_list" } : { provider },
      });
      deps.telemetry.counter(suppressed ? "outpost.enqueue.suppressed" : "outpost.enqueue.queued", 1);

      return {
        id: message.id,
        state: message.state,
        idempotencyKey: message.idempotencyKey,
        deduplicated: false,
      };
    });
  }

  /** Resolve template or raw content into subject + body. */
  private async resolveContent(input: EnqueueInput): Promise<{ subject: string; body: MessageBody }> {
    if (input.template) {
      if (!this.deps.templates) {
        throw new ValidationError("A template was supplied but no TemplateRenderer is configured");
      }
      const rendered = await this.deps.templates.render(input.template);
      // A caller-supplied subject overrides the template's, if present.
      return { subject: input.subject ?? rendered.subject, body: rendered.body };
    }
    if (input.subject === undefined) {
      throw new ValidationError("Either `template` or `subject` must be provided");
    }
    return { subject: input.subject, body: { html: input.html, text: input.text } };
  }

  /** Apply the configured strong sanitizer (or built-in fallback) to HTML. */
  private sanitizeBody(body: MessageBody): MessageBody {
    if (body.html === undefined) return body;
    const clean = this.deps.sanitizeHtml ? this.deps.sanitizeHtml(body.html) : stripDangerousHtml(body.html);
    return { ...body, html: clean };
  }
}
