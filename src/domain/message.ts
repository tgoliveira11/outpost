import type { LifecycleState } from "./lifecycle.js";

/**
 * The Message entity — the heart of the outbox. Pure data + invariants.
 *
 * PII fields (`recipientSealed`, `bodySealed`) hold ciphertext when encryption
 * is enabled, plaintext otherwise. The plaintext recipient is NEVER stored in
 * a queryable column; suppression and idempotency-by-recipient match on
 * `recipientHmac` instead (TDR §5.4).
 */
export interface Message {
  readonly id: string;
  /** Caller-supplied or content-derived. Unique. Dedupes re-enqueues. */
  readonly idempotencyKey: string;
  state: LifecycleState;

  /** Deterministic keyed HMAC of the recipient address. Searchable. */
  readonly recipientHmac: string;
  /** Sealed (encrypted-at-rest) recipient address. */
  recipientSealed: Sealed;
  /** Sealed (encrypted-at-rest) rendered body (html and/or text). */
  bodySealed: Sealed;

  /** Clear, queryable. Subject line (already sanitized). */
  subject: string;
  readonly templateId: string | null;
  readonly templateVersion: number | null;

  /** Provider key selected for dispatch (e.g. "resend", "smtp"). */
  provider: string;

  /** Clear, queryable JSON the caller attaches (e.g. orderId). Never PII. */
  readonly metadata: Record<string, unknown>;

  /** Number of dispatch attempts so far. */
  attempts: number;
  /** Earliest time the send worker may (re-)attempt dispatch. */
  nextAttemptAt: Date;
  /** Optional future-send time (Phase 2 scheduling). */
  scheduledFor: Date | null;

  /** Provider's message id, populated once accepted. */
  providerMessageId: string | null;
  /** Human-readable reason for the latest terminal/error state. */
  lastError: string | null;

  readonly createdAt: Date;
  updatedAt: Date;
}

/**
 * An encrypted-at-rest payload. When encryption is disabled the `Encryptor`
 * returns a `Sealed` with `alg: "plain"` so the column shape never changes —
 * encryption can be turned on later without a migration of the row format.
 */
export interface Sealed {
  /** Algorithm tag, e.g. "plain" | "aes-256-gcm" | "hybrid-rsa-aes-256-gcm". */
  readonly alg: string;
  /** Base64 ciphertext (or plaintext when alg === "plain"). */
  readonly ciphertext: string;
  /** Base64 IV/nonce (AEAD schemes). */
  readonly iv?: string;
  /** Base64 auth tag (AEAD schemes). */
  readonly tag?: string;
  /** Base64 wrapped data key (hybrid schemes). */
  readonly wrappedKey?: string;
  /** Identifier of the key/key-version used, for rotation. */
  readonly keyId?: string;
}

/** The decrypted body handed to the provider at dispatch time. */
export interface MessageBody {
  html?: string;
  text?: string;
}

/**
 * The fully-resolved, decrypted message a provider adapter receives. The send
 * worker constructs this immediately before dispatch and never persists it.
 */
export interface DispatchableMessage {
  readonly id: string;
  readonly to: string;
  readonly subject: string;
  readonly body: MessageBody;
  readonly headers: Record<string, string>;
  readonly metadata: Record<string, unknown>;
}
