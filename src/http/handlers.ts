import type { Outpost } from "../client/outpost-client.js";
import type { ApiScope } from "../domain/api-key.js";
import type { AuthContext } from "../application/authenticate.js";
import { Authenticate } from "../application/authenticate.js";
import {
  OutpostError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  NotFoundError,
  WebhookVerificationError,
} from "../domain/errors.js";

/**
 * HTTP layer (TDR §4) — exported at `@tgoliveira/outpost/next`.
 *
 * Built on the Web Fetch `Request`/`Response`, so it drops straight into the
 * Next.js App Router (route handlers), Remix, Hono, or any Fetch-based runtime.
 * Each handler authenticates with an API key and enforces a least-privilege
 * scope; the webhook sink is signature-verified instead (TDR §5.1, §5.2).
 *
 * Wiring example (Next.js App Router) is in docs/nextjs.md.
 */
export class OutpostRouter {
  constructor(private readonly outpost: Outpost) {}

  /** POST /api/outpost/messages — enqueue. Scope: messages:send. */
  enqueue = (req: Request): Promise<Response> =>
    this.guarded(req, "messages:send", async (body, ctx) => {
      const result = await this.outpost.send(body, { actor: `key:${ctx.keyId}` });
      return json(result, result.deduplicated ? 200 : 202);
    });

  /** GET /api/outpost/messages — list. Scope: messages:read. */
  list = (req: Request): Promise<Response> =>
    this.authed(req, "messages:read", async () => {
      const url = new URL(req.url);
      const q = url.searchParams;
      const messages = await this.outpost.list({
        state: (q.get("state") as any) ?? undefined,
        recipientHmac: q.get("recipientHmac") ?? undefined,
        provider: q.get("provider") ?? undefined,
        limit: q.get("limit") ? Number(q.get("limit")) : undefined,
        offset: q.get("offset") ? Number(q.get("offset")) : undefined,
      });
      return json({ messages });
    });

  /** GET /api/outpost/messages/:id — fetch one. Scope: messages:read. */
  get = (req: Request, id: string): Promise<Response> =>
    this.authed(req, "messages:read", async () => json(await this.outpost.get(id)));

  /** POST /api/outpost/messages/:id/replay — DLQ replay. Scope: messages:replay. */
  replay = (req: Request, id: string): Promise<Response> =>
    this.authed(req, "messages:replay", async (ctx) =>
      json(await this.outpost.replay(id, { actor: `key:${ctx.keyId}` })),
    );

  /** GET /api/outpost/suppressions/:hash — check. Scope: suppressions:read. */
  getSuppression = (req: Request, hash: string): Promise<Response> =>
    this.authed(req, "suppressions:read", async () => {
      const entry = await this.outpost.suppression.getByHmac(hash);
      if (!entry) throw new NotFoundError("Not suppressed");
      return json(entry);
    });

  /** POST /api/outpost/suppressions — add. Scope: suppressions:write. */
  suppress = (req: Request): Promise<Response> =>
    this.guarded(req, "suppressions:write", async (body, ctx) => {
      if (!body?.address) throw new ValidationError("address is required");
      const entry = await this.outpost.suppress(body.address, body.reason ?? "manual", {
        note: body.note,
        actor: `key:${ctx.keyId}`,
      });
      return json(entry, 201);
    });

  /** DELETE /api/outpost/suppressions/:hash — remove. Scope: suppressions:write. */
  unsuppress = (req: Request, hash: string): Promise<Response> =>
    this.authed(req, "suppressions:write", async (ctx) => {
      const removed = await this.outpost.suppression.unsuppressByHmac(hash, `key:${ctx.keyId}`);
      return json({ removed });
    });

  /**
   * POST /api/outpost/webhooks/:provider — provider webhook sink.
   * NOT API-key authenticated; verified by the provider's signature scheme.
   */
  webhook = async (req: Request, provider: string): Promise<Response> => {
    try {
      const rawBody = await req.text();
      const result = await this.outpost.webhook(provider, {
        headers: headersToRecord(req.headers),
        rawBody,
      });
      return json(result);
    } catch (err) {
      return errorResponse(err);
    }
  };

  // --- internals -----------------------------------------------------------

  /** Auth + scope, no body parsing. Passes the AuthContext to the handler. */
  private async authed(
    req: Request,
    scope: ApiScope,
    handler: (ctx: AuthContext) => Promise<Response>,
  ): Promise<Response> {
    try {
      const ctx = await this.authorize(req, scope);
      return await handler(ctx);
    } catch (err) {
      return errorResponse(err);
    }
  }

  /** Auth + scope + JSON body parsing. */
  private async guarded(
    req: Request,
    scope: ApiScope,
    handler: (body: any, ctx: AuthContext) => Promise<Response>,
  ): Promise<Response> {
    try {
      const ctx = await this.authorize(req, scope);
      const body = await parseJson(req);
      return await handler(body, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  }

  private authorize(req: Request, scope: ApiScope): Promise<AuthContext> {
    const key = Authenticate.extractKey(headersToRecord(req.headers));
    return this.outpost.auth.authorize(key, scope);
  }
}

// --- helpers ---------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function parseJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** Map domain errors onto HTTP status codes (TDR §4, §5). */
export function errorResponse(err: unknown): Response {
  if (err instanceof UnauthorizedError) return json({ error: err.code, message: err.message }, 401);
  if (err instanceof ForbiddenError) return json({ error: err.code, message: err.message }, 403);
  if (err instanceof ValidationError)
    return json({ error: err.code, message: err.message, details: err.details }, 400);
  if (err instanceof NotFoundError) return json({ error: err.code, message: err.message }, 404);
  if (err instanceof WebhookVerificationError)
    return json({ error: err.code, message: err.message }, 401);
  if (err instanceof OutpostError) return json({ error: err.code, message: err.message }, 400);
  return json({ error: "internal_error", message: "Unexpected error" }, 500);
}
