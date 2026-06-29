import { and, eq, or, lte, gte, lt, isNull, inArray, asc, desc, sql } from "drizzle-orm";
import type {
  OutboxRepository,
  SuppressionRepository,
  AuditRepository,
  ApiKeyRepository,
  WebhookEventRepository,
  NewMessage,
  MessageStatePatch,
  ListMessagesQuery,
  NewApiKey,
} from "../../ports/repositories.js";
import type { Message, Sealed } from "../../domain/message.js";
import type { SuppressionEntry, SuppressionReason } from "../../domain/suppression.js";
import type { ApiKey } from "../../domain/api-key.js";
import type { AuditEvent, NewAuditEvent } from "../../domain/audit.js";
import type { WebhookEvent } from "../../domain/webhook.js";
import type { OutpostDb } from "./db.js";
import { outbox, suppressions, auditEvents, apiKeys, webhookEvents } from "./schema.js";
import { rowToMessage, rowToSuppression, rowToApiKey, rowToAuditEvent } from "./mappers.js";

/** Tombstone written into PII columns on redaction (TDR §3.9). */
const REDACTED: Sealed = { alg: "redacted", ciphertext: "" };

export class DrizzleOutboxRepository implements OutboxRepository {
  constructor(private readonly db: OutpostDb) {}

  async insert(msg: NewMessage): Promise<Message> {
    const [row] = await this.db
      .insert(outbox)
      .values({
        idempotencyKey: msg.idempotencyKey,
        state: msg.state,
        recipientHmac: msg.recipientHmac,
        recipientSealed: msg.recipientSealed,
        bodySealed: msg.bodySealed,
        subject: msg.subject,
        templateId: msg.templateId,
        templateVersion: msg.templateVersion,
        provider: msg.provider,
        metadata: msg.metadata,
        scheduledFor: msg.scheduledFor,
        nextAttemptAt: msg.nextAttemptAt,
      })
      .returning();
    return rowToMessage(row!);
  }

  async findById(id: string): Promise<Message | null> {
    const [row] = await this.db.select().from(outbox).where(eq(outbox.id, id)).limit(1);
    return row ? rowToMessage(row) : null;
  }

  async findByIdempotencyKey(key: string): Promise<Message | null> {
    const [row] = await this.db
      .select()
      .from(outbox)
      .where(eq(outbox.idempotencyKey, key))
      .limit(1);
    return row ? rowToMessage(row) : null;
  }

  async findByProviderMessageId(providerMessageId: string): Promise<Message | null> {
    const [row] = await this.db
      .select()
      .from(outbox)
      .where(eq(outbox.providerMessageId, providerMessageId))
      .limit(1);
    return row ? rowToMessage(row) : null;
  }

  async list(query: ListMessagesQuery): Promise<Message[]> {
    const conds = [];
    if (query.state) conds.push(eq(outbox.state, query.state));
    if (query.recipientHmac) conds.push(eq(outbox.recipientHmac, query.recipientHmac));
    if (query.provider) conds.push(eq(outbox.provider, query.provider));
    if (query.createdAfter) conds.push(gte(outbox.createdAt, query.createdAfter));
    if (query.createdBefore) conds.push(lt(outbox.createdAt, query.createdBefore));

    const rows = await this.db
      .select()
      .from(outbox)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(outbox.createdAt))
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0);
    return rows.map(rowToMessage);
  }

  /**
   * Atomic claim using `FOR UPDATE SKIP LOCKED` so concurrent send workers
   * never grab the same row (TDR §6). Only `queued` rows whose `next_attempt_at`
   * has passed and whose `scheduled_for` (if any) has arrived are eligible.
   */
  async claimBatchForSending(limit: number, now: Date, reclaimBefore: Date): Promise<Message[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outbox)
        .where(
          or(
            and(
              eq(outbox.state, "queued"),
              lte(outbox.nextAttemptAt, now),
              or(isNull(outbox.scheduledFor), lte(outbox.scheduledFor, now)),
            ),
            // Reclaim abandoned `sending` rows past their lease.
            and(eq(outbox.state, "sending"), lt(outbox.updatedAt, reclaimBefore)),
          ),
        )
        .orderBy(asc(outbox.nextAttemptAt))
        .limit(limit)
        .for("update", { skipLocked: true });

      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      await tx
        .update(outbox)
        .set({ state: "sending", updatedAt: now })
        .where(inArray(outbox.id, ids));
      return rows.map((r) => rowToMessage({ ...r, state: "sending" }));
    });
  }

  async updateState(id: string, patch: MessageStatePatch): Promise<void> {
    const set: Partial<typeof outbox.$inferInsert> = { state: patch.state, updatedAt: new Date() };
    if (patch.attempts !== undefined) set.attempts = patch.attempts;
    if (patch.nextAttemptAt !== undefined) set.nextAttemptAt = patch.nextAttemptAt;
    if (patch.providerMessageId !== undefined) set.providerMessageId = patch.providerMessageId;
    if (patch.lastError !== undefined) set.lastError = patch.lastError;
    await this.db.update(outbox).set(set).where(eq(outbox.id, id));
  }

  async claimTerminalForPurge(olderThan: Date, limit: number): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(outbox)
      .where(
        and(
          inArray(outbox.state, ["delivered", "bounced", "complained", "failed", "suppressed"]),
          lt(outbox.updatedAt, olderThan),
          // Skip rows already redacted (idempotent purge).
          sql`${outbox.bodySealed}->>'alg' <> 'redacted'`,
        ),
      )
      .orderBy(asc(outbox.updatedAt))
      .limit(limit);
    return rows.map(rowToMessage);
  }

  async redactBatch(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db
      .update(outbox)
      .set({ recipientSealed: REDACTED, bodySealed: REDACTED, updatedAt: new Date() })
      .where(inArray(outbox.id, [...ids]))
      .returning({ id: outbox.id });
    return rows.length;
  }

  async deleteBatch(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db
      .delete(outbox)
      .where(inArray(outbox.id, [...ids]))
      .returning({ id: outbox.id });
    return rows.length;
  }
}

