# Next.js App Router

> Wire every Outpost HTTP endpoint as an App Router route handler using `OutpostRouter`, including the raw-body webhook sink.

`OutpostRouter` (from `@tgoliveira/outpost/next`) is built on the Web Fetch
`Request`/`Response`, so each method is a route handler. You instantiate the
router once with your shared `outpost` instance and bind methods to HTTP verbs.

> Every route handler below needs `export const runtime = "nodejs"` — Outpost
> uses `node:crypto` (HMAC verification, key hashing), which is unavailable on
> the Edge runtime.

## Shared instance and router

```ts
// lib/outpost.ts  — see getting-started.md for the full createOutpost wiring
export const outpost = createOutpost({ /* … */ });

// lib/outpost-router.ts
import { OutpostRouter } from "@tgoliveira/outpost/next";
import { outpost } from "./outpost";
export const router = new OutpostRouter(outpost);
```

## Messages — `/messages`

```ts
// app/api/outpost/messages/route.ts
import { router } from "@/lib/outpost-router";
export const runtime = "nodejs";

export const POST = (req: Request) => router.enqueue(req); // scope: messages:send → 202 (or 200 if deduplicated)
export const GET  = (req: Request) => router.list(req);    // scope: messages:read
```

## One message — `/messages/[id]`

```ts
// app/api/outpost/messages/[id]/route.ts
import { router } from "@/lib/outpost-router";
export const runtime = "nodejs";

export const GET = (req: Request, { params }: { params: { id: string } }) =>
  router.get(req, params.id); // scope: messages:read
```

## Replay — `/messages/[id]/replay`

```ts
// app/api/outpost/messages/[id]/replay/route.ts
import { router } from "@/lib/outpost-router";
export const runtime = "nodejs";

export const POST = (req: Request, { params }: { params: { id: string } }) =>
  router.replay(req, params.id); // scope: messages:replay
```

## Suppressions — `/suppressions` and `/suppressions/[hash]`

The path segment is the **recipient HMAC**, not a plaintext address.

```ts
// app/api/outpost/suppressions/route.ts
import { router } from "@/lib/outpost-router";
export const runtime = "nodejs";

export const POST = (req: Request) => router.suppress(req); // scope: suppressions:write → 201
```

```ts
// app/api/outpost/suppressions/[hash]/route.ts
import { router } from "@/lib/outpost-router";
export const runtime = "nodejs";

export const GET = (req: Request, { params }: { params: { hash: string } }) =>
  router.getSuppression(req, params.hash); // scope: suppressions:read (404 if not suppressed)

export const DELETE = (req: Request, { params }: { params: { hash: string } }) =>
  router.unsuppress(req, params.hash);     // scope: suppressions:write
```

## Webhook sink — `/webhooks/[provider]`

The webhook route is **not** API-key authenticated; trust comes from verifying
the provider's signature over the raw request body. `OutpostRouter.webhook` reads
the raw body itself via `req.text()`, so do **not** parse or transform the body
before handing the request to the router — pass the untouched `Request`.

```ts
// app/api/outpost/webhooks/[provider]/route.ts
import { router } from "@/lib/outpost-router";
export const runtime = "nodejs";

export const POST = (req: Request, { params }: { params: { provider: string } }) =>
  router.webhook(req, params.provider); // verifies signature over the raw body
```

Configure the matching `webhookSecret` on the provider (e.g. the Resend Svix
secret) — see [providers.md](./providers.md). A bad signature returns `401`
(`webhook_unverified`).

> Some frameworks buffer or re-encode request bodies, which breaks HMAC
> verification. Because `router.webhook` calls `req.text()` on the original
> Fetch `Request`, the App Router preserves the exact bytes. If you adapt this to
> another framework, ensure the provider sees the untouched raw body.

## Auth header

All endpoints except the webhook sink require an API key:

```
Authorization: Bearer opk_...
```
or
```
x-outpost-key: opk_...
```

The required scope is enforced per route (see the comments above and the full
[route table](./api.md#route-table)). The `admin` scope satisfies every route.

## Calling the API

```ts
const res = await fetch("https://app.example.com/api/outpost/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.OUTPOST_KEY}`,
  },
  body: JSON.stringify({
    idempotencyKey: "order-1234-receipt",
    to: "customer@example.com",
    subject: "Your receipt",
    html: "<p>Thanks!</p>",
  }),
});
// 202 Accepted (enqueued) or 200 (already existed / deduplicated)
const result = await res.json(); // EnqueueResult
```

See [api.md](./api.md) for request/response shapes and error mapping, and
[workers.md](./workers.md) for the cron routes that actually dispatch queued
messages.
