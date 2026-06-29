import type { Message, Sealed } from "../domain/message.js";
import type { LifecycleState } from "../domain/lifecycle.js";
import type { SuppressionEntry, SuppressionReason } from "../domain/suppression.js";
import type { ApiKey, ApiScope } from "../domain/api-key.js";
import type { AuditEvent, NewAuditEvent } from "../domain/audit.js";
import type { WebhookEvent } from "../domain/webhook.js";

/**
 * Persistence ports (TDR §6). Use cases depend on these interfaces; concrete
 * Drizzle/Postgres implementations are injected at the edge (Dependency
 * Inversion). Ports are deliberately narrow (Interface Segregation): a
 * send-only consumer never has to depend on suppression-management methods.
 */

/** Fields required to create a new outbox row. id/timestamps assigned by impl. */
export interface NewMessage {
  readonly idempotencyKey: string;
  readonly recipientHmac: string;
  readonly recipientSealed: Sealed;
  readonly bodySealed: Sealed;
  readonly subject: string;
  readonly templateId: string | null;
  readonly templateVersion: number | null;
  readonly provider: string;
  readonly metadata: Record<string, unknown>;
  readonly state: LifecycleState;
  readonly scheduledFor: Date | null;
  readonly nextAttemptAt: Date;
}

export interface ListMessagesQuery {
  readonly state?: LifecycleState;
  readonly recipientHmac?: string;
  readonly provider?: string;
  readonly createdAfter?: Date;
  readonly createdBefore?: Date;
  readonly limit?: number;
  readonly offset?: number;
}

/** Patch applied during a state transition; impl bumps `updatedAt`. */
export interface MessageStatePatch {
  readonly state: LifecycleState;
  readonly attempts?: number;
  readonly nextAttemptAt?: Date;
  readonly providerMessageId?: string | null;
  readonly lastError?: string | null;
}

export interface OutboxRepository {
  insert(msg: NewMessage): Promise<Message>;
  findById(id: string): Promise<Message | null>;
  findByIdempotencyKey(key: string): Promise<Message | null>;
  /** Correlate an inbound webhook back to its outbox row. */
  findByProviderMessageId(providerMessageId: string): Promise<Message | null>;
  list(query: ListMessagesQuery): Promise<Message[]>;

  /** Count rows grouped by lifecycle state (admin observability). */
  countByState(): Promise<Record<LifecycleState, number>>;

  /**
   * Atomically claim a batch of ready messages for sending and mark them
   * `sending`, so concurrent send workers never grab the same row. Postgres
   * impl uses `FOR UPDATE SKIP LOCKED`.
   *
   * Eligible rows are EITHER:
   *   - `queued` with `next_attempt_at <= now` and no future `scheduled_for`, OR
   *   - `sending` last updated before `reclaimBefore` — i.e. abandoned by a
   *     worker that crashed mid-dispatch (lease expiry). This makes dispatch
   *     crash-safe: a stuck row is retried rather than lost forever.
   */
  claimBatchForSending(limit: number, now: Date, reclaimBefore: Date): Promise<Message[]>;

  /** Apply a validated state transition + persist the patch. */
  updateState(id: string, patch: MessageStatePatch): Promise<void>;

  /** Terminal rows older than `olderThan` and past their webhook window. */
  claimTerminalForPurge(olderThan: Date, limit: number): Promise<Message[]>;
  /** Wipe PII columns (keep the row + metadata + HMAC). Returns rows redacted. */
  redactBatch(ids: readonly string[]): Promise<number>;
  /** Hard-delete rows entirely. Returns rows deleted. */
  deleteBatch(ids: readonly string[]): Promise<number>;
}

export interface SuppressionRepository {
  isSuppressed(recipientHmac: string): Promise<boolean>;
  get(recipientHmac: string): Promise<SuppressionEntry | null>;
  add(entry: {
    recipientHmac: string;
    reason: SuppressionReason;
    createdBy: string;
    note?: string;
  }): Promise<SuppressionEntry>;
  remove(recipientHmac: string): Promise<boolean>;
  list(limit: number, offset: number): Promise<SuppressionEntry[]>;
}

export interface AuditRepository {
  append(event: NewAuditEvent): Promise<AuditEvent>;
  listForMessage(messageId: string): Promise<AuditEvent[]>;
  /** Delete audit rows older than the cutoff, in batches. Returns count. */
  purgeOlderThan(cutoff: Date, batchSize: number): Promise<number>;
}

export interface NewApiKey {
  readonly label: string;
  readonly keyHash: string;
  readonly scopes: readonly ApiScope[];
  readonly expiresAt: Date | null;
}

export interface ApiKeyRepository {
  insert(key: NewApiKey): Promise<ApiKey>;
  findByHash(keyHash: string): Promise<ApiKey | null>;
  findById(id: string): Promise<ApiKey | null>;
  list(): Promise<ApiKey[]>;
  revoke(id: string, at: Date): Promise<boolean>;
  touchLastUsed(id: string, at: Date): Promise<void>;
}

/** Raw verified webhook events, retained for traceability/replay (TDR §7). */
export interface WebhookEventRepository {
  record(event: WebhookEvent): Promise<void>;
}
