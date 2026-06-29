import { createHmac, timingSafeEqual } from "node:crypto";
import type { RecipientHasher } from "../../ports/crypto.js";

/**
 * Keyed HMAC-SHA256 recipient hasher (TDR §5.4 condition 3).
 *
 * Deterministic (same address → same digest, so suppression/idempotency work)
 * and keyed (a leaked DB dump cannot be brute-forced into addresses without the
 * key). The key MUST live outside the database — pass it from KMS/Vault/secrets,
 * never store it in a column.
 *
 * Addresses are normalized (trim + lowercase) before hashing so casing/whitespace
 * variants of the same address collapse to one digest.
 */
export class HmacRecipientHasher implements RecipientHasher {
  private readonly key: Buffer;

  constructor(key: string | Buffer) {
    this.key = typeof key === "string" ? Buffer.from(key, "utf8") : key;
    if (this.key.length < 16) {
      throw new Error("Recipient HMAC key must be at least 16 bytes of entropy");
    }
  }

  hash(address: string): string {
    const normalized = address.trim().toLowerCase();
    return createHmac("sha256", this.key).update(normalized, "utf8").digest("hex");
  }

  /** Constant-time comparison helper for callers that compare digests. */
  static equals(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
