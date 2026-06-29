import { describe, it, expect, beforeEach } from "vitest";
import { createOutpost, type Outpost } from "../src/index.js";
import {
  inMemoryRepositories,
  FakeEmailProvider,
  FakeClock,
} from "../src/testing/index.js";

const HMAC_KEY = "test-key-at-least-16-bytes-long-aaaa";

function setup(opts?: { failNext?: "transient" | "permanent" }) {
  const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
  const repos = inMemoryRepositories(clock);
  const provider = new FakeEmailProvider();
  if (opts?.failNext) provider.failNext(opts.failNext);
  const outpost = createOutpost({
    repositories: repos,
    providers: [provider],
    recipientHmacKey: HMAC_KEY,
    clock,
    retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 },
    random: () => 0.5, // deterministic jitter
  });
  return { outpost, provider, clock, repos };
}

describe("ingestion + idempotency", () => {
  it("persists a queued message", async () => {
    const { outpost } = setup();
    const r = await outpost.send({
      idempotencyKey: "k1",
      to: "alice@example.com",
      subject: "Hi",
      text: "hello",
    });
    expect(r.state).toBe("queued");
    expect(r.deduplicated).toBe(false);
  });

  it("dedupes a repeated idempotency key (no duplicate send)", async () => {
    const { outpost, repos } = setup();
    await outpost.send({ idempotencyKey: "dup", to: "a@example.com", subject: "S", text: "t" });
    const second = await outpost.send({
      idempotencyKey: "dup",
      to: "a@example.com",
      subject: "S",
      text: "t",
    });
    expect(second.deduplicated).toBe(true);
    expect(repos.outbox.messages.size).toBe(1);
  });

  it("rejects header injection in the subject", async () => {
    const { outpost } = setup();
    await expect(
      outpost.send({ idempotencyKey: "x", to: "a@example.com", subject: "Hi\r\nBcc: evil@x.com", text: "t" }),
    ).rejects.toThrow(/header injection/i);
  });

  it("records suppressed recipients without queuing", async () => {
    const { outpost } = setup();
    await outpost.suppress("blocked@example.com", "manual");
    const r = await outpost.send({
      idempotencyKey: "s1",
      to: "blocked@example.com",
      subject: "S",
      text: "t",
    });
    expect(r.state).toBe("suppressed");
  });
});

