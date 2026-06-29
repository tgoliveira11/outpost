# Getting started

> Install Outpost, send your first message in-memory, then wire up Postgres + Resend and run a worker.

`@tgoliveira/outpost` is a transactional email outbox: it persists every message
before dispatch, sends it through a separate idempotent worker, tracks its
lifecycle via provider webhooks, and keeps an audit trail. This guide takes you
from `npm i` to a working production setup.

## Requirements

- **Node ≥ 18.17.0** — Outpost uses the global `fetch` and the Web
  `Request`/`Response` (no SDK polyfills).
- A **Postgres** database for production (the Drizzle adapter). Tests and
  prototypes can run fully in memory with no database.

## Install

```bash
npm i @tgoliveira/outpost
```

Peer dependencies are installed only for the pieces you use:

| Peer dep | When you need it | Optional? |
|---|---|---|
| `drizzle-orm` | Postgres persistence (`@tgoliveira/outpost/drizzle`) | required for the Drizzle adapter |
| `pg` (or another driver) | a Postgres client for Drizzle | required for the Drizzle adapter |
| `nodemailer` | the SMTP / Mailpit provider | optional, lazy-imported |
| `@opentelemetry/api` | OpenTelemetry telemetry | optional, lazy-imported |

```bash
# Postgres adapter:
npm i drizzle-orm pg
# SMTP / Mailpit provider:
npm i nodemailer
# OpenTelemetry (only if enabling OTel):
npm i @opentelemetry/api
```

## Entry points

Outpost ships as subpath exports so you only pull in what you import:

| Import from | What you get |
|---|---|
| `@tgoliveira/outpost` | `createOutpost`, the `Outpost` client, domain types, ports, use cases |
| `@tgoliveira/outpost/adapters` | Providers, encryptors, HMAC hasher, rate limiters, logger, telemetry, template renderer |
| `@tgoliveira/outpost/drizzle` | `outpostSchema`, the Drizzle repositories, `OutpostDb` type |
| `@tgoliveira/outpost/next` | `OutpostRouter` — Fetch-based HTTP handlers |
| `@tgoliveira/outpost/workers` | `SendWorker`, `RetentionWorker` |
| `@tgoliveira/outpost/testing` | `inMemoryRepositories`, `FakeEmailProvider`, `FakeClock` |

## Quickstart (zero infra)

For tests and prototypes, run Outpost entirely in memory — no database, no real
email:

```ts
import { createOutpost } from "@tgoliveira/outpost";
import { inMemoryRepositories, FakeEmailProvider } from "@tgoliveira/outpost/testing";

const outpost = createOutpost({
  repositories: inMemoryRepositories(),
  providers: [new FakeEmailProvider()],
  recipientHmacKey: "a-key-with-at-least-16-bytes-of-entropy",
});

// 1. Enqueue (persist-then-queue). This does NOT send.
await outpost.send({
  idempotencyKey: "welcome-user-42", // REQUIRED — dedupes retries
  to: "user@example.com",
  subject: "Welcome",
  html: "<h1>Hi!</h1>",
});

// 2. Run one send-worker cycle. Now it sends.
await outpost.tickSend();
```

> `send()` only persists the message. A worker (loop or `tickSend()`) is what
> actually dispatches it. `recipientHmacKey` is required even with encryption off
> — it backs suppression matching. It must be ≥16 bytes and stable.

> Never use `FakeEmailProvider` or `inMemoryRepositories()` in production — they
> hold everything in RAM and verify nothing.

## Production setup (Postgres + Resend)

```ts
// lib/outpost.ts
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
  recipientHmacKey: process.env.OUTPOST_HMAC_KEY!, // from your secret manager
  rateLimits: {
    global: { max: 100, windowMs: 1000 },
    perRecipientDomain: { max: 10, windowMs: 1000 },
  },
});
```

See [configuration.md](./configuration.md) for every `createOutpost` option,
[providers.md](./providers.md) for provider options, and
[security.md](./security.md) for encryption at rest.

### 1. Run the migration

Outpost ships a Drizzle schema (`outpostSchema`); you generate and apply a
migration from it. Full details — including a `drizzle.config.ts` example — are
in [database.md](./database.md). In short:

```bash
npx drizzle-kit generate   # emit SQL from the schema
npx drizzle-kit migrate    # apply it to DATABASE_URL
```

### 2. Start a worker

The send worker is what actually delivers queued messages. Two shapes (see
[workers.md](./workers.md)):

```ts
// Long-running process (worker dyno/container):
outpost.send_worker.start();   // poll loop; outpost.send_worker.stop() to halt

// Serverless / cron (e.g. a Vercel Cron hitting a route every minute):
export async function GET() {
  const report = await outpost.tickSend();
  return Response.json(report);
}
```

### 3. Send your first message

```ts
import { outpost } from "@/lib/outpost";

await outpost.send({
  idempotencyKey: "order-1234-receipt", // derive from the business event
  to: "customer@example.com",
  subject: "Your receipt",
  html: "<p>Thanks for your order.</p>",
});
```

With the send worker running, the message moves `queued → sending → sent`, and
(with a webhook-capable provider like Resend) `→ delivered | bounced | complained`
once the provider calls back. Wire the HTTP routes — including the webhook sink —
per [nextjs.md](./nextjs.md).

## Local development with Mailpit

[Mailpit](https://github.com/axllent/mailpit) is a local SMTP sink with a web UI.
Point the SMTP provider at it to develop without sending real mail:

```bash
# Mailpit defaults: SMTP on :1025, web UI on :8025
docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
npm i nodemailer   # SMTP provider peer dep
```

```ts
import { SmtpEmailProvider } from "@tgoliveira/outpost/adapters";

const mailpit = new SmtpEmailProvider({
  name: "mailpit",
  host: "localhost",
  port: 1025,
  secure: false,
  from: "Dev <dev@localhost>",
});

const outpost = createOutpost({
  repositories: inMemoryRepositories(), // or your Drizzle repos
  providers: [mailpit],
  recipientHmacKey: "dev-key-at-least-16-bytes-long",
});

await outpost.send({ idempotencyKey: "dev-1", to: "you@example.com", subject: "Hi", text: "test" });
await outpost.tickSend();
// Open http://localhost:8025 to see the captured message.
```

> SMTP has **no delivery webhooks** — lifecycle stops at `sent`. There is no
> `delivered`/`bounced`/`complained` over plain SMTP. Use Resend/SES/SendGrid for
> delivery tracking. See [providers.md](./providers.md).

## Verify it works

The package includes an in-memory end-to-end suite that needs no infrastructure:

```bash
npm test
```

`test/outpost.test.ts` is also the best worked example of every flow: ingestion,
idempotency, dispatch, transient retry, permanent dead-letter, DLQ replay, webhook
lifecycle, suppression feedback, symmetric/asymmetric encryption round-trips,
retention redaction, and API-key auth. See [testing.md](./testing.md) to write
your own deterministic tests.

## Next steps

- [architecture.md](./architecture.md) — how the layers fit together
- [configuration.md](./configuration.md) — every option
- [api.md](./api.md) — programmatic + HTTP API reference
- [nextjs.md](./nextjs.md) — App Router route wiring
- [workers.md](./workers.md) — deployment shapes
- [observability.md](./observability.md) — OpenTelemetry + audit trail
