# AGENTS.md — using `@tgoliveira/outpost`

> This file is written for AI coding agents (and humans) integrating Outpost into
> an application. It is the fastest path from "I need to send transactional
> email reliably" to working code. Read this top-to-bottom once; then jump to the
> task recipe you need.

## What Outpost is (and is not)

Outpost is a **transactional outbox with a pluggable transport layer**. Email is
the only transport in v1. It is **not** an email client and **not** a marketing
platform. Its job is to guarantee a message is **persisted before it is sent**,
**deduplicated** (at-most-once), **auditable**, **lifecycle-tracked** via provider
webhooks, **reputation-safe** (suppression list), and **provider-agnostic**
(swap Resend ↔ SMTP ↔ SES without touching your code).

If you only need "fire an email", a raw provider SDK is simpler. Reach for
Outpost when losing or duplicating a message is unacceptable (receipts, password
resets, invoices) and you need an audit trail + delivery tracking.

## The one mental model you need

```
your app ──outpost.send()──▶ [outbox table]  (persisted FIRST, state=queued)
                                   │
                      SendWorker polls & claims (FOR UPDATE SKIP LOCKED)
                                   │  decrypt → sanitize → validate → rate-limit
                                   ▼
                            EmailProvider.send()  → state=sent
                                   │
                  provider webhook (verified) → delivered | bounced | complained
                                   │
                       hard bounce / complaint ──▶ suppression list
```

Three rules that explain almost every design choice:

1. **Persist before dispatch.** `send()` writes a row, then returns. Nothing is
   sent synchronously. A separate worker sends it later by polling. (No queue is
   written at ingestion — that would risk a dual-write inconsistency.)
2. **The DB is the source of truth.** State lives in Postgres. Workers are
   stateless loops over it. You can run many workers; row claiming prevents
   double-send.
3. **PII is encrypted at rest and matched by HMAC.** The recipient and body are
   sealed; suppression/idempotency-by-recipient use a keyed HMAC of the address,
   never plaintext.

## Install

```bash
npm i @tgoliveira/outpost
# peer deps you actually use:
npm i drizzle-orm                      # if using the Postgres adapter
npm i nodemailer                       # if using the SMTP/Mailpit provider
npm i @opentelemetry/api               # only if enabling OTel telemetry
```

Requires Node ≥ 18.17 (uses global `fetch` and the Web `Request`/`Response`).

## Entry points (subpath exports)

| Import from | What you get |
|---|---|
| `@tgoliveira/outpost` | `createOutpost`, the `Outpost` client, domain types, ports, use cases |
| `@tgoliveira/outpost/adapters` | Providers (Resend/SMTP/Fake), encryptors, HMAC hasher, rate limiters, logger, telemetry, template renderer |
| `@tgoliveira/outpost/drizzle` | `outpostSchema`, `DrizzleOutboxRepository` & friends, `OutpostDb` type |
| `@tgoliveira/outpost/next` | `OutpostRouter` — Fetch-based HTTP handlers for the Next.js App Router |
| `@tgoliveira/outpost/workers` | `SendWorker`, `RetentionWorker` |
| `@tgoliveira/outpost/testing` | In-memory repos, `FakeEmailProvider`, `FakeClock`, `inMemoryRepositories()` |

## Minimal working example (zero infra — for tests / prototypes)

```ts
import { createOutpost } from "@tgoliveira/outpost";
import { inMemoryRepositories, FakeEmailProvider } from "@tgoliveira/outpost/testing";

const outpost = createOutpost({
  repositories: inMemoryRepositories(),
  providers: [new FakeEmailProvider()],
  recipientHmacKey: "a-key-with-at-least-16-bytes-of-entropy",
});

await outpost.send({
  idempotencyKey: "welcome-user-42",   // REQUIRED — dedupes retries
  to: "user@example.com",
  subject: "Welcome",
  html: "<h1>Hi!</h1>",
});

await outpost.tickSend();              // run one send-worker cycle
```

