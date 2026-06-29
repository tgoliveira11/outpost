import { describe, it, expect, vi, afterEach } from "vitest";
import { SmtpEmailProvider } from "../src/adapters/providers/smtp.js";
import { ResendEmailProvider } from "../src/adapters/providers/resend.js";
import { InMemoryTemplateRenderer } from "../src/adapters/template/in-memory.js";
import { InMemoryRateLimiter, UnlimitedRateLimiter } from "../src/adapters/rate-limit/in-memory.js";
import {
  NoopEncryptor,
  AesGcmEncryptor,
  HybridSealEncryptor,
  HybridOpenEncryptor,
} from "../src/adapters/crypto/encryptors.js";
import { HmacRecipientHasher } from "../src/adapters/crypto/recipient-hasher.js";
import { SystemClock, UuidGenerator } from "../src/adapters/services/system.js";
import { ProviderError, WebhookVerificationError } from "../src/domain/errors.js";
import type { Clock } from "../src/ports/services.js";
import type { DispatchableMessage } from "../src/domain/message.js";

const msg = (over: Partial<DispatchableMessage> = {}): DispatchableMessage => ({
  id: "m1",
  to: "a@b.com",
  subject: "Subject",
  body: { html: "<p>hi</p>", text: "hi" },
  headers: {},
  metadata: {},
  ...over,
});

describe("SmtpEmailProvider", () => {
  it("sends via nodemailer jsonTransport and returns a message id", async () => {
    const provider = new SmtpEmailProvider({
      host: "localhost",
      port: 1025,
      from: "from@x.com",
      transportOptions: { jsonTransport: true }, // serialize instead of connecting
    });
    const receipt = await provider.send(msg());
    expect(receipt.providerMessageId).toBeTruthy();
  });

  it("has no webhooks", async () => {
    const provider = new SmtpEmailProvider({ host: "h", port: 25, from: "f@x.com" });
    await expect(provider.verifyWebhook({ headers: {}, rawBody: "" })).rejects.toThrow(WebhookVerificationError);
    expect(provider.name).toBe("smtp");
  });

  it("uses a custom provider name", () => {
    expect(new SmtpEmailProvider({ host: "h", port: 25, from: "f@x.com", name: "mailpit" }).name).toBe("mailpit");
  });
});

describe("ResendEmailProvider.send", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the provider id on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 })));
    const p = new ResendEmailProvider({ apiKey: "k", from: "f@x.com" });
    expect((await p.send(msg())).providerMessageId).toBe("re_1");
  });

  it("throws transient on 429 / 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate", { status: 429 })));
    const p = new ResendEmailProvider({ apiKey: "k", from: "f@x.com" });
    await expect(p.send(msg())).rejects.toMatchObject({ errorClass: "transient" });
  });

  it("throws permanent on 4xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 422 })));
    const p = new ResendEmailProvider({ apiKey: "k", from: "f@x.com" });
    await expect(p.send(msg())).rejects.toMatchObject({ errorClass: "permanent" });
  });

  it("throws transient on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const p = new ResendEmailProvider({ apiKey: "k", from: "f@x.com" });
    await expect(p.send(msg())).rejects.toBeInstanceOf(ProviderError);
  });

  it("rejects a webhook when no secret is configured", async () => {
    const p = new ResendEmailProvider({ apiKey: "k", from: "f@x.com" });
    await expect(p.verifyWebhook({ headers: {}, rawBody: "{}" })).rejects.toThrow(/secret/i);
  });
});

