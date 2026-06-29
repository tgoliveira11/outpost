import { createHash, randomBytes } from "node:crypto";
import type { CoreDeps } from "./context.js";
import type { ApiKey, ApiScope } from "../domain/api-key.js";

/**
 * Hash an API key secret for storage. Keys are high-entropy random tokens
 * (not user passwords), so a fast one-way SHA-256 is appropriate and lets us
 * look the hash up directly. A slow password hash (bcrypt/argon2) buys nothing
 * against a 256-bit random secret and would break O(1) lookup.
 */
export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Generate an opaque, high-entropy key with a recognizable prefix. */
export function generateApiKeySecret(): string {
  return `opk_${randomBytes(32).toString("base64url")}`;
}

export interface CreatedApiKey {
  readonly id: string;
  readonly label: string;
  readonly scopes: readonly ApiScope[];
  readonly expiresAt: Date | null;
  /** The plaintext secret — shown ONCE, never stored, never recoverable. */
  readonly secret: string;
}

/**
 * ManageApiKey — admin-side key lifecycle (TDR §5.1, §3.12).
 *
 * Only the hash is stored. The plaintext is returned exactly once at creation.
 * Revocation takes effect immediately (no caching of key state beyond the
 * documented short window in the Authenticate use case).
 */
export class ManageApiKey {
  constructor(private readonly deps: CoreDeps) {}

  async create(input: {
    label: string;
    scopes: readonly ApiScope[];
    expiresAt?: Date | null;
  }): Promise<CreatedApiKey> {
    const secret = generateApiKeySecret();
    const key = await this.deps.apiKeys.insert({
      label: input.label,
      keyHash: hashApiKey(secret),
      scopes: input.scopes,
      expiresAt: input.expiresAt ?? null,
    });
    await this.deps.audit.append({
      messageId: null,
      eventType: "key_created",
      actor: "admin",
      detail: { keyId: key.id, label: key.label, scopes: key.scopes },
    });
    return {
      id: key.id,
      label: key.label,
      scopes: key.scopes,
      expiresAt: key.expiresAt,
      secret,
    };
  }

  async revoke(id: string): Promise<boolean> {
    const ok = await this.deps.apiKeys.revoke(id, this.deps.clock.now());
    if (ok) {
      await this.deps.audit.append({
        messageId: null,
        eventType: "key_revoked",
        actor: "admin",
        detail: { keyId: id },
      });
    }
    return ok;
  }

  /** Lists keys WITHOUT secrets (only hashes are stored anyway). */
  async list(): Promise<ApiKey[]> {
    return this.deps.apiKeys.list();
  }
}