describe("dispatch pipeline", () => {
  it("sends a queued message via the provider", async () => {
    const { outpost, provider } = setup();
    const { id } = await outpost.send({
      idempotencyKey: "d1",
      to: "bob@example.com",
      subject: "S",
      text: "body",
    });
    const report = await outpost.tickSend();
    expect(report.claimed).toBe(1);
    expect(provider.sent).toHaveLength(1);
    const msg = await outpost.get(id);
    expect(msg.state).toBe("sent");
    expect(msg.providerMessageId).toBe("fake-1");
  });

  it("decrypts the body and recipient before dispatch", async () => {
    const { outpost, provider } = setup();
    await outpost.send({ idempotencyKey: "d2", to: "carol@example.com", subject: "S", html: "<p>hi</p>" });
    await outpost.tickSend();
    expect(provider.sent[0]!.message.to).toBe("carol@example.com");
    expect(provider.sent[0]!.message.body.html).toContain("hi");
  });

  it("retries a transient failure with backoff, then succeeds", async () => {
    const { outpost, provider, clock } = setup({ failNext: "transient" });
    const { id } = await outpost.send({ idempotencyKey: "r1", to: "d@example.com", subject: "S", text: "t" });
    await outpost.tickSend(); // fails transiently → back to queued
    let msg = await outpost.get(id);
    expect(msg.state).toBe("queued");
    expect(msg.attempts).toBe(1);

    clock.advance(60_000); // wait out the backoff
    await outpost.tickSend(); // succeeds
    msg = await outpost.get(id);
    expect(msg.state).toBe("sent");
    expect(provider.sent).toHaveLength(1);
  });

  it("dead-letters a permanent failure immediately", async () => {
    const { outpost } = setup({ failNext: "permanent" });
    const { id } = await outpost.send({ idempotencyKey: "p1", to: "e@example.com", subject: "S", text: "t" });
    await outpost.tickSend();
    const msg = await outpost.get(id);
    expect(msg.state).toBe("failed");
    expect(msg.lastError).toMatch(/permanent/);
  });

  it("reclaims a row abandoned in `sending` after the lease (crash recovery)", async () => {
    const { outpost, provider, clock, repos } = setup();
    const { id } = await outpost.send({ idempotencyKey: "stuck1", to: "s@example.com", subject: "S", text: "t" });
    // Simulate a worker that claimed the row then crashed mid-dispatch.
    await repos.outbox.updateState(id, { state: "sending" });
    expect((await outpost.get(id)).state).toBe("sending");

    // Within the lease: not reclaimed.
    await outpost.tickSend();
    expect((await outpost.get(id)).state).toBe("sending");
    expect(provider.sent).toHaveLength(0);

    // Past the lease (default 5 min): reclaimed and sent.
    clock.advance(6 * 60 * 1000);
    await outpost.tickSend();
    expect((await outpost.get(id)).state).toBe("sent");
    expect(provider.sent).toHaveLength(1);
  });

  it("replays a dead-lettered message", async () => {
    const { outpost, provider } = setup({ failNext: "permanent" });
    const { id } = await outpost.send({ idempotencyKey: "rp1", to: "f@example.com", subject: "S", text: "t" });
    await outpost.tickSend();
    expect((await outpost.get(id)).state).toBe("failed");

    await outpost.replay(id);
    expect((await outpost.get(id)).state).toBe("queued");
    await outpost.tickSend();
    expect((await outpost.get(id)).state).toBe("sent");
    expect(provider.sent).toHaveLength(1);
  });
});

describe("webhook lifecycle + suppression feedback", () => {
  async function sendAndDispatch(outpost: Outpost, to: string) {
    const { id } = await outpost.send({ idempotencyKey: `wh-${to}`, to, subject: "S", text: "t" });
    await outpost.tickSend();
    const msg = await outpost.get(id);
    return { id, providerMessageId: msg.providerMessageId! };
  }

  it("marks delivered on a delivered webhook", async () => {
    const { outpost } = setup();
    const { id, providerMessageId } = await sendAndDispatch(outpost, "g@example.com");
    const res = await outpost.webhook("fake", {
      headers: {},
      rawBody: JSON.stringify({ type: "delivered", providerMessageId }),
    });
    expect(res.accepted).toBe(true);
    expect((await outpost.get(id)).state).toBe("delivered");
  });

  it("suppresses on a hard bounce", async () => {
    const { outpost } = setup();
    const { id, providerMessageId } = await sendAndDispatch(outpost, "h@example.com");
    await outpost.webhook("fake", {
      headers: {},
      rawBody: JSON.stringify({ type: "bounced", providerMessageId, isHardBounce: true }),
    });
    expect((await outpost.get(id)).state).toBe("bounced");
    expect(await outpost.isSuppressed("h@example.com")).toBe(true);
  });

  it("suppresses on a complaint", async () => {
    const { outpost } = setup();
    const { providerMessageId } = await sendAndDispatch(outpost, "i@example.com");
    await outpost.webhook("fake", {
      headers: {},
      rawBody: JSON.stringify({ type: "complained", providerMessageId }),
    });
    expect(await outpost.isSuppressed("i@example.com")).toBe(true);
  });

  it("does not suppress on a soft bounce", async () => {
    const { outpost } = setup();
    const { providerMessageId } = await sendAndDispatch(outpost, "j@example.com");
    await outpost.webhook("fake", {
      headers: {},
      rawBody: JSON.stringify({ type: "bounced", providerMessageId, isHardBounce: false }),
    });
    expect(await outpost.isSuppressed("j@example.com")).toBe(false);
  });
});

