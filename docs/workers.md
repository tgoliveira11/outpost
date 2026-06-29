# Workers

> The SendWorker and RetentionWorker: long-running loops vs. cron ticks, their options, why concurrent workers are safe, and a Vercel Cron example.

Outpost separates *enqueue* from *send*. `outpost.send()` only persists a row;
the **SendWorker** is what actually delivers it. The **RetentionWorker** enforces
data minimization on aged terminal rows. Both are exported from
`@tgoliveira/outpost/workers` and are also reachable on the client as
`outpost.send_worker` and `outpost.retention_worker`.

> If no send worker is running (loop or cron tick), nothing leaves the building —
> messages just sit in `queued`.

## Two deployment shapes

Both workers expose the same surface: a long-running `start()` / `stop()` loop,
and a single `tick()` for cron / route-handler deployments.

### 1. Long-running loop (worker dyno / container)

```ts
import { outpost } from "@/lib/outpost";

outpost.send_worker.start();        // poll loop
outpost.retention_worker.start();   // hourly loop

// graceful shutdown:
process.on("SIGTERM", () => {
  outpost.send_worker.stop();       // in-flight dispatches finish; no new tick starts
  outpost.retention_worker.stop();
});
```

`start()` is idempotent (a second call is a no-op while running). `stop()` clears
the timer; in-flight dispatches complete but no new tick begins.

### 2. Cron / route handler (serverless)

Call `tick()` (or the client conveniences `tickSend()` / `tickRetention()`) once
per invocation:

```ts
// app/api/cron/outpost-send/route.ts
import { outpost } from "@/lib/outpost";
export const runtime = "nodejs";

export async function GET() {
  const report = await outpost.tickSend(); // { claimed, outcomes }
  return Response.json(report);
}
```

`tickSend()` returns a `SendTickReport`: `{ claimed: number, outcomes: DispatchOutcome[] }`.
Each outcome is one of `{ kind: "sent" }`, `{ kind: "retry" }`,
`{ kind: "rate_limited" }`, `{ kind: "failed" }`, `{ kind: "skipped" }`.
`tickRetention()` returns a `PurgeReport`:
`{ operationalProcessed, auditDeleted, redacted }`.

## SendWorker options

`new SendWorker(deps, options?)` — the client constructs one with defaults; supply
options only when constructing your own.

| Option | Default | Description |
|---|---|---|
| `intervalMs` | `1000` | Poll interval for the long-running loop. |
| `batchSize` | `config.sendBatchSize` (default `50`) | Max messages claimed per tick. |
| `concurrency` | `10` | Max concurrent dispatches within a tick. |

```ts
import { SendWorker } from "@tgoliveira/outpost/workers";
const worker = new SendWorker(outpost.deps, { intervalMs: 500, batchSize: 100, concurrency: 20 });
worker.start();
```

Within a tick, the worker claims up to `batchSize` rows and dispatches them with
bounded `concurrency`; a single message that throws unexpectedly is caught and
logged so it can't kill the whole tick.

## Why concurrent workers are safe

The SendWorker polls the outbox and claims a batch with
`SELECT … FOR UPDATE SKIP LOCKED` inside a transaction, immediately flipping the
claimed rows to `sending`. Two workers polling at the same instant skip each
other's locked rows, so **no two workers ever process the same message** — you
can scale horizontally just by running more instances. Eligibility:

- state is `queued`,
- `next_attempt_at <= now` (backoff has elapsed),
- `scheduled_for` is null or in the past.

Rows are claimed oldest-`next_attempt_at`-first.

> The default `InMemoryRateLimiter` is per-process. If you run multiple send
> workers and need shared rate limits, implement the `RateLimiter` port against
> Redis. See [configuration.md](./configuration.md#rate-limits-ratelimitconfig).

## RetentionWorker

`new RetentionWorker(deps, options?)`.

| Option | Default | Description |
|---|---|---|
| `intervalMs` | `3_600_000` (1 hour) | Loop interval. Retention is not latency-sensitive. |

The worker runs `PurgeRetention`, governed by the `retention` config (see
[configuration.md](./configuration.md#retention)). It is deliberately
conservative:

- It only ever touches rows in a **terminal** state (`delivered`, `bounced`,
  `complained`, `failed`, `suppressed`) that are **aged** past
  `operationalTtlDays` **and** past the `webhookWindowHours` grace window — so it
  never races the send worker and never purges a row before late
  delivery/bounce webhooks can arrive (the purge cutoff is the more conservative
  of the two).
- By **default it redacts, not deletes** (`redactOnPurge: true`): PII columns are
  overwritten with a `{ alg: "redacted" }` tombstone while the row, its metadata,
  and the recipient HMAC survive — satisfying data minimization without
  destroying the audit trail. Set `redactOnPurge: false` to hard-delete.
- Redaction is idempotent (already-redacted rows are skipped) and runs in
  batches of `batchSize` to keep table locks short.
- Audit events have an independent, longer TTL (`auditTtlDays`, default 365) and
  are deleted separately.

## Vercel Cron example

Define two cron routes and schedule them in `vercel.json`. Both must run on the
Node.js runtime (`node:crypto` is used):

```ts
// app/api/cron/outpost-send/route.ts
import { outpost } from "@/lib/outpost";
export const runtime = "nodejs";
export async function GET() {
  return Response.json(await outpost.tickSend());
}
```

```ts
// app/api/cron/outpost-retention/route.ts
import { outpost } from "@/lib/outpost";
export const runtime = "nodejs";
export async function GET() {
  return Response.json(await outpost.tickRetention());
}
```

```json
// vercel.json
{
  "crons": [
    { "path": "/api/cron/outpost-send", "schedule": "* * * * *" },
    { "path": "/api/cron/outpost-retention", "schedule": "0 * * * *" }
  ]
}
```

Protect cron routes (e.g. verify a Vercel cron secret header) so they aren't
publicly triggerable. See [nextjs.md](./nextjs.md) for the rest of the App
Router wiring.
