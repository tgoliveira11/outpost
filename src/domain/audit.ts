/**
 * Append-only audit trail types (TDR §3, §8).
 *
 * The audit trail is the durable "who did what when" record. It is append-only:
 * use cases write an event on every meaningful state change. It outlives the
 * operational outbox row (longer TTL) and survives PII redaction.
 */

export type AuditEventType =
  | "enqueued"
  | "dispatch_started"
  | "dispatch_accepted"
  | "dispatch_failed"
  | "retry_scheduled"
  | "dead_lettered"
  | "replayed"
  | "webhook_delivered"
  | "webhook_bounced"
  | "webhook_complained"
  | "webhook_opened"
  | "suppressed"
  | "unsuppressed"
  | "redacted"
  | "purged"
  | "key_created"
  | "key_revoked";

export interface AuditEvent {
  readonly id: string;
  /** Null for events not tied to a single message (e.g. key_created). */
  readonly messageId: string | null;
  readonly eventType: AuditEventType;
  /** api key id, provider name, or "system". */
  readonly actor: string;
  /** Redactable provider response / detail blob. Never raw PII bodies. */
  readonly detail: Record<string, unknown> | null;
  readonly at: Date;
}

/** Shape a use case passes to the repository; id + timestamp are assigned there. */
export interface NewAuditEvent {
  readonly messageId: string | null;
  readonly eventType: AuditEventType;
  readonly actor: string;
  readonly detail?: Record<string, unknown> | null;
}