## Production wiring (Postgres + Resend)

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createOutpost } from "@tgoliveira/outpost";
import {
  outpostSchema,
  DrizzleOutboxRepository,
  DrizzleSuppressionRepository,
  DrizzleAuditRepository,
  DrizzleApiKeyRepository,
  DrizzleWebhookEventRepository,
} from "@tgoliveira/outpost/drizzle";
import { ResendEmailProvider } from "@tgoliveira/outpost/adapters";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema: outpostSchema });

export const outpost = createOutpost({
  repositories: {
    outbox: new DrizzleOutboxRepository(db),
    suppressions: new DrizzleSuppressionRepository(db),
    audit: new DrizzleAuditRepository(db),
    apiKeys: new DrizzleApiKeyRepository(db),
    webhookEvents: new DrizzleWebhookEventRepository(db),
  },
  providers: [
    new ResendEmailProvider({
      apiKey: process.env.RESEND_API_KEY!,
      from: "Acme <no-reply@acme.com>",
      webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
    }),
  ],
  recipientHmacKey: process.env.OUTPOST_HMAC_KEY!,   // from your secret manager
  rateLimits: {
    global: { max: 100, windowMs: 1000 },
    perRecipientDomain: { max: 10, windowMs: 1000 },
  },
});
```

Then run the migration (see `docs/database.md`) and start a worker (see below).

## Task recipes

### Send a templated message
```ts
import { InMemoryTemplateRenderer } from "@tgoliveira/outpost/adapters";
const templates = new InMemoryTemplateRenderer([
  { id: "receipt", version: 1, subject: "Receipt {{order}}", html: "<p>Total: {{total}}</p>" },
]);
// pass `templates` to createOutpost, then:
await outpost.send({
  idempotencyKey: "order-1234-receipt",
  to: "customer@example.com",
  template: { id: "receipt", version: 1, vars: { order: "1234", total: "$9.99" } },
});
```
Template variables are HTML-escaped automatically.

### Run the send worker
- **Long-running process** (a worker dyno/container):
  ```ts
  outpost.send_worker.start();   // poll loop; outpost.send_worker.stop() to halt
  ```
- **Serverless / cron** (e.g. Vercel Cron hitting a route every minute):
  ```ts
  export async function GET() { const r = await outpost.tickSend(); return Response.json(r); }
  ```

### Expose the HTTP API in Next.js (App Router)
```ts
// app/api/outpost/messages/route.ts
import { OutpostRouter } from "@tgoliveira/outpost/next";
import { outpost } from "@/lib/outpost";
const router = new OutpostRouter(outpost);
export const POST = (req: Request) => router.enqueue(req);  // scope: messages:send
export const GET  = (req: Request) => router.list(req);     // scope: messages:read
```
Full route table in `docs/nextjs.md`. Every endpoint needs an API key
(`Authorization: Bearer opk_...`) except the webhook sink.

### Receive provider webhooks
```ts
// app/api/outpost/webhooks/[provider]/route.ts
export async function POST(req: Request, { params }: { params: { provider: string } }) {
  return new OutpostRouter(outpost).webhook(req, params.provider);
}
```
The handler reads the **raw body** and verifies the provider signature before
trusting anything. Configure `webhookSecret` on the provider.

### Manage API keys
```ts
const { secret } = await outpost.keys.create({ label: "ci", scopes: ["messages:send"] });
// `secret` is shown ONCE — store it now, it is never recoverable.
await outpost.keys.revoke(keyId);   // takes effect immediately
```

### Manage the suppression list
```ts
await outpost.suppress("user@example.com", "unsubscribe");
await outpost.isSuppressed("user@example.com");  // true
await outpost.unsuppress("user@example.com");
```

### Inspect / replay a dead-lettered message
```ts
const msg = await outpost.get(id);          // { state: "failed", lastError, attempts, ... }
await outpost.replay(id);                    // re-enqueue from the DLQ
```

### Turn on encryption at rest
See `docs/security.md`. Quick reference:
- `encryption: { mode: "symmetric", key: <base64 32 bytes> }` — one key, simplest.
- `encryption: { mode: "asymmetric", publicKey, privateKey }` — least-privilege
  split (web tier seals with public key, worker opens with private key). Omit
  `privateKey` in the web tier so it physically cannot read bodies back.
- Bring-your-own KMS: pass `{ sealEncryptor, openEncryptor }` implementing the
  `Encryptor` port.

## Hard rules / gotchas (read before you ship)

- **`idempotencyKey` is required and is your dedupe key.** Derive it from the
  business event (`order-1234-receipt`), not a random UUID, or retries duplicate.
- **`send()` does not send.** It enqueues. A worker must be running (loop or
  cron) or nothing leaves the building.
- **SMTP has no webhooks.** With the SMTP/Mailpit provider, lifecycle stops at
  `sent` — no `delivered`/`bounced`/`complained`. Use Resend/SES/SendGrid for
  delivery tracking.
- **`recipientHmacKey` is mandatory and must be stable.** Changing it orphans
  every existing suppression entry and breaks recipient lookups. Keep it in a
  secret manager, never in the DB.
- **Encryption at rest is NOT end-to-end.** The provider receives readable
  content. Outpost protects the DB/backups, not the wire to the provider.
- **The retention worker redacts by default**, it does not delete: PII columns
  are wiped, the audit row survives. It only touches terminal rows past the
  webhook window.
- **Delivery semantics.** Idempotency guards prevent duplicate *enqueues* and
  duplicate *dispatch under concurrency*. To survive a worker crashing
  mid-dispatch, a row stuck in `sending` past a lease (default 5 min,
  `staleSendingLeaseMs`) is reclaimed and retried — this is at-least-once at the
  edge. To keep it effectively at-most-once, Outpost passes the message id as the
  provider's idempotency key (e.g. Resend's `Idempotency-Key`), so a reclaim
  cannot double-send through a provider that honors it. Plain SMTP has no such
  key — tune the lease accordingly.
- **Never use `FakeEmailProvider` or `inMemoryRepositories()` in production** —
  they hold everything in RAM and verify nothing.
- **API keys are shown once.** Only a hash is stored; there is no "reveal key".

## Where to look in the source (Clean Architecture, deps point inward)

| Layer | Path | Rule |
|---|---|---|
| Domain (pure) | `src/domain/` | No imports outward. Entities, lifecycle state machine, errors. |
| Ports (interfaces) | `src/ports/` | Imports domain only. The seams to implement. |
| Application (use cases) | `src/application/` | Imports domain + ports. Orchestration + pipeline. |
| Adapters (concrete) | `src/adapters/` | Implement ports. Providers, Drizzle, crypto, rate-limit, OTel. |
| HTTP / Client / Workers | `src/http`, `src/client`, `src/workers` | Edge wiring. |
| Composition root | `src/create-outpost.ts` | The ONLY place adapters are assembled. |

To **add a provider**: implement `EmailProvider` (`src/ports/email-provider.ts`),
pass it in `providers: [...]`. Nothing in the core changes.

To **swap storage**: implement the repository ports
(`src/ports/repositories.ts`). The Drizzle adapter is one implementation.

## Contributing to this repo (agents & humans)

If you are **changing Outpost itself** (not integrating it), read these before
you branch:

- [docs/contributing.md](./docs/contributing.md) — branch/PR workflow, Conventional
  Commits, pre-PR checklist, changelog rules
- [docs/publishing.md](./docs/publishing.md) — **manual-only** npm releases (never
  automatic; user must dispatch the workflow)
- [docs/CURRENT_PRODUCT_SURFACE.md](./docs/CURRENT_PRODUCT_SURFACE.md) — exports,
  routes, and admin UI inventory (update when the surface changes)
- [CHANGELOG.md](./CHANGELOG.md) — note user-visible changes under
  `## [Unreleased]`
- [docs/repo-settings.md](./docs/repo-settings.md) — GitHub branch protection
  and `npmjs` environment gates
- [.cursor/rules/](./.cursor/rules/) — Cursor guardrails when present

Hard rules: branch from `main` with `feature/`/`fix/`/`docs/`/`chore/` prefixes;
no direct commits or pushes to `main` unless the user explicitly asks; commits and
PRs only when the user asks; never run the publish workflow without explicit
approval.

## Verifying your integration

```bash
npm test          # runs the in-memory end-to-end suite (no infra needed)
```
The suite in `test/outpost.test.ts` is also the best worked example of every
flow: ingestion, idempotency, dispatch, retry/DLQ, webhooks, suppression,
encryption round-trips, retention, and auth.
