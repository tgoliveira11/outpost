/**
 * API key domain types and scope model (TDR §5.1).
 *
 * Keys are opaque high-entropy secrets. Only a hash is ever stored; the
 * plaintext is shown once at creation. A key carries a label, optional expiry,
 * and a revoked flag — both enforced on every request. Scopes implement
 * least-privilege (a send-only key cannot manage suppressions).
 */

export const API_SCOPES = [
  "messages:send",
  "messages:read",
  "messages:replay",
  "suppressions:read",
  "suppressions:write",
  "keys:manage",
  "admin", // implies all of the above
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKey {
  readonly id: string;
  /** Human label shown in the admin panel. */
  readonly label: string;
  /** Hash of the secret (never the secret itself). */
  readonly keyHash: string;
  readonly scopes: readonly ApiScope[];
  readonly expiresAt: Date | null;
  revokedAt: Date | null;
  readonly createdAt: Date;
  lastUsedAt: Date | null;
}

/** A key is usable iff it is not revoked and not past its expiry. */
export function isKeyActive(key: Pick<ApiKey, "revokedAt" | "expiresAt">, now: Date): boolean {
  if (key.revokedAt !== null) return false;
  if (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/** True when the key's scopes satisfy the required scope (admin implies all). */
export function hasScope(scopes: readonly ApiScope[], required: ApiScope): boolean {
  return scopes.includes("admin") || scopes.includes(required);
}
