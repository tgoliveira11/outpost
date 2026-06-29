import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./helpers/pglite-db.js";
import type { OutpostDb } from "../src/adapters/drizzle/db.js";
import {
  DrizzleOutboxRepository,
  DrizzleSuppressionRepository,
  DrizzleAuditRepository,
  DrizzleApiKeyRepository,
  DrizzleWebhookEventRepository,
} from "../src/adapters/drizzle/repositories.js";
import type { Sealed } from "../src/domain/message.js";

const sealed = (s: string): Sealed => ({ alg: "plain", ciphertext: Buffer.from(s).toString("base64") });

function newMessage(overrides: Partial<Parameters<DrizzleOutboxRepository["insert"]>[0]> = {}) {
  return {
    idempotencyKey: `k-${Math.random().toString(36).slice(2)}`,
    recipientHmac: "hmac-1",
    recipientSealed: sealed("a@example.com"),
    bodySealed: sealed("body"),
    subject: "Subject",
    templateId: null,
    templateVersion: null,
    provider: "fake",
    metadata: { orderId: "1" },
    state: "queued" as const,
    scheduledFor: null,
    nextAttemptAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

let db: OutpostDb;
let close: () => Promise<void>;
let outbox: DrizzleOutboxRepository;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  outbox = new DrizzleOutboxRepository(db);
});
afterEach(async () => {
  await close();
});

