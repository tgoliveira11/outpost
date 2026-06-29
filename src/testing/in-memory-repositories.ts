import { randomUUID } from "node:crypto";
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
} from "../ports/repositories.js";
import type { Message, Sealed } from "../domain/message.js";
import type { SuppressionEntry, SuppressionReason } from "../domain/suppression.js";
import type { ApiKey } from "../domain/api-key.js";
import type { AuditEvent, NewAuditEvent } from "../domain/audit.js";
import type { WebhookEvent } from "../domain/webhook.js";
import { TERMINAL_STATES, type LifecycleState } from "../domain/lifecycle.js";

const REDACTED: Sealed = { alg: "redacted", ciphertext: "" };

/**
 * In-memory repositories mirroring the Drizzle adapter's semantics, for tests,
 * CI, and local prototyping with NO database. They are NOT concurrency-safe
 * across processes and hold everything in RAM — never use them in production.
 */
export class InMemoryOutboxRepository implements OutboxRepository {
  readonly messages = new Map<string, Message>();

  /** Optional injected clock so retention/lifecycle is deterministic in tests. */
  constructor(private readonly clock: () => Date = () => new Date()) {}

  async insert(msg: NewMessage): Promise<Message> {
    const now = this.clock();
    const message: Message = {
      id: randomUUID(),
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
      attempts: 0,
      nextAttemptAt: msg.nextAttemptAt,
      scheduledFor: msg.scheduledFor,
      providerMessageId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.messages.set(message.id, message);
    return { ...message };
  }

  async findById(id: string): Promise<Message | null> {
    const m = this.messages.get(id);
    return m ? { ...m } : null;
  }

  async findByIdempotencyKey(key: string): Promise<Message | null> {
    for (const m of this.messages.values()) if (m.idempotencyKey === key) return { ...m };
    return null;
  }

  async findByProviderMessageId(id: string): Promise<Message | null> {
    for (const m of this.messages.values()) if (m.providerMessageId === id) return { ...m };
    return null;
  }

  async list(query: ListMessagesQuery): Promise<Message[]> {
    let all = [...this.messages.values()];
    if (query.state) all = all.filter((m) => m.state === query.state);
    if (query.recipientHmac) all = all.filter((m) => m.recipientHmac === query.recipientHmac);
    if (query.provider) all = all.filter((m) => m.provider === query.provider);
    if (query.createdAfter) all = all.filter((m) => m.createdAt >= query.createdAfter!);
    if (query.createdBefore) all = all.filter((m) => m.createdAt < query.createdBefore!);
    all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const offset = query.offset ?? 0;
    return all.slice(offset, offset + (query.limit ?? 50)).map((m) => ({ ...m }));
  }

  async countByState(): Promise<Record<LifecycleState, number>> {
    const counts = {
      queued: 0,
      sending: 0,
      sent: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      failed: 0,
      suppressed: 0,
    } satisfies Record<LifecycleState, number>;
    for (const m of this.messages.values()) {
      counts[m.state]++;
    }
    return counts;
  }

  async claimBatchForSending(limit: number, now: Date, reclaimBefore: Date): Promise<Message[]> {
    const claimed: Message[] = [];
    const eligible = [...this.messages.values()]
      .filter(
        (m) =>
          (m.state === "queued" &&
            m.nextAttemptAt <= now &&
            (m.scheduledFor === null || m.scheduledFor <= now)) ||
          (m.state === "sending" && m.updatedAt < reclaimBefore),
      )
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);
    for (const m of eligible) {
      m.state = "sending";
      m.updatedAt = now;
      claimed.push({ ...m });
    }
    return claimed;
  }

  async updateState(id: string, patch: MessageStatePatch): Promise<void> {
    const m = this.messages.get(id);
    if (!m) return;
    m.state = patch.state;
    if (patch.attempts !== undefined) m.attempts = patch.attempts;
    if (patch.nextAttemptAt !== undefined) m.nextAttemptAt = patch.nextAttemptAt;
    if (patch.providerMessageId !== undefined) m.providerMessageId = patch.providerMessageId;
    if (patch.lastError !== undefined) m.lastError = patch.lastError;
    m.updatedAt = this.clock();
  }