describe("encryption at rest", () => {
  it("symmetric: round-trips body + recipient, stores ciphertext", async () => {
    const repos = inMemoryRepositories();
    const provider = new FakeEmailProvider();
    const key = Buffer.alloc(32, 7).toString("base64");
    const outpost = createOutpost({
      repositories: repos,
      providers: [provider],
      recipientHmacKey: HMAC_KEY,
      encryption: { mode: "symmetric", key },
    });
    const { id } = await outpost.send({
      idempotencyKey: "enc1",
      to: "secret@example.com",
      subject: "S",
      text: "top secret",
    });
    const row = repos.outbox.messages.get(id)!;
    expect(row.bodySealed.alg).toBe("aes-256-gcm");
    expect(JSON.stringify(row.bodySealed)).not.toContain("top secret");
    await outpost.tickSend();
    expect(provider.sent[0]!.message.body.text).toBe("top secret");
  });

  it("asymmetric: web tier seals, worker opens", async () => {
    // RSA keypair generated lazily for the test.
    const { generateKeyPairSync } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const repos = inMemoryRepositories();
    const provider = new FakeEmailProvider();
    const outpost = createOutpost({
      repositories: repos,
      providers: [provider],
      recipientHmacKey: HMAC_KEY,
      encryption: { mode: "asymmetric", publicKey, privateKey },
    });
    const { id } = await outpost.send({
      idempotencyKey: "enc2",
      to: "z@example.com",
      subject: "S",
      text: "hybrid secret",
    });
    expect(repos.outbox.messages.get(id)!.bodySealed.alg).toBe("hybrid-rsa-aes-256-gcm");
    await outpost.tickSend();
    expect(provider.sent[0]!.message.body.text).toBe("hybrid secret");
  });
});

describe("retention", () => {
  it("redacts PII of aged terminal rows but keeps the row", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const repos = inMemoryRepositories(clock);
    const provider = new FakeEmailProvider();
    const outpost = createOutpost({
      repositories: repos,
      providers: [provider],
      recipientHmacKey: HMAC_KEY,
      clock,
      retention: { operationalTtlDays: 1, webhookWindowHours: 1, redactOnPurge: true, batchSize: 100, auditTtlDays: 365 },
    });
    const { id } = await outpost.send({ idempotencyKey: "ret1", to: "k@example.com", subject: "S", text: "pii body" });
    await outpost.tickSend();
    const { providerMessageId } = await outpost.get(id);
    await outpost.webhook("fake", {
      headers: {},
      rawBody: JSON.stringify({ type: "delivered", providerMessageId }),
    });

    clock.advance(3 * 24 * 60 * 60 * 1000); // 3 days later
    const report = await outpost.tickRetention();
    expect(report.operationalProcessed).toBe(1);
    const row = repos.outbox.messages.get(id)!;
    expect(row.bodySealed.alg).toBe("redacted");
    expect(row.recipientHmac).toBeTruthy(); // hash preserved for audit
  });
});

describe("api keys + auth", () => {
  it("creates a key, authorizes the right scope, rejects others", async () => {
    const { outpost } = setup();
    const created = await outpost.keys.create({ label: "send-only", scopes: ["messages:send"] });
    expect(created.secret).toMatch(/^opk_/);

    const ctx = await outpost.auth.authorize(created.secret, "messages:send");
    expect(ctx.keyId).toBe(created.id);

    await expect(outpost.auth.authorize(created.secret, "suppressions:write")).rejects.toThrow();
  });

  it("rejects a revoked key immediately", async () => {
    const { outpost } = setup();
    const created = await outpost.keys.create({ label: "k", scopes: ["admin"] });
    await outpost.keys.revoke(created.id);
    await expect(outpost.auth.resolve(created.secret)).rejects.toThrow();
  });
});
