import { describe, it, expect, vi } from "vitest";
import { createOutpost } from "../src/index.js";
import { inMemoryRepositories, FakeEmailProvider, FakeClock } from "../src/testing/index.js";
import { DispatchMessage } from "../src/application/dispatch-message.js";
import { ConsoleLogger, NoopLogger } from "../src/adapters/observability/logger.js";
import { NoopEncryptor } from "../src/adapters/crypto/encryptors.js";
import { SmtpEmailProvider } from "../src/adapters/providers/smtp.js";

const HMAC = "test-key-at-least-16-bytes-long-aaaa";
const base = () => ({ repositories: inMemoryRepositories(), providers: [new FakeEmailProvider()], recipientHmacKey: HMAC });

describe("createOutpost branches", () => {
  it("throws on empty providers", () => {
    expect(() => createOutpost({ ...base(), providers: [] })).toThrow(/at least one provider/);
  });

  it("throws when defaultProvider is not in the list", () => {
    expect(() => createOutpost({ ...base(), defaultProvider: "ghost" })).toThrow(/not in the providers list/);
  });

  it("honors an explicit defaultProvider", async () => {
    const a = new FakeEmailProvider("a");
    const b = new FakeEmailProvider("b");
    const outpost = createOutpost({ repositories: inMemoryRepositories(), providers: [a, b], defaultProvider: "b", recipientHmacKey: HMAC });
    await outpost.send({ idempotencyKey: "p", to: "x@y.com", subject: "s", text: "t" });
    await outpost.tickSend();
    expect(b.sent.length).toBe(1);
    expect(a.sent.length).toBe(0);
  });

  it("accepts a bring-your-own encryptor pair", async () => {
    const noop = new NoopEncryptor();
    const outpost = createOutpost({ ...base(), encryption: { sealEncryptor: noop, openEncryptor: noop } });
    const r = await outpost.send({ idempotencyKey: "byo", to: "x@y.com", subject: "s", text: "t" });
    expect(r.state).toBe("queued");
  });

  it("builds an in-memory rate limiter when rateLimits are set", async () => {
    const outpost = createOutpost({ ...base(), rateLimits: { global: { max: 5, windowMs: 1000 } } });
    await outpost.send({ idempotencyKey: "rl", to: "x@y.com", subject: "s", text: "t" });
    await outpost.tickSend();
    expect(outpost.deps.config.rateLimits.global?.max).toBe(5);
  });

  it("accepts custom services (logger, random, sanitizeHtml, mxResolver, rateLimiter)", () => {
    const outpost = createOutpost({
      ...base(),
      logger: new NoopLogger(),
      random: () => 0.1,
      sanitizeHtml: (h) => h,
      mxResolver: { resolveMx: async () => ["mx"] },
      rateLimiter: { acquire: async () => true },
      ids: { generate: () => "id" },
      defaultActor: "tester",
    });
    expect(outpost.deps.logger).toBeInstanceOf(NoopLogger);
  });

  it("defaults a DNS MX resolver when mx validation is on", () => {
    const outpost = createOutpost({ ...base(), domainValidation: { mx: true } });
    expect(outpost.deps.mxResolver).toBeDefined();
  });

  it("accepts a symmetric key as a base64 string", async () => {
    const key = Buffer.alloc(32, 9).toString("base64");
    const outpost = createOutpost({ ...base(), encryption: { mode: "symmetric", key } });
    const { id } = await outpost.send({ idempotencyKey: "sym", to: "x@y.com", subject: "s", text: "secret" });
    await outpost.tickSend();
    expect((await outpost.get(id)).state).toBe("sent");
  });
});

describe("dispatch branches", () => {
  it("requeues as rate_limited when the limiter rejects", async () => {
    const provider = new FakeEmailProvider();
    const outpost = createOutpost({
      repositories: inMemoryRepositories(),
      providers: [provider],
      recipientHmacKey: HMAC,
      rateLimits: { global: { max: 0, windowMs: 1000 } }, // always over budget
      random: () => 0.5,
    });
    const { id } = await outpost.send({ idempotencyKey: "rl0", to: "x@y.com", subject: "s", text: "t" });
    const report = await outpost.tickSend();
    expect(report.outcomes[0]!.kind).toBe("rate_limited");
    expect((await outpost.get(id)).state).toBe("queued");
    expect(provider.sent.length).toBe(0);
  });

  it("fails a message whose provider is not registered", async () => {
    const outpost = createOutpost(base());
    const { id } = await outpost.send({ idempotencyKey: "ghostp", to: "x@y.com", subject: "s", text: "t", provider: "ghost" });
    await outpost.tickSend();
    expect((await outpost.get(id)).state).toBe("failed");
    expect((await outpost.get(id)).lastError).toMatch(/No provider registered/);
  });

  it("skips a message no longer in `sending`", async () => {
    const clock = new FakeClock();
    const repos = inMemoryRepositories(clock);
    const provider = new FakeEmailProvider();
    const outpost = createOutpost({ repositories: repos, providers: [provider], recipientHmacKey: HMAC, clock });
    const { id } = await outpost.send({ idempotencyKey: "skip", to: "x@y.com", subject: "s", text: "t" });
    // Message is in `queued`, not `sending`: dispatch must skip it.
    const dispatch = new DispatchMessage(outpost.deps);
    const msg = repos.outbox.messages.get(id)!;
    const outcome = await dispatch.execute(msg);
    expect(outcome.kind).toBe("skipped");
  });
});

describe("enqueue branches", () => {
  it("throws when a template is used without a renderer", async () => {
    const outpost = createOutpost(base());
    await expect(
      outpost.send({ idempotencyKey: "tpl", to: "x@y.com", template: { id: "t", vars: {} } }),
    ).rejects.toThrow(/no TemplateRenderer/i);
  });

  it("throws when neither template nor subject is provided", async () => {
    const outpost = createOutpost(base());
    await expect(outpost.send({ idempotencyKey: "ns", to: "x@y.com", text: "t" } as any)).rejects.toThrow(/template.*or.*subject/i);
  });

  it("rejects an empty idempotency key", async () => {
    const outpost = createOutpost(base());
    await expect(outpost.send({ idempotencyKey: "  ", to: "x@y.com", subject: "s", text: "t" })).rejects.toThrow(/idempotencyKey/);
  });
});

describe("ConsoleLogger branches", () => {
  it("filters below the min level and routes warn/error", () => {
    const debugSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleLogger("info");
    logger.log("debug", "suppressed"); // below min → not logged
    logger.log("info", "hi", { a: 1 });
    logger.log("warn", "careful");
    logger.log("error", "boom");
    expect(debugSpy).toHaveBeenCalledTimes(1); // only the info line
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("smtp error classification", () => {
  it("classifies a connection refusal as transient", async () => {
    const provider = new SmtpEmailProvider({ host: "127.0.0.1", port: 1, from: "f@x.com" });
    await expect(
      provider.send({ id: "m", to: "a@b.com", subject: "s", body: { text: "t" }, headers: {}, metadata: {} }),
    ).rejects.toMatchObject({ errorClass: "transient" });
  });
});
