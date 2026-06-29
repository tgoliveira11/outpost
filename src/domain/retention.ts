/**
 * Retention policy domain types (TDR §3.9, §5.5).
 *
 * Operational data (the outbox payload) and audit data have independent TTLs.
 * The default action on purge is REDACTION, not deletion: the PII payload is
 * wiped while the audit row (metadata + HMAC) survives. This satisfies data
 * minimization without destroying the audit trail.
 */

export interface RetentionPolicy {
  /** Age (days) after which a terminal outbox row's PII may be purged. */
  readonly operationalTtlDays: number;
  /** Age (days) after which audit events may be deleted. */
  readonly auditTtlDays: number;
  /** When true (default) purge redacts PII; when false it deletes the row. */
  readonly redactOnPurge: boolean;
  /**
   * Grace window (hours) after a message reaches a terminal state during which
   * it is NOT purged, so late webhooks (delivery/bounce) can still arrive.
   * Purging earlier would break bounce/complaint handling.
   */
  readonly webhookWindowHours: number;
  /** Rows deleted/redacted per batch, to avoid long table locks. */
  readonly batchSize: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  operationalTtlDays: 30,
  auditTtlDays: 365,
  redactOnPurge: true,
  webhookWindowHours: 72,
  batchSize: 1000,
};

/**
 * The cutoff before which a terminal message becomes eligible for purge:
 * it must be older than the operational TTL AND past the webhook window.
 * Returns the latest (most conservative) of the two cutoffs.
 */
export function purgeCutoff(policy: RetentionPolicy, now: Date): Date {
  const ttlCutoff = now.getTime() - policy.operationalTtlDays * 24 * 60 * 60 * 1000;
  const windowCutoff = now.getTime() - policy.webhookWindowHours * 60 * 60 * 1000;
  return new Date(Math.min(ttlCutoff, windowCutoff));
}
