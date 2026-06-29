# Outpost

**A transactional outbox with pluggable transport for Next.js.**
Durable, at-most-once, fully auditable transactional email — with the sending
provider as a swappable detail.

[![provenance](https://img.shields.io/badge/npm-provenance-blue)](https://docs.npmjs.com/generating-provenance-statements)

```ts
import { createOutpost } from "@tgoliveira/outpost";

await outpost.send({
  idempotencyKey: "order-1234-receipt",   // dedupes retries
  to: "customer@example.com",
  template: { id: "receipt", version: 3, vars: { name, total } },
});
```

Outpost is **not an email client**. Libraries already send email. Outpost
guarantees a message is **never lost, delivered at-most-once, fully auditable,
and provider-independent**. It persists every message before dispatch, processes
it through a controlled pipeline (sanitization, rate limiting, domain
validation, encryption-at-rest), tracks its lifecycle via provider webhooks,
enforces a suppression list, and redacts/retains data per policy.

> 🤖 **Integrating with an AI agent?** Read **[AGENTS.md](./AGENTS.md)** — it's
> the fastest path to working code.

## Why

A naive `await resend.send(...)` in a request handler can: send twice on retry,
lose the message if the process dies, keep mailing addresses that hard-bounced
(burning your sender reputation), and leave no audit trail. Outpost fixes all
four by making the **database the source of truth** and the **send a separate,
idempotent, observable step**.

## Features (v1)

- ✅ **Durable outbox** — persist-before-dispatch; survives crashes.
- ✅ **At-most-once** — idempotency key required at ingestion, re-checked at dispatch.
- ✅ **Pluggable transport** — Resend, generic SMTP/Mailpit, in-memory fake; one `EmailProvider` interface.
- ✅ **Lifecycle tracking** — `queued → sending → sent → delivered | bounced | complained | failed` via verified webhooks.
- ✅ **Suppression list** — hard bounces & complaints auto-suppress; matched by keyed HMAC.
- ✅ **Retry + Dead Letter Queue** — exponential backoff with jitter; inspect & replay failures.
- ✅ **Encryption at rest** — optional AES-256-GCM (symmetric) or RSA-hybrid (asymmetric, least-privilege split). Keys live in KMS, not the DB.
- ✅ **Append-only audit trail + OpenTelemetry** — on by default.
- ✅ **Configurable retention** — redact PII, keep audit; batched, terminal-rows-only.
- ✅ **Authenticated API** — opaque keys with scopes, expiry, and immediate revocation.
- ✅ **Clean Architecture + SOLID** — testable core, swappable everything.

See [the design record](./docs/tdr.md) for scope, security model, and non-goals.

## Quick start

```bash
npm i @tgoliveira/outpost drizzle-orm pg
```

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createOutpost } from "@tgoliveira/outpost";
import { outpostSchema, DrizzleOutboxRepository, DrizzleSuppressionRepository,
         DrizzleAuditRepository, DrizzleApiKeyRepository,
         DrizzleWebhookEventRepository } from "@tgoliveira/outpost/drizzle";
import { ResendEmailProvider } from "@tgoliveira/outpost/adapters";

const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), { schema: outpostSchema });

export const outpost = createOutpost({
  repositories: {
    outbox: new DrizzleOutboxRepository(db),
    suppressions: new DrizzleSuppressionRepository(db),
    audit: new DrizzleAuditRepository(db),
    apiKeys: new DrizzleApiKeyRepository(db),
    webhookEvents: new DrizzleWebhookEventRepository(db),
  },
  providers: [new ResendEmailProvider({
    apiKey: process.env.RESEND_API_KEY!,
    from: "Acme <no-reply@acme.com>",
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
  })],
  recipientHmacKey: process.env.OUTPOST_HMAC_KEY!,
});
```

1. Generate & run the DB migration → [docs/database.md](./docs/database.md).
2. Wire the HTTP routes → [docs/nextjs.md](./docs/nextjs.md).
3. Run the send worker → [docs/workers.md](./docs/workers.md).

## Documentation

| Doc | What's in it |
|---|---|
| **[AGENTS.md](./AGENTS.md)** | Agent-first integration guide + task recipes |
| [docs/getting-started.md](./docs/getting-started.md) | End-to-end setup, dev with Mailpit |
| [docs/architecture.md](./docs/architecture.md) | Clean Architecture layers, ports, SOLID |
| [docs/configuration.md](./docs/configuration.md) | Every `createOutpost` option |
| [docs/api.md](./docs/api.md) | Programmatic + HTTP API reference |
| [docs/providers.md](./docs/providers.md) | Provider adapters & writing your own |
| [docs/security.md](./docs/security.md) | Encryption, keys, webhooks, threat model |
| [docs/database.md](./docs/database.md) | Schema, migrations, indexing |
| [docs/nextjs.md](./docs/nextjs.md) | App Router route wiring |
| [docs/workers.md](./docs/workers.md) | Send & retention workers; deployment shapes |
| [docs/observability.md](./docs/observability.md) | OpenTelemetry & the audit trail |
| [docs/testing.md](./docs/testing.md) | In-memory repos, fakes, deterministic clock |
| [docs/adr/](./docs/adr/) | Architecture Decision Records |

## Status

v1 ships email only; the core is channel-agnostic by design. Phase 2 adds
automatic provider fallback, more adapters (SES/SendGrid/Postmark), scheduling,
template versioning, and a second transport to validate the abstraction.

## License

MIT
