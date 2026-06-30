# Current product surface

> Living inventory of what `@tgoliveira/outpost` ships today. Update this file
> when exports, routes, admin UI, workers, or published artifacts change.
> See [contributing.md](./contributing.md).

Package: `@tgoliveira/outpost` · current version in [`package.json`](../package.json)

## npm subpath exports

| Import | Purpose |
|---|---|
| `@tgoliveira/outpost` | `createOutpost`, `Outpost` client, domain types, use cases |
| `@tgoliveira/outpost/adapters` | Email providers (Resend, SMTP/Mailpit, Fake), encryptors, HMAC, rate limiters, logger, telemetry, template renderer |
| `@tgoliveira/outpost/drizzle` | `outpostSchema`, Drizzle repositories, `OutpostDb` |
| `@tgoliveira/outpost/next` | `OutpostRouter` — Fetch-based HTTP handlers for App Router |
| `@tgoliveira/outpost/admin` | `createOutpostAdmin()` — lazy admin route handlers |
| `@tgoliveira/outpost/react` | Admin UI pages (`AdminPanelPage`, `AdminQueuePage`, `AdminConfigPage`, `AdminObservabilityPage`) |
| `@tgoliveira/outpost/react/client` | Client-only React entry (islands) |
| `@tgoliveira/outpost/styles.css` | Tailwind v4 scan target for admin UI |
| `@tgoliveira/outpost/workers` | `SendWorker`, `RetentionWorker` |
| `@tgoliveira/outpost/testing` | In-memory repos, `FakeEmailProvider`, `FakeClock`, test helpers |

Published tarball includes: `dist/`, `styles.css`, `README.md`, `AGENTS.md`, `LICENSE`.

## HTTP API (`OutpostRouter` / `@tgoliveira/outpost/next`)

Base path in docs: `/api/outpost` (host app chooses the prefix).

| Method | Path | Scope | Notes |
|---|---|---|---|
| `POST` | `/messages` | `messages:send` | Enqueue (202 / 200 deduped) |
| `GET` | `/messages` | `messages:read` | List with filters |
| `GET` | `/messages/:id` | `messages:read` | Single message view (PII-free) |
| `POST` | `/messages/:id/replay` | `messages:replay` | DLQ replay |
| `POST` | `/suppressions` | `suppressions:write` | Add suppression |
| `GET` | `/suppressions/:hash` | `suppressions:read` | Check by recipient HMAC |
| `DELETE` | `/suppressions/:hash` | `suppressions:write` | Remove suppression |
| `POST` | `/webhooks/:provider` | *(signature)* | Provider webhook sink — no API key |

Auth: `Authorization: Bearer opk_...` or `x-outpost-key` (except webhooks).
Details: [api.md](./api.md), [nextjs.md](./nextjs.md).

## Admin API (`@tgoliveira/outpost/admin`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/queue` | Queue listing / filters |
| `POST` | `/admin/worker/send` | Manual send-worker tick |
| `GET` | `/admin/config` | Effective config (admin → env → default) |
| `POST` | `/admin/config` | Set config override |
| `DELETE` | `/admin/config` | Clear override |
| `GET` | `/admin/observability` | Queue depth, last worker run, OTel catalog |

Protected by host-provided `requireAdmin`. See [admin.md](./admin.md).

## Admin UI pages (`@tgoliveira/outpost/react`)

| Component | Typical route | Purpose |
|---|---|---|
| `AdminPanelPage` | `/admin` | Overview |
| `AdminQueuePage` | `/admin/queue` | Queue + run worker |
| `AdminConfigPage` | `/admin/config` | Vault/env overrides |
| `AdminObservabilityPage` | `/admin/observability` | Metrics / depth |

## Workers (`@tgoliveira/outpost/workers`)

| Worker | Role |
|---|---|
| `SendWorker` | Poll outbox, claim rows, dispatch via `EmailProvider` |
| `RetentionWorker` | Redact PII on terminal rows past retention window |

Host runs long-lived loops (`send_worker.start()`) or cron ticks (`tickSend()`).
See [workers.md](./workers.md).

## Email providers (v1 transport)

| Provider | Webhooks | Notes |
|---|---|---|
| Resend | Yes | Production default; provenance-friendly |
| SMTP / Mailpit | No | Lifecycle stops at `sent` |
| Fake | No | Tests only — never in production |

## Database (Drizzle)

Tables via `outpostSchema`: outbox messages, suppressions, audit log, API keys,
webhook events, admin config overrides (`0001` migration). See [database.md](./database.md).

## Programmatic client highlights

`Outpost` methods: `send`, `get`, `list`, `replay`, `suppress` / `unsuppress` /
`isSuppressed`, `keys.create` / `keys.revoke`, `webhook`, `tickSend`,
`send_worker` / `retention_worker` controls. See [api.md](./api.md).

## CI / release tooling (repo only — not published)

| Script / workflow | Role |
|---|---|
| `npm run validate` | Pre-PR and pre-publish gate |
| `npm run audit:security` | Shipped-deps vulnerability gate |
| `.github/workflows/ci.yml` | PR + push to `main` validation |
| `.github/workflows/publish.yml` | **Manual** npm publish + tag + GitHub Release |