export class DrizzleSuppressionRepository implements SuppressionRepository {
  constructor(private readonly db: OutpostDb) {}

  async isSuppressed(recipientHmac: string): Promise<boolean> {
    const [row] = await this.db
      .select({ h: suppressions.recipientHmac })
      .from(suppressions)
      .where(eq(suppressions.recipientHmac, recipientHmac))
      .limit(1);
    return !!row;
  }

  async get(recipientHmac: string): Promise<SuppressionEntry | null> {
    const [row] = await this.db
      .select()
      .from(suppressions)
      .where(eq(suppressions.recipientHmac, recipientHmac))
      .limit(1);
    return row ? rowToSuppression(row) : null;
  }

  async add(entry: {
    recipientHmac: string;
    reason: SuppressionReason;
    createdBy: string;
    note?: string;
  }): Promise<SuppressionEntry> {
    const [row] = await this.db
      .insert(suppressions)
      .values({
        recipientHmac: entry.recipientHmac,
        reason: entry.reason,
        createdBy: entry.createdBy,
        note: entry.note ?? null,
      })
      // Idempotent: a repeat suppression keeps the original reason/timestamp.
      .onConflictDoNothing({ target: suppressions.recipientHmac })
      .returning();
    return row ? rowToSuppression(row) : (await this.get(entry.recipientHmac))!;
  }

  async remove(recipientHmac: string): Promise<boolean> {
    const rows = await this.db
      .delete(suppressions)
      .where(eq(suppressions.recipientHmac, recipientHmac))
      .returning({ h: suppressions.recipientHmac });
    return rows.length > 0;
  }

  async list(limit: number, offset: number): Promise<SuppressionEntry[]> {
    const rows = await this.db
      .select()
      .from(suppressions)
      .orderBy(desc(suppressions.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.map(rowToSuppression);
  }
}

export class DrizzleAuditRepository implements AuditRepository {
  constructor(private readonly db: OutpostDb) {}

  async append(event: NewAuditEvent): Promise<AuditEvent> {
    const [row] = await this.db
      .insert(auditEvents)
      .values({
        messageId: event.messageId,
        eventType: event.eventType,
        actor: event.actor,
        detail: event.detail ?? null,
      })
      .returning();
    return rowToAuditEvent(row!);
  }

  async listForMessage(messageId: string): Promise<AuditEvent[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.messageId, messageId))
      .orderBy(asc(auditEvents.at));
    return rows.map(rowToAuditEvent);
  }

  async purgeOlderThan(cutoff: Date, batchSize: number): Promise<number> {
    let total = 0;
    for (;;) {
      // Delete in batches via a subselect of ids to keep locks short.
      const ids = await this.db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(lt(auditEvents.at, cutoff))
        .limit(batchSize);
      if (ids.length === 0) break;
      await this.db.delete(auditEvents).where(
        inArray(
          auditEvents.id,
          ids.map((r) => r.id),
        ),
      );
      total += ids.length;
      if (ids.length < batchSize) break;
    }
    return total;
  }
}

export class DrizzleApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly db: OutpostDb) {}

  async insert(key: NewApiKey): Promise<ApiKey> {
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        label: key.label,
        keyHash: key.keyHash,
        scopes: [...key.scopes],
        expiresAt: key.expiresAt,
      })
      .returning();
    return rowToApiKey(row!);
  }

  async findByHash(keyHash: string): Promise<ApiKey | null> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);
    return row ? rowToApiKey(row) : null;
  }

  async findById(id: string): Promise<ApiKey | null> {
    const [row] = await this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    return row ? rowToApiKey(row) : null;
  }

  async list(): Promise<ApiKey[]> {
    const rows = await this.db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
    return rows.map(rowToApiKey);
  }

  async revoke(id: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: at })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }

  async touchLastUsed(id: string, at: Date): Promise<void> {
    await this.db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id));
  }
}

export class DrizzleWebhookEventRepository implements WebhookEventRepository {
  constructor(private readonly db: OutpostDb) {}

  async record(event: WebhookEvent): Promise<void> {
    await this.db.insert(webhookEvents).values({
      provider: event.provider,
      type: event.type,
      providerMessageId: event.providerMessageId,
      recipient: event.recipient ?? null,
      isHardBounce: event.isHardBounce ?? null,
      occurredAt: event.occurredAt ?? null,
      raw: event.raw,
    });
  }
}
