import type { CoreDeps } from "./context.js";
import type { ApiKey, ApiScope } from "../domain/api-key.js";
import { isKeyActive, hasScope } from "../domain/api-key.js";
import { UnauthorizedError, ForbiddenError } from "../domain/errors.js";
import { hashApiKey } from "./manage-api-key.js";

export interface AuthContext {
  readonly keyId: string;
  readonly scopes: readonly ApiScope[];
}

/**
 * Authenticate — validates an API key on every request (TDR §5.1).
 *
 *   - Hashes the presented secret and looks up the stored hash.
 *   - Rejects missing / unknown / expired / revoked keys with 401.
 *   - Enforces the required scope (least privilege) with 403.
 *   - Touches `last_used_at` for observability.
 *
 * Revocation/expiry are enforced on every call (no long-lived caching), so
 * they take effect immediately as the TDR requires.
 */
export class Authenticate {
  constructor(private readonly deps: CoreDeps) {}

  /** Resolve a bearer secret to an AuthContext or throw UnauthorizedError. */
  async resolve(presentedSecret: string | null | undefined): Promise<AuthContext> {
    if (!presentedSecret) throw new UnauthorizedError();
    const keyHash = hashApiKey(presentedSecret);
    const key = await this.deps.apiKeys.findByHash(keyHash);
    if (!key) throw new UnauthorizedError();
    if (!isKeyActive(key, this.deps.clock.now())) throw new UnauthorizedError();

    // Fire-and-forget last-used update; never block the request on it.
    void this.deps.apiKeys.touchLastUsed(key.id, this.deps.clock.now());

    return { keyId: key.id, scopes: key.scopes };
  }

  /** Resolve then assert the context carries the required scope. */
  async authorize(presentedSecret: string | null | undefined, required: ApiScope): Promise<AuthContext> {
    const ctx = await this.resolve(presentedSecret);
    if (!hasScope(ctx.scopes, required)) throw new ForbiddenError();
    return ctx;
  }

  /** Assert a scope on an already-resolved context. */
  static requireScope(ctx: AuthContext, required: ApiScope): void {
    if (!hasScope(ctx.scopes, required)) throw new ForbiddenError();
  }

  /** Helper to extract a bearer/x-outpost-key value from headers. */
  static extractKey(headers: Record<string, string | string[] | undefined>): string | null {
    const auth = headerValue(headers, "authorization");
    if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
    return headerValue(headers, "x-outpost-key");
  }

  // Exposed for tests / admin tooling.
  async findKey(presentedSecret: string): Promise<ApiKey | null> {
    return this.deps.apiKeys.findByHash(hashApiKey(presentedSecret));
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}
