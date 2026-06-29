import type { DispatchableMessage } from "../domain/message.js";
import type { WebhookEvent } from "../domain/webhook.js";

/**
 * Receipt returned by a provider when it accepts a message for delivery.
 * `accepted` means the provider took responsibility — NOT that it was
 * delivered. Delivery is confirmed asynchronously via `verifyWebhook`.
 */
export interface ProviderReceipt {
  readonly providerMessageId: string;
  /** Provider-specific accepted timestamp, if returned. */
  readonly acceptedAt?: Date;
}

/**
 * Raw inbound webhook request as received by the HTTP layer, handed to the
 * provider adapter for signature verification + normalization.
 */
export interface RawWebhook {
  readonly headers: Record<string, string | string[] | undefined>;
  /** The exact raw request body bytes/string — required for HMAC signatures. */
  readonly rawBody: string;
}

/**
 * The single transport port (TDR §3.8, §6). Every provider — SMTP/Mailpit,
 * Resend, SES, the in-memory fake — implements exactly this. Adding a provider
 * means adding an implementation, never editing the core (Open/Closed).
 *
 * Implementations MUST throw `ProviderError` (transient | permanent) on
 * failure so the dispatch pipeline can decide retry vs. dead-letter without
 * inspecting provider-specific error shapes.
 */
export interface EmailProvider {
  /** Stable key used in config and persisted on the message (e.g. "resend"). */
  readonly name: string;

  /** Hand a fully-resolved, decrypted message to the provider. */
  send(msg: DispatchableMessage): Promise<ProviderReceipt>;

  /**
   * Verify a raw inbound webhook and normalize it. Throws
   * `WebhookVerificationError` if the signature is invalid. Returning a
   * uniform `WebhookEvent` is what enables provider fallback and one ingestion
   * path for all providers.
   */
  verifyWebhook(req: RawWebhook): Promise<WebhookEvent>;
}
