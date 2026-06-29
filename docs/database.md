# Database

> The five-table Postgres schema, the indexes and why each exists, and how to generate and run migrations with drizzle-kit.

Outpost is database-of-record: the outbox table is the source of truth, and the
workers are stateless loops over it. Persistence ships as a Drizzle/Postgres
adapter (`@tgoliveira/outpost/drizzle`) that implements the repository ports. You
own the migration — Outpost provides the schema (`outpostSchema`), you generate
SQL from it with drizzle-kit and apply it.

## Schema overview

Five tables (all prefixed `outpost_`), defined in
`src/adapters/drizzle/schema.ts`:

| Table | Purpose |
|---|---|
| `outpost_outbox` | The messages and their lifecycle state. |
| `outpost_audit_events` | Append-only audit trail. |
| `outpost_suppressions` | Reputation guardrail, keyed by recipient HMAC. |
| `outpost_webhook_events` | Raw verified provider webhooks. |
| `outpost_api_keys` | Authenticated API keys (hashes only). |

Two Postgres enums back the typed columns: `outpost_lifecycle_state` and
`outpost_suppression_reason`.

> **PII is encrypted at rest in JSONB.** The recipient and body live in
> `recipient_sealed` / `body_sealed` as a `Sealed` envelope (JSONB) — ciphertext
> when encryption is on, base64 plaintext (`alg: "plain"`) otherwise, so the
> column shape never changes. Index columns (`state`, `next_attempt_at`,
> `recipient_hmac`, `idempotency_key`) stay clear so polling and suppression
> lookups keep working. See [security.md](./security.md).

### `outpost_outbox`

Key columns: `id` (uuid PK), `idempotency_key` (text), `state`
(`outpost_lifecycle_state`, default `queued`), `recipient_hmac` (text),
`recipient_sealed` / `body_sealed` (jsonb `Sealed`), `subject` (text),
`template_id` / `template_version`, `provider` (text), `metadata` (jsonb),
`attempts` (int), `next_attempt_at` (timestamptz), `scheduled_for` (timestamptz,
nullable), `provider_message_id` (text, nullable), `last_error` (text, nullable),
`created_at`, `updated_at`.

| Index | Columns | Why it exists |
|---|---|---|
| `outpost_outbox_idempotency_key_uq` (unique) | `idempotency_key` | Enforces at-most-once: a repeated key is deduped at enqueue. |
| `outpost_outbox_poll_idx` | `(state, next_attempt_at)` | **Drives the send worker's claim query** — find `queued` rows whose backoff has elapsed, cheaply. |
| `outpost_outbox_recipient_hmac_idx` | `recipient_hmac` | Recipient lookups / `list({ recipientHmac })` without exposing plaintext. |
| `outpost_outbox_provider_message_id_idx` | `provider_message_id` | **Webhook correlation** — map an inbound webhook back to its outbox row by the provider's message id. |

### `outpost_audit_events`

Append-only "who did what when". Columns: `id` (uuid PK), `message_id` (uuid,
nullable — null for non-message events like `key_created`), `event_type` (text),
`actor` (text), `detail` (jsonb, nullable — redactable, never raw PII bodies),
`at` (timestamptz).

| Index | Columns | Why |
|---|---|---|
| `outpost_audit_message_id_idx` | `message_id` | Fetch the timeline for one message. |
| `outpost_audit_at_idx` | `at` | Batched retention deletes by age. |

### `outpost_suppressions`

Keyed by HMAC so it keeps working under encryption. Columns: `recipient_hmac`
(text **PK**), `reason` (`outpost_suppression_reason`), `created_by` (text),
`note` (text, nullable), `created_at` (timestamptz). The HMAC primary key is the
suppression lookup index — `isSuppressed(hmac)` is a single primary-key probe,
and inserts are idempotent (`ON CONFLICT DO NOTHING`).

### `outpost_webhook_events`

Raw verified events, retained for traceability/replay. Columns: `id` (uuid PK),
`provider` (text), `type` (text), `provider_message_id` (text), `recipient`
(text, nullable), `is_hard_bounce` (boolean, nullable), `occurred_at`
(timestamptz, nullable), `raw` (jsonb), `received_at` (timestamptz).

| Index | Columns | Why |
|---|---|---|
| `outpost_webhook_provider_message_id_idx` | `provider_message_id` | Correlate stored webhooks to messages. |

### `outpost_api_keys`

Columns: `id` (uuid PK), `label` (text), `key_hash` (text), `scopes` (jsonb
`ApiScope[]`), `expires_at` (timestamptz, nullable), `revoked_at` (timestamptz,
nullable), `created_at`, `last_used_at` (timestamptz, nullable). Only the hash is
stored — the plaintext secret is shown once at creation.

| Index | Columns | Why |
|---|---|---|
| `outpost_api_keys_key_hash_uq` (unique) | `key_hash` | O(1) auth lookup by hashed secret; uniqueness guards against collisions. |

## Drizzle config

Point `drizzle.config.ts` at the package's schema module so drizzle-kit can
introspect `outpostSchema`:

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // The compiled schema shipped in the package:
  schema: "./node_modules/@tgoliveira/outpost/dist/adapters/drizzle/schema.js",
  out: "./drizzle/outpost",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

> If you prefer to keep the schema in your own source tree, re-export it from a
> local file and point `schema` there:
>
> ```ts
> // db/outpost-schema.ts
> export { outpostSchema, outbox, auditEvents, suppressions, webhookEvents, apiKeys } from "@tgoliveira/outpost/drizzle";
> ```

## Generate & run the migration

```bash
npx drizzle-kit generate   # emit SQL migration files from the schema into ./drizzle/outpost
npx drizzle-kit migrate    # apply pending migrations to DATABASE_URL
```

Inspect the generated SQL before applying it in production, and run it inside
your normal migration workflow. Construct the repositories with the same db
instance used for `drizzle(client, { schema: outpostSchema })`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { outpostSchema, DrizzleOutboxRepository /* … */ } from "@tgoliveira/outpost/drizzle";

const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), { schema: outpostSchema });
```

The `OutpostDb` type is driver-agnostic (`drizzle-orm/node-postgres`,
`postgres-js`, Neon, etc.) — the repositories use only the dialect-level query
builder. See [getting-started.md](./getting-started.md) for the full wiring and
[configuration.md](./configuration.md#retention) for how retention prunes these
tables.
