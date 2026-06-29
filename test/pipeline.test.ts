import { describe, it, expect } from "vitest";
import {
  sanitizeSubject,
  sanitizeRecipient,
  sanitizeHeaders,
  assertNoHeaderInjection,
  assertBodyWithinLimits,
  stripDangerousHtml,
  validateAttachment,
  DEFAULT_SANITIZE_LIMITS,
} from "../src/application/pipeline/sanitize.js";
import {
  validateSyntax,
  extractDomain,
  validateRecipient,
  MxCache,
  DEFAULT_DOMAIN_VALIDATION,
} from "../src/application/pipeline/domain-validation.js";
import {
  backoffMs,
  isExhausted,
  nextAttemptAt,
  DEFAULT_RETRY,
} from "../src/application/pipeline/retry-policy.js";
import { ValidationError } from "../src/domain/errors.js";

describe("sanitize", () => {
  it("rejects header injection and oversize subjects", () => {
    expect(() => assertNoHeaderInjection("to", "a\r\nBcc: x")).toThrow(ValidationError);
    expect(sanitizeSubject("  Hello  ")).toBe("Hello");
    expect(() => sanitizeSubject("x".repeat(3000))).toThrow(/exceeds/);
  });

  it("validates recipients and headers", () => {
    expect(sanitizeRecipient(" a@b.com ")).toBe("a@b.com");
    expect(() => sanitizeRecipient("a@b.com\nx")).toThrow();
    expect(sanitizeHeaders({ "X-Tag": "ok" })).toEqual({ "X-Tag": "ok" });
    expect(() => sanitizeHeaders({ "X-Tag": "a\r\nb" })).toThrow();
    expect(() => sanitizeHeaders({ "X-Big": "v".repeat(5000) })).toThrow();
  });

  it("enforces body presence and size", () => {
    expect(() => assertBodyWithinLimits({})).toThrow(/empty/);
    expect(() => assertBodyWithinLimits({ text: "x".repeat(6_000_000) })).toThrow(/exceeds/);
    expect(() => assertBodyWithinLimits({ text: "ok" })).not.toThrow();
  });

  it("strips dangerous HTML", () => {
    const dirty = `<p onclick="x()">hi</p><script>evil()</script><a href="javascript:alert(1)">l</a>`;
    const clean = stripDangerousHtml(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).not.toMatch(/javascript:/i);
  });

  it("validates attachments", () => {
    expect(() => validateAttachment({ filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10 })).not.toThrow();
    expect(() => validateAttachment({ filename: "a.exe", contentType: "application/x-msdownload", sizeBytes: 10 })).toThrow(/not allowed/);
    expect(() => validateAttachment({ filename: "big.pdf", contentType: "application/pdf", sizeBytes: 99_000_000 })).toThrow(/exceeds/);
    expect(() => validateAttachment({ filename: "a\r\n.pdf", contentType: "application/pdf", sizeBytes: 1 })).toThrow();
  });
});

describe("domain validation", () => {
  it("validates syntax and extracts the domain", () => {
    expect(validateSyntax("user@example.com")).toBe("example.com");
    expect(() => validateSyntax("not-an-email")).toThrow(ValidationError);
    expect(extractDomain("a@b.co.uk")).toBe("b.co.uk");
    expect(() => extractDomain("nodomain")).toThrow();
  });

  it("MxCache stores and expires entries", () => {
    const cache = new MxCache(1000);
    cache.set("d.com", ["mx1"], 0);
    expect(cache.get("d.com", 500)).toEqual(["mx1"]);
    expect(cache.get("d.com", 2000)).toBeUndefined(); // expired
    expect(cache.get("missing", 0)).toBeUndefined();
  });

  it("checks MX when enabled, using a fake resolver + cache", async () => {
    const resolver = { resolveMx: async (d: string) => (d === "good.com" ? ["mx.good.com"] : []) };
    const cache = new MxCache(1000);
    await expect(
      validateRecipient("a@good.com", { syntax: true, mx: true, mailboxProbe: false }, { mxResolver: resolver, mxCache: cache, nowMs: 0 }),
    ).resolves.toBeUndefined();
    await expect(
      validateRecipient("a@bad.com", { syntax: true, mx: true, mailboxProbe: false }, { mxResolver: resolver, mxCache: cache, nowMs: 0 }),
    ).rejects.toThrow(/no MX/);
    // syntax-only path (default) does no DNS
    await expect(validateRecipient("a@x.com", DEFAULT_DOMAIN_VALIDATION, { nowMs: 0 })).resolves.toBeUndefined();
  });

  it("treats a resolver throw as no MX", async () => {
    const resolver = { resolveMx: async () => { throw new Error("dns down"); } };
    await expect(
      validateRecipient("a@x.com", { syntax: true, mx: true, mailboxProbe: false }, { mxResolver: resolver, mxCache: new MxCache(1000), nowMs: 0 }),
    ).rejects.toThrow(/no MX/);
  });
});

describe("retry policy", () => {
  it("computes capped, jittered backoff", () => {
    expect(isExhausted(5, DEFAULT_RETRY)).toBe(true);
    expect(isExhausted(1, DEFAULT_RETRY)).toBe(false);
    // attempt 1 with jitter 1 → base; jitter 0 → 0
    expect(backoffMs(1, DEFAULT_RETRY, 1)).toBe(DEFAULT_RETRY.baseDelayMs);
    expect(backoffMs(1, DEFAULT_RETRY, 0)).toBe(0);
    // exponential growth is capped at maxDelayMs
    expect(backoffMs(100, DEFAULT_RETRY, 1)).toBe(DEFAULT_RETRY.maxDelayMs);
    const at = nextAttemptAt(1, DEFAULT_RETRY, 1, new Date(0));
    expect(at.getTime()).toBe(DEFAULT_RETRY.baseDelayMs);
  });
});