describe("DrizzleOutboxRepository", () => {
  it("inserts and reads back by id / idempotency key / provider message id", async () => {
    const m = await outbox.insert(newMessage({ idempotencyKey: "ik-1" }));
    expect(m.id).toBeTruthy();
    expect(m.metadata).toEqual({ orderId: "1" });
    expect((await outbox.findById(m.id))?.idempotencyKey).toBe("ik-1");
    expect((await outbox.findByIdempotencyKey("ik-1"))?.id).toBe(m.id);
    expect(await outbox.findById("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await outbox.findByIdempotencyKey("missing")).toBeNull();

    await outbox.updateState(m.id, { state: "sent", providerMessageId: "pm-1" });
    expect((await outbox.findByProviderMessageId("pm-1"))?.id).toBe(m.id);
    expect(await outbox.findByProviderMessageId("nope")).toBeNull();
  });

  it("lists with filters", async () => {
    await outbox.insert(newMessage({ provider: "resend", recipientHmac: "h-a" }));
    const b = await outbox.insert(newMessage({ provider: "smtp", recipientHmac: "h-b" }));
    await outbox.updateState(b.id, { state: "failed" });

    expect((await outbox.list({ provider: "resend" })).length).toBe(1);
    expect((await outbox.list({ recipientHmac: "h-b" }))[0]!.id).toBe(b.id);
    expect((await outbox.list({ state: "failed" })).length).toBe(1);
    expect((await outbox.list({ limit: 1 })).length).toBe(1);
    expect((await outbox.list({ createdAfter: new Date("2030-01-01") })).length).toBe(0);
    expect((await outbox.list({ createdBefore: new Date("2030-01-01") })).length).toBe(2);
  });

  it("claims queued rows atomically and skips future-scheduled ones", async () => {
    const now = new Date("2026-02-01T00:00:00Z");
    await outbox.insert(newMessage({ idempotencyKey: "ready" }));
    await outbox.insert(
      newMessage({ idempotencyKey: "future", scheduledFor: new Date("2030-01-01"), nextAttemptAt: new Date("2030-01-01") }),
    );
    const claimed = await outbox.claimBatchForSending(10, now, new Date("2026-01-01T00:00:00Z"));
    expect(claimed.length).toBe(1);
    expect(claimed[0]!.state).toBe("sending");
    // Second claim returns nothing new (already sending, within lease).
    expect((await outbox.claimBatchForSending(10, now, new Date("2026-01-01T00:00:00Z"))).length).toBe(0);
  });

  it("reclaims a stale `sending` row past the lease", async () => {
    const now = new Date("2026-02-01T00:00:00Z");
    const m = await outbox.insert(newMessage());
    await outbox.updateState(m.id, { state: "sending" }); // updatedAt ≈ real now
    // reclaimBefore far in the future → the row's updatedAt is before it → reclaimed.
    const reclaimBefore = new Date(Date.now() + 60_000);
    const claimed = await outbox.claimBatchForSending(10, now, reclaimBefore);
    expect(claimed.map((c) => c.id)).toContain(m.id);
  });

  it("applies every field of a state patch", async () => {
    const m = await outbox.insert(newMessage());
    await outbox.updateState(m.id, {
      state: "queued",
      attempts: 3,
      nextAttemptAt: new Date("2027-01-01T00:00:00Z"),
      providerMessageId: "pm-9",
      lastError: "boom",
    });
    const fresh = (await outbox.findById(m.id))!;
    expect(fresh.attempts).toBe(3);
    expect(fresh.providerMessageId).toBe("pm-9");
    expect(fresh.lastError).toBe("boom");
    expect(fresh.nextAttemptAt.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("claims, redacts, and deletes terminal rows for purge", async () => {
    const m1 = await outbox.insert(newMessage());
    const m2 = await outbox.insert(newMessage());
    await outbox.updateState(m1.id, { state: "delivered" });
    await outbox.updateState(m2.id, { state: "bounced" });

    const future = new Date(Date.now() + 60_000);
    const terminal = await outbox.claimTerminalForPurge(future, 10);
    expect(terminal.length).toBe(2);

    expect(await outbox.redactBatch([m1.id])).toBe(1);
    expect((await outbox.findById(m1.id))!.bodySealed.alg).toBe("redacted");
    // Redacted rows are no longer eligible.
    expect((await outbox.claimTerminalForPurge(future, 10)).length).toBe(1);

    expect(await outbox.deleteBatch([m2.id])).toBe(1);
    expect(await outbox.findById(m2.id)).toBeNull();
    expect(await outbox.redactBatch([])).toBe(0);
    expect(await outbox.deleteBatch([])).toBe(0);
  });
});

describe("DrizzleSuppressionRepository", () => {
  it("adds idempotently, checks, gets, lists, removes", async () => {
    const repo = new DrizzleSuppressionRepository(db);
    expect(await repo.isSuppressed("h1")).toBe(false);
    const e = await repo.add({ recipientHmac: "h1", reason: "hard_bounce", createdBy: "system", note: "n" });
    expect(e.reason).toBe("hard_bounce");
    expect(e.note).toBe("n");
    // Repeat is idempotent — keeps the original reason.
    const again = await repo.add({ recipientHmac: "h1", reason: "manual", createdBy: "x" });
    expect(again.reason).toBe("hard_bounce");
    expect(await repo.isSuppressed("h1")).toBe(true);
    expect((await repo.get("h1"))?.reason).toBe("hard_bounce");
    expect(await repo.get("missing")).toBeNull();
    expect((await repo.list(10, 0)).length).toBe(1);
    expect(await repo.remove("h1")).toBe(true);
    expect(await repo.remove("h1")).toBe(false);
  });
});

describe("DrizzleAuditRepository", () => {
  it("appends, lists for a message, and purges in batches", async () => {
    const repo = new DrizzleAuditRepository(db);
    const mid = "11111111-1111-1111-1111-111111111111";
    await repo.append({ messageId: mid, eventType: "enqueued", actor: "system", detail: { a: 1 } });
    await repo.append({ messageId: mid, eventType: "dispatch_accepted", actor: "system" });
    await repo.append({ messageId: null, eventType: "key_created", actor: "admin" });

    const events = await repo.listForMessage(mid);
    expect(events.length).toBe(2);
    expect(events[0]!.detail).toEqual({ a: 1 });

    const purged = await repo.purgeOlderThan(new Date(Date.now() + 60_000), 1);
    expect(purged).toBe(3);
    expect((await repo.listForMessage(mid)).length).toBe(0);
  });
});

describe("DrizzleApiKeyRepository", () => {
  it("inserts, finds, lists, revokes, touches", async () => {
    const repo = new DrizzleApiKeyRepository(db);
    const k = await repo.insert({ label: "ci", keyHash: "hash-1", scopes: ["messages:send"], expiresAt: null });
    expect(k.scopes).toEqual(["messages:send"]);
    expect((await repo.findByHash("hash-1"))?.id).toBe(k.id);
    expect((await repo.findById(k.id))?.label).toBe("ci");
    expect(await repo.findByHash("nope")).toBeNull();
    expect((await repo.list()).length).toBe(1);

    await repo.touchLastUsed(k.id, new Date("2026-03-01T00:00:00Z"));
    expect((await repo.findById(k.id))?.lastUsedAt?.toISOString()).toBe("2026-03-01T00:00:00.000Z");

    expect(await repo.revoke(k.id, new Date())).toBe(true);
    expect(await repo.revoke(k.id, new Date())).toBe(false); // already revoked
  });
});

describe("DrizzleWebhookEventRepository", () => {
  it("records a verified event", async () => {
    const repo = new DrizzleWebhookEventRepository(db);
    await repo.record({
      provider: "resend",
      type: "delivered",
      providerMessageId: "pm-1",
      recipient: "a@b.com",
      isHardBounce: undefined,
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      raw: { foo: "bar" },
    });
    // No read API on the port; assert it persisted via the underlying table.
    const rows = await (db as any).select().from((await import("../src/adapters/drizzle/schema.js")).webhookEvents);
    expect(rows.length).toBe(1);
    expect(rows[0].raw).toEqual({ foo: "bar" });
  });
});
