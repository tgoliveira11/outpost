/**
 * Suppression list domain types.
 *
 * The suppression list is the reputation guardrail: any address on it is never
 * dispatched to. Entries are keyed by the recipient HMAC (not plaintext) so the
 * list keeps working when recipients are encrypted at rest (TDR §3.6, §5.4).
 */

export const SUPPRESSION_REASONS = [
  "hard_bounce",
  "complaint",
  "unsubscribe",
  "invalid",
  "manual",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface SuppressionEntry {
  /** Keyed HMAC of the suppressed address. Unique. */
  readonly recipientHmac: string;
  readonly reason: SuppressionReason;
  /** api key id, provider name, or "system". For the audit trail. */
  readonly createdBy: string;
  readonly createdAt: Date;
  /** Optional free-text note (e.g. the provider bounce message). */
  readonly note?: string;
}
