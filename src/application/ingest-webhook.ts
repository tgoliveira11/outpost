import type { CoreDeps } from "./context.js";
import type { RawWebhook } from "../ports/email-provider.js";
import type { WebhookEvent } from "../domain/webhook.js";
import type { AuditEventType } from "../domain/audit.js";
import { webhookToState } from "../domain/webhook.js";
import { canTransition, shouldSuppressOn } from "../domain/lifecycle.js";
import { WebhookVerificationError } from "../domain/errors.js";

export interface IngestWebhookResult {
  readonly accepted: boolean;
  readonly eventType: WebhookEvent["type"];
  readonly messageId: string | null;
  /** Why a verified event did not change state (e.g. unknown message). */
  readonly note?: string;
}

/**
 * IngestWebhook — the webhook worker's single responsibility (TDR §3.5).
 *
 *   1. Verify the signature via the named provider (NEVER trust unverified).
 *   2. Record the raw event for traceability/replay.
 *   3. Correlate to the outbox row by providerMessageId.
 *   4. Transition the message lifecycle (validated against the state machine).
 *   5. Feed the suppression list on hard bounce / complaint.
 *   6. Append an audit event.
 *
 * Webhook endpoints are NOT API-key authenticated — the provider calls them.
 * Trust is established purely by signature verification (TDR §5.2).
 */
export class IngestWebhook {
  constructor(private readonly deps: CoreDeps) {}

  async execute(providerName: string, raw: RawWebhook): Promise<IngestWebhookResult> {
    const { deps } = this;
    const provider = deps.providers.get(providerName);
    if (!provider) {
      throw new WebhookVerificationError(`Unknown provider "${providerName}"`);
    }

    return deps.telemetry.span("outpost.webhook.ingest", { provider: providerName }, async () => {
      // 1. Verify — throws WebhookVerificationError on bad signature.
      const event = await provider.verifyWebhook(raw);

      // 2. Record raw verified event.
      await deps.webhookEvents.record(event);
      deps.telemetry.counter("outpost.webhook.received", 1, {
        provider: providerName,
        type: event.type,
      });

      // 3. Correlate.
      const message = await deps.outbox.findByProviderMessageId(event.providerMessageId);
      if (!message) {
        return {
          accepted: true,
          eventType: event.type,
          messageId: null,
          note: "no matching message for providerMessageId",
        };
      }

      // 4. Transition (if the event maps to a state change).
      const target = webhookToState(event.type);
      if (target && canTransition(message.state, target)) {
        await deps.outbox.updateState(message.id, { state: target });
      }

      // 5. Suppress on hard bounce / complaint.
      if (target && shouldSuppressOn(target) && this.isSuppressable(event)) {
        await deps.suppressions.add({
          recipientHmac: message.recipientHmac,
          reason: target === "bounced" ? "hard_bounce" : "complaint",
          createdBy: `provider:${providerName}`,
          note: `webhook ${event.type}`,
        });
      }

      // 6. Audit.
      await deps.audit.append({
        messageId: message.id,
        eventType: this.auditType(event.type),
        actor: `provider:${providerName}`,
        detail: { type: event.type, occurredAt: event.occurredAt?.toISOString() ?? null },
      });

      return { accepted: true, eventType: event.type, messageId: message.id };
    });
  }

  /** A soft bounce must not suppress; only hard bounces and complaints do. */
  private isSuppressable(event: WebhookEvent): boolean {
    if (event.type === "complained") return true;
    if (event.type === "bounced") return event.isHardBounce !== false;
    return false;
  }

  private auditType(type: WebhookEvent["type"]): AuditEventType {
    switch (type) {
      case "delivered":
        return "webhook_delivered";
      case "bounced":
        return "webhook_bounced";
      case "complained":
        return "webhook_complained";
      case "opened":
        return "webhook_opened";
      case "failed":
        return "dispatch_failed";
    }
  }
}