  async claimTerminalForPurge(olderThan: Date, limit: number): Promise<Message[]> {
    const terminal = new Set<string>(TERMINAL_STATES);
    return [...this.messages.values()]
      .filter(
        (m) => terminal.has(m.state) && m.updatedAt < olderThan && m.bodySealed.alg !== "redacted",
      )
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit)
      .map((m) => ({ ...m }));
  }

  async redactBatch(ids: readonly string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const m = this.messages.get(id);
      if (m) {
        m.recipientSealed = REDACTED;
        m.bodySealed = REDACTED;
        m.updatedAt = this.clock();
        n++;
      }
    }
    return n;
  }

  async deleteBatch(ids: readonly string[]): Promise<number> {
    let n = 0;
    for (const id of ids) if (this.messages.delete(id)) n++;
    return n;
  }
}

export class InMemorySuppressionRepository implements SuppressionRepository {
  readonly entries = new Map<string, SuppressionEntry>();

  async isSuppressed(recipientHmac: string): Promise<boolean> {
    return this.entries.has(recipientHmac);
  }
  async get(recipientHmac: string): Promise<SuppressionEntry | null> {
    return this.entries.get(recipientHmac) ?? null;
  }
  async add(entry: {
    recipientHmac: string;
    reason: SuppressionReason;
    createdBy: string;
    note?: string;
  }): Promise<SuppressionEntry> {
    const existing = this.entries.get(entry.recipientHmac);
    if (existing) return existing;
    const created: SuppressionEntry = { ...entry, createdAt: new Date() };
    this.entries.set(entry.recipientHmac, created);
    return created;
  }
  async remove(recipientHmac: string): Promise<boolean> {
    return this.entries.delete(recipientHmac);
  }
  async list(limit: number, offset: number): Promise<SuppressionEntry[]> {
    return [...this.entries.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit);
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  readonly events: AuditEvent[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async append(event: NewAuditEvent): Promise<AuditEvent> {
    const created: AuditEvent = {
      id: randomUUID(),
      messageId: event.messageId,
      eventType: event.eventType,
      actor: event.actor,
      detail: event.detail ?? null,
      at: this.clock(),
    };
    this.events.push(created);
    return created;
  }
  async listForMessage(messageId: string): Promise<AuditEvent[]> {
    return this.events.filter((e) => e.messageId === messageId);
  }
  async purgeOlderThan(cutoff: Date, _batchSize: number): Promise<number> {
    const before = this.events.length;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.at < cutoff) this.events.splice(i, 1);
    }
    return before - this.events.length;
  }
}

export class InMemoryApiKeyRepository implements ApiKeyRepository {
  readonly keys = new Map<string, ApiKey>();

  async insert(key: NewApiKey): Promise<ApiKey> {
    const created: ApiKey = {
      id: randomUUID(),
      label: key.label,
      keyHash: key.keyHash,
      scopes: key.scopes,
      expiresAt: key.expiresAt,
      revokedAt: null,
      createdAt: new Date(),
      lastUsedAt: null,
    };
    this.keys.set(created.id, created);
    return created;
  }
  async findByHash(keyHash: string): Promise<ApiKey | null> {
    for (const k of this.keys.values()) if (k.keyHash === keyHash) return { ...k };
    return null;
  }
  async findById(id: string): Promise<ApiKey | null> {
    const k = this.keys.get(id);
    return k ? { ...k } : null;
  }
  async list(): Promise<ApiKey[]> {
    return [...this.keys.values()];
  }
  async revoke(id: string, at: Date): Promise<boolean> {
    const k = this.keys.get(id);
    if (!k || k.revokedAt) return false;
    k.revokedAt = at;
    return true;
  }
  async touchLastUsed(id: string, at: Date): Promise<void> {
    const k = this.keys.get(id);
    if (k) k.lastUsedAt = at;
  }
}

export class InMemoryWebhookEventRepository implements WebhookEventRepository {
  readonly events: WebhookEvent[] = [];
  async record(event: WebhookEvent): Promise<void> {
    this.events.push(event);
  }
}
