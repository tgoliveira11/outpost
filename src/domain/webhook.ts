import type { LifecycleState } from "./lifecycle.js";

/**
 * Normalized webhook event (TDR §3.5).
 *
 * Each provider has its own webhook payload shape and signature scheme. The
 * provider adapter's `verifyWebhook` verifies the signature and maps the native
 * payload onto this uniform type, so the `IngestWebhook` use case never has to
 * know about provider specifics.
 */

export type WebhookEventType =
  | "delivered"
  | "bounced"
  | "complained"
  | "opened"
  | "failed";

export interface WebhookEvent {
  readonly provider: string;
  readonly type: WebhookEventType;
  /** Provider's message id — used to correlate back to the outbox row. */
  readonly providerMessageId: string;
  /** Recipient address as the provider reports it (used to derive the HMAC). */
  readonly recipient?: string;
  /** True for hard bounces; soft bounces should not suppress. */
  readonly isHardBounce?: boolean;
  /** Provider's own timestamp for the event, if supplied. */
  readonly occurredAt?: Date;
  /** Raw provider payload, retained for traceability/replay. */
  readonly raw: unknown;
}

/** Maps a webhook event type to the lifecycle state it drives the message to. */
export function webhookToState(type: WebhookEventType): LifecycleState | null {
  switch (type) {
    case "delivered":
      return "delivered";
    case "bounced":
      return "bounced";
    case "complained":
      return "complained";
    case "failed":
      return "failed";
    case "opened":
      return null; // tracking-only; does not change lifecycle state
  }
}