describe("InMemoryTemplateRenderer", () => {
  it("renders, escapes HTML vars, and picks the latest version", async () => {
    const r = new InMemoryTemplateRenderer([
      { id: "t", version: 1, subject: "Hi {{name}}", html: "<b>{{name}}</b>", text: "Hi {{name}}" },
      { id: "t", version: 2, subject: "v2 {{name}}", html: "<b>{{name}}</b>" },
    ]);
    const out = await r.render({ id: "t", vars: { name: "<script>" } });
    expect(out.subject).toBe("v2 <script>"); // subject not HTML-escaped
    expect(out.body.html).toBe("<b>&lt;script&gt;</b>"); // html escaped
  });

  it("renders a specific version and handles missing vars", async () => {
    const r = new InMemoryTemplateRenderer();
    r.register({ id: "x", version: 3, subject: "S {{a}}", text: "{{missing}}" });
    const out = await r.render({ id: "x", version: 3, vars: {} });
    expect(out.body.text).toBe("");
  });

  it("throws on unknown template / version", async () => {
    const r = new InMemoryTemplateRenderer();
    await expect(r.render({ id: "nope", vars: {} })).rejects.toThrow(/Unknown template/);
    r.register({ id: "x", version: 1, subject: "s" });
    await expect(r.render({ id: "x", version: 9, vars: {} })).rejects.toThrow(/version/);
  });
});

describe("InMemoryRateLimiter", () => {
  const fixedClock = (t: number): Clock => ({ now: () => new Date(t) });

  it("allows up to the budget then rejects, and refills over time", async () => {
    let t = 0;
    const limiter = new InMemoryRateLimiter({ global: { max: 2, windowMs: 1000 } }, { now: () => new Date(t) });
    expect(await limiter.acquire({ kind: "global" })).toBe(true);
    expect(await limiter.acquire({ kind: "global" })).toBe(true);
    expect(await limiter.acquire({ kind: "global" })).toBe(false); // empty
    t = 1000; // full refill
    expect(await limiter.acquire({ kind: "global" })).toBe(true);
  });

  it("is unlimited when no budget is configured for the scope", async () => {
    const limiter = new InMemoryRateLimiter({}, fixedClock(0));
    expect(await limiter.acquire({ kind: "provider", key: "resend" })).toBe(true);
  });

  it("UnlimitedRateLimiter always allows", async () => {
    expect(await new UnlimitedRateLimiter().acquire({ kind: "global" })).toBe(true);
  });
});

describe("encryptors", () => {
  it("NoopEncryptor round-trips base64 plaintext", async () => {
    const e = new NoopEncryptor();
    const sealed = await e.seal("hello");
    expect(sealed.alg).toBe("plain");
    expect(await e.open(sealed)).toBe("hello");
  });

  it("AesGcmEncryptor round-trips and rejects a bad key length", async () => {
    const e = new AesGcmEncryptor(Buffer.alloc(32, 1));
    const sealed = await e.seal("secret");
    expect(sealed.alg).toBe("aes-256-gcm");
    expect(await e.open(sealed)).toBe("secret");
    expect(await e.open(await new NoopEncryptor().seal("p"))).toBe("p"); // tolerates plain
    expect(() => new AesGcmEncryptor(Buffer.alloc(16))).toThrow();
  });

  it("hybrid enforces the seal/open split", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const seal = new HybridSealEncryptor(publicKey);
    const open = new HybridOpenEncryptor(privateKey);
    const sealed = await seal.seal("classified");
    expect(await open.open(sealed)).toBe("classified");
    await expect(seal.open(sealed)).rejects.toThrow(/cannot decrypt/i); // web tier can't read
    await expect(open.seal()).rejects.toThrow(/read-only/i); // worker doesn't seal
  });
});

describe("HmacRecipientHasher", () => {
  it("is deterministic, case/space-insensitive, and constant-time comparable", () => {
    const h = new HmacRecipientHasher("a-key-with-enough-entropy-1234567");
    expect(h.hash("A@B.com")).toBe(h.hash(" a@b.com "));
    expect(HmacRecipientHasher.equals(h.hash("a@b.com"), h.hash("a@b.com"))).toBe(true);
    expect(HmacRecipientHasher.equals("a", "bb")).toBe(false);
    expect(() => new HmacRecipientHasher("short")).toThrow();
  });
});

describe("system services", () => {
  it("SystemClock returns a Date and UuidGenerator a uuid", () => {
    expect(new SystemClock().now()).toBeInstanceOf(Date);
    expect(new UuidGenerator().generate()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
