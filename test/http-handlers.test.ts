import { describe, it, expect, beforeEach } from "vitest";
import { createOutpost, type Outpost } from "../src/index.js";
import { inMemoryRepositories, FakeEmailProvider } from "../src/testing/index.js";
import { OutpostRouter, errorResponse } from "../src/http/handlers.js";
import { ValidationError } from "../src/domain/errors.js";

const HMAC_KEY = "test-key-at-least-16-bytes-long-aaaa";

async function setup() {
  const outpost = createOutpost({
    repositories: inMemoryRepositories(),
    providers: [new FakeEmailProvider()],
    recipientHmacKey: HMAC_KEY,
  });
  const admin = await outpost.keys.create({ label: "admin", scopes: ["admin"] });
  const router = new OutpostRouter(outpost);
  return { outpost, router, key: admin.secret };
}

function req(body?: unknown, key?: string): Request {
  return new Request("https://x/api/outpost/messages", {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}`, "content-type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("OutpostRouter auth", () => {
  it("rejects missing key with 401", async () => {
    const { router } = await setup();
    const res = await router.enqueue(req({ idempotencyKey: "a", to: "x@y.com", subject: "s", text: "t" }));
    expect(res.status).toBe(401);
  });

  it("rejects insufficient scope with 403", async () => {
    const { outpost, router } = await setup();
    const sendOnly = await outpost.keys.create({ label: "s", scopes: ["messages:send"] });
    const res = await router.list(
      new Request("https://x/api/outpost/messages", { headers: { authorization: `Bearer ${sendOnly.secret}` } }),
    );
    expect(res.status).toBe(403);
  });
});

describe("OutpostRouter endpoints", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("enqueues (202) and dedupes (200)", async () => {
    const first = await ctx.router.enqueue(req({ idempotencyKey: "e1", to: "a@b.com", subject: "s", text: "t" }, ctx.key));
    expect(first.status).toBe(202);
    const second = await ctx.router.enqueue(req({ idempotencyKey: "e1", to: "a@b.com", subject: "s", text: "t" }, ctx.key));
    expect(second.status).toBe(200);
  });

  it("rejects invalid JSON body with 400", async () => {
    const bad = new Request("https://x", {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.key}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect((await ctx.router.enqueue(bad)).status).toBe(400);
  });

  it("gets and lists messages", async () => {
    const r = await ctx.outpost.send({ idempotencyKey: "g1", to: "a@b.com", subject: "s", text: "t" });
    const getRes = await ctx.router.get(authedGet(ctx.key), r.id);
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).id).toBe(r.id);

    const listRes = await ctx.router.list(authedGet(ctx.key));
    expect((await listRes.json()).messages.length).toBe(1);
  });

  it("returns 404 for an unknown message", async () => {
    const res = await ctx.router.get(authedGet(ctx.key), "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("replays a failed message", async () => {
    const provider = new FakeEmailProvider();
    provider.failNext("permanent");
    const outpost = createOutpost({
      repositories: inMemoryRepositories(),
      providers: [provider],
      recipientHmacKey: HMAC_KEY,
    });
    const key = (await outpost.keys.create({ label: "a", scopes: ["admin"] })).secret;
    const router = new OutpostRouter(outpost);
    const r = await outpost.send({ idempotencyKey: "rp", to: "a@b.com", subject: "s", text: "t" });
    await outpost.tickSend();
    const res = await router.replay(authedGet(key), r.id);
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("queued");
  });

  it("manages suppressions over HTTP (add, get by hash, 404, delete)", async () => {
    const addRes = await ctx.router.suppress(req({ address: "block@b.com", reason: "manual" }, ctx.key));
    expect(addRes.status).toBe(201);
    const hash = ctx.outpost.deps.recipientHasher.hash("block@b.com");

    const getRes = await ctx.router.getSuppression(authedGet(ctx.key), hash);
    expect(getRes.status).toBe(200);

    const missRes = await ctx.router.getSuppression(authedGet(ctx.key), "nope");
    expect(missRes.status).toBe(404);

    const delRes = await ctx.router.unsuppress(authedGet(ctx.key), hash);
    expect((await delRes.json()).removed).toBe(true);
  });

  it("rejects suppress without an address (400)", async () => {
    const res = await ctx.router.suppress(req({}, ctx.key));
    expect(res.status).toBe(400);
  });

  it("ingests a webhook without an API key", async () => {
    const r = await ctx.outpost.send({ idempotencyKey: "w1", to: "a@b.com", subject: "s", text: "t" });
    await ctx.outpost.tickSend();
    const pmid = (await ctx.outpost.get(r.id)).providerMessageId!;
    const whReq = new Request("https://x/api/outpost/webhooks/fake", {
      method: "POST",
      body: JSON.stringify({ type: "delivered", providerMessageId: pmid }),
    });
    const res = await ctx.router.webhook(whReq, "fake");
    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(true);
  });

  it("returns 401 for an unverifiable webhook", async () => {
    const whReq = new Request("https://x", { method: "POST", body: "not json" });
    const res = await ctx.router.webhook(whReq, "fake");
    expect(res.status).toBe(401);
  });
});

describe("errorResponse mapping", () => {
  it("maps unknown errors to 500", async () => {
    const res = errorResponse(new Error("boom"));
    expect(res.status).toBe(500);
  });
  it("includes validation details", async () => {
    const res = errorResponse(new ValidationError("bad", { field: "x" }));
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ field: "x" });
  });
});

function authedGet(key: string): Request {
  return new Request("https://x/api/outpost/messages", { headers: { authorization: `Bearer ${key}` } });
}
