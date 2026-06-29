# ADR 0001: Persist-before-dispatch (transactional outbox)

- Status: Accepted
- Date: 2026-06-29

## Context

The naive pattern — `await provider.send(...)` inside a request handler — loses
the message if the process crashes between the user action and the provider
accepting it, and offers no record that the message ever existed. For
transactional mail (receipts, password resets, invoices) silently dropping a
message is a correctness failure, not a cosmetic one. Durability has to be the
first thing that happens, before any network call that can fail or hang.

## Decision

Ingestion persists the message to the `outbox` table in state `queued` and
returns. Nothing is dispatched synchronously. A separate worker sends it later.
The database is the single source of truth for message state. This is the
classic transactional-outbox pattern: the write that the caller observes as
"accepted" is a committed DB row, not a provider call.

## Consequences

- A crash after `send()` returns cannot lose the message — it is durable in
  Postgres and will be picked up on the next worker cycle.
- Every message has an audit trail and an inspectable lifecycle from the moment
  it is accepted.
- Cost: delivery is asynchronous. `send()` does not mean "sent" — a worker must
  be running (loop or cron) or nothing leaves the building. This is documented
  as a hard rule.
- Adds a polling worker and the operational surface that comes with it.

## Alternatives considered

- **Send synchronously in the handler.** Simplest, but loses messages on crash
  and couples request latency to provider latency. Rejected.
- **Fire-and-forget to a queue from the handler.** Re-introduces the dual-write
  hazard (DB and queue can diverge); addressed separately in ADR 0002.
