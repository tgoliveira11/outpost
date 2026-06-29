import { describe, it, expect } from "vitest";
import {
  canTransition,
  isTerminal,
  shouldSuppressOn,
  TERMINAL_STATES,
} from "../src/domain/lifecycle.js";
import { webhookToState } from "../src/domain/webhook.js";
import { isKeyActive, hasScope } from "../src/domain/api-key.js";
import { ProviderError, isTransient, UnauthorizedError } from "../src/domain/errors.js";
import { Authenticate } from "../src/application/authenticate.js";
import { createOutpost } from "../src/index.js";
import { inMemoryRepositories, FakeEmailProvider, FakeClock } from "../src/testing/index.js";

describe("domain: lifecycle", () => {
  it("encodes the state machine", () => {
    expect(canTransition("queued", "sending")).toBe(true);
    expect(canTransition("sent", "delivered")).toBe(true);
    expect(canTransition("delivered", "queued")).toBe(false);
    expect(canTransition("failed", "queued")).toBe(true); // DLQ replay
    expect(isTerminal("delivered")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(shouldSuppressOn("bounced")).toBe(true);
    expect(shouldSuppressOn("complained")).toBe(true);
    expect(shouldSuppressOn("delivered")).toBe(false);
    expect(TERMINAL_STATES).toContain("suppressed");
  });

  it("maps webhook events to states (opened → null)", () => {
    expect(webhookToState("delivered")).toBe("delivered");
    expect(webhookToState("bounced")).toBe("bounced");
    expect(webhookToState("complained")).toBe("complained");
    expect(webhookToState("failed")).toBe("failed");
    expect(webhookToState("opened")).toBeNull();
  });
});

describe("domain: api-key", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  it("computes active state", () => {
    expect(isKeyActive({ revokedAt: null, expiresAt: null }, now)).toBe(true);
    expect(isKeyActive({ revokedAt: now, expiresAt: null }, now)).toBe(false);
    expect(isKeyActive({ revokedAt: null, expiresAt: new Date("2020-01-01") }, now)).toBe(false);
    expect(isKeyActive({ revokedAt: null, expiresAt: new Date("2030-01-01") }, now)).toBe(true);
  });
  it("resolves scopes with admin implying all", () => {
    expect(hasScope(["messages:send"], "messages:send")).toBe(true);
    expect(hasScope(["messages:send"], "keys:manage")).toBe(false);
    expect(hasScope(["admin"], "keys:manage")).toBe(true);
  });
});

describe("domain: errors", () => {
  it("classifies transient vs permanent", () => {
    expect(isTransient(ProviderError.transient("x"))).toBe(true);
    expect(isTransient(ProviderError.permanent("x"))).toBe(false);
    expect(isTransient(new Error("x"))).toBe(false);
    expect(ProviderError.permanent("x", { providerCode: "550" }).providerCode).toBe("550");
  });
});

describe("Authenticate helpers", () => {
  it("extracts keys from bearer and x-outpost-key", () => {
    expect(Authenticate.extractKey({ authorization: "Bearer abc" })).toBe("abc");
    expect(Authenticate.extractKey({ "x-outpost-key": "xyz" })).toBe("xyz");
    expect(Authenticate.extractKey({ authorization: ["Bearer arr"] })).toBe("arr");
    expect(Authenticate.extractKey({})).toBeNull();
  });

  it("rejects an unknown secret and finds a known key", async () => {
    const outpost = createOutpost({
      repositories: inMemoryRepositories(),
      providers: [new FakeEmailProvider()],
      recipientHmacKey: "test-key-at-least-16-bytes-long-aaaa",
    });
    await expect(outpost.auth.resolve("opk_unknown")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(outpost.auth.resolve(null)).rejects.toBeInstanceOf(UnauthorizedError);
    const created = await outpost.keys.create({ label: "k", scopes: ["admin"] });
    expect(await outpost.auth.findKey(created.secret)).not.toBeNull();
  });
});

describe("IngestWebhook edge cases", () => {
  function build() {
    const clock = new FakeClock();
    const outpost = createOutpost({
      repositories: inMemoryRepositories(clock),
      providers: [new FakeEmailProvider()],
      recipientHmacKey: "test-key-at-least-16-bytes-long-aaaa",
      clock,
    });
    return outpost;
  }

  it("throws for an unknown provider", async () => {
    await expect(build().webhook("nope", { headers: {}, rawBody: "{}" })).rejects.toThrow(/Unknown provider/);
  });

  it("accepts but notes when no message matches", async () => {
    const res = await build().webhook("fake", {
      headers: {},
      rawBody: JSON.stringify({ type: "delivered", providerMessageId: "missing" }),
    });
    expect(res.messageId).toBeNull();
    expect(res.note).toMatch(/no matching message/);
  });

  it("records an opened event without changing lifecycle state", async () => {
    const outpost = build();
    const { id } = await outpost.send({ idempotencyKey: "o1", to: "a@b.com", subject: "s", text: "t" });
    await outpost.tickSend();
    const pmid = (await outpost.get(id)).providerMessageId!;
    const res = await outpost.webhook("fake", {
      headers: {},
      rawBody: JSON.stringify({ type: "opened", providerMessageId: pmid }),
    });
    expect(res.eventType).toBe("opened");
    expect((await outpost.get(id)).state).toBe("sent"); // unchanged
  });
});

describe("workers: start/stop loop", () => {
  it("SendWorker.start runs at least one tick then stops", async () => {
    const clock = new FakeClock();
    const provider = new FakeEmailProvider();
    const outpost = createOutpost({
      repositories: inMemoryRepositories(clock),
      providers: [provider],
      recipientHmacKey: "test-key-at-least-16-bytes-long-aaaa",
      clock,
    });
    await outpost.send({ idempotencyKey: "loop1", to: "a@b.com", subject: "s", text: "t" });
    outpost.send_worker.start();
    outpost.send_worker.start(); // idempotent
    await new Promise((r) => setTimeout(r, 40));
    outpost.send_worker.stop();
    expect(provider.sent.length).toBe(1);
  });

  it("RetentionWorker.start/stop is safe and ticks", async () => {
    const clock = new FakeClock();
    const outpost = createOutpost({
      repositories: inMemoryRepositories(clock),
      providers: [new FakeEmailProvider()],
      recipientHmacKey: "test-key-at-least-16-bytes-long-aaaa",
      clock,
    });
    outpost.retention_worker.start();
    await new Promise((r) => setTimeout(r, 20));
    outpost.retention_worker.stop();
    const report = await outpost.tickRetention();
    expect(report.operationalProcessed).toBe(0);
  });
});
