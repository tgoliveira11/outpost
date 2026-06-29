# Observability

> Enabling OpenTelemetry, the spans and metrics Outpost emits, and the append-only audit trail.

Outpost has two complementary observability surfaces: **OpenTelemetry** (spans +
metrics, for live monitoring) and the **audit trail** (an append-only,
durable "who did what when" record in Postgres).

## OpenTelemetry

Telemetry goes through a narrow `Telemetry` port, so the core emits spans and
metrics without importing the OTel SDK. The default is `NoopTelemetry` (it still
runs the wrapped function, so behavior is identical). To enable OTel, pass an
`OtelTelemetry` instance from `@tgoliveira/outpost/adapters`:

```ts
import { createOutpost } from "@tgoliveira/outpost";
import { OtelTelemetry } from "@tgoliveira/outpost/adapters";

const outpost = createOutpost({
  // …
  telemetry: await OtelTelemetry.create(),       // or OtelTelemetry.create("my-service")
});
```

`@opentelemetry/api` is an **optional** peer dependency, imported lazily.
`OtelTelemetry.create()` degrades gracefully to a no-op if the package isn't
installed — so enabling telemetry is safe even before you've added OTel. To
actually export data, install `@opentelemetry/api` and wire your OTel **SDK**
(tracer/meter providers, exporters) in your application; this adapter emits to
whatever global tracer/meter is registered.

```bash
npm i @opentelemetry/api   # plus your OTel SDK + exporters in the app
```

### Spans

Each is a wrapped async operation; errors are recorded and the span status set:

| Span | Wraps |
|---|---|
| `outpost.enqueue` | `EnqueueMessage` — ingestion (validate, dedupe, seal, insert, audit). |
| `outpost.dispatch` | `DispatchMessage` — one message through the send pipeline. |
| `outpost.webhook.ingest` | `IngestWebhook` — verify + apply one provider webhook. |
| `outpost.retention.purge` | `PurgeRetention` — one retention cycle. |

### Counters

| Counter | Emitted when | Attributes |
|---|---|---|
| `outpost.enqueue.queued` | a message is enqueued as `queued` | — |
| `outpost.enqueue.suppressed` | enqueue lands on a suppressed recipient | — |
| `outpost.enqueue.deduplicated` | enqueue hits an existing idempotency key | — |
| `outpost.dispatch.sent` | provider accepts a send | `{ provider }` |
| `outpost.dispatch.retry` | transient failure re-queued with backoff | `{ provider }` |
| `outpost.dispatch.rate_limited` | a rate-limit budget re-queued the message | `{ provider }` |
| `outpost.dispatch.failed` | dead-lettered (permanent / retries exhausted) | `{ provider }` |
| `outpost.suppression.added` | an address is suppressed | `{ reason }` |
| `outpost.webhook.received` | a verified webhook is recorded | `{ provider, type }` |

### Gauges

| Gauge | Emitted | Value |
|---|---|---|
| `outpost.send.claimed` | every send-worker tick | rows claimed this tick |
| `outpost.retention.operational_processed` | every retention cycle | outbox rows redacted/deleted |
| `outpost.retention.audit_deleted` | every retention cycle | audit rows deleted |

> The OTel gauge adapter records gauges as histogram observations. For true
> observable gauges, wire an observable gauge in your SDK against these metric
> names.

### Logging

Separately from telemetry, a structured `Logger` port emits JSON lines. The
default `ConsoleLogger` logs at `info` and above; pass `logger: new NoopLogger()`
(or your own adapter) to redirect.

## The audit trail

The audit trail is the durable record of every meaningful state change, written
to `outpost_audit_events` (see [database.md](./database.md)). It is append-only,
outlives the operational outbox row (longer TTL — `auditTtlDays`, default 365),
and **survives PII redaction**: when retention redacts a message, the audit rows
remain. Each event records `messageId` (null for non-message events), `eventType`,
`actor` (an API key id like `key:<id>`, `provider:<name>`, `admin`,
`programmatic`, or `system:retention`), an optional redactable `detail` blob
(never raw PII), and `at`.

Audit event types (`AuditEventType`):

| Event | Written when |
|---|---|
| `enqueued` | message persisted as `queued` |
| `suppressed` | recipient suppressed (at enqueue, via webhook, or manually) |
| `unsuppressed` | suppression removed |
| `dispatch_started` | dispatch begins |
| `dispatch_accepted` | provider accepted the send |
| `dispatch_failed` | a dispatch failed (also the audit type for a `failed` webhook) |
| `retry_scheduled` | transient failure re-queued with backoff |
| `dead_lettered` | message moved to `failed` (DLQ) |
| `replayed` | a dead-lettered message re-enqueued |
| `webhook_delivered` | `delivered` webhook applied |
| `webhook_bounced` | `bounced` webhook applied |
| `webhook_complained` | `complained` webhook applied |
| `webhook_opened` | `opened` webhook recorded |
| `redacted` | retention redacted a batch of PII |
| `purged` | retention deleted a batch (when `redactOnPurge: false`) |
| `key_created` | an API key was created |
| `key_revoked` | an API key was revoked |

Read a message's timeline programmatically:

```ts
const events = await outpost.deps.audit.listForMessage(messageId);
```

Counts per retention cycle are also logged (`info`), so operators can detect
"stopped cleaning" or "cleaning too much". See [workers.md](./workers.md).
