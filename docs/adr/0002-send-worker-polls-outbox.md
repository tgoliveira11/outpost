# ADR 0002: Send worker polls the outbox (no dual-write to a queue)

- Status: Accepted
- Date: 2026-06-29

## Context

Given persist-before-dispatch (ADR 0001), something must move messages from
`queued` to the provider. A tempting design is for ingestion to both write the
DB row *and* publish to a message queue. That is a dual write: two systems
updated in two operations with no shared transaction. If the queue publish fails
after the DB commit (or vice versa), the two diverge — a message that exists in
the DB but never on the queue is silently never sent. This is the core hazard
the outbox pattern exists to avoid.

## Decision

The send worker **polls the outbox table** and claims a batch of ready rows
lock-safely, rather than ingestion publishing to a queue. Claiming uses
`SELECT ... FOR UPDATE SKIP LOCKED` semantics so many workers can run
concurrently without double-sending the same row. The queue, if ever introduced,
is transport only — never the source of truth. In code this is the `SendWorker`
loop driving `OutboxRepository.claimBatchForSending(limit)`.

## Consequences

- No dual-write inconsistency: there is exactly one write at ingestion (the DB
  row), and the DB is authoritative.
- Horizontal scaling is free — run N workers; `SKIP LOCKED` partitions the work
  with no coordinator.
- Cost: polling has latency (bounded by the poll interval) and puts steady read
  load on Postgres. For v1's transactional volumes this is acceptable.
- Requires indexes on `state` and `next_attempt_at` to keep the claim query
  cheap.

## Alternatives considered

- **Dual-write to Redis/SQS at ingestion.** Faster pickup, but the dual-write
  inconsistency is exactly the failure mode we are trying to eliminate.
- **Change Data Capture (CDC) off the WAL.** Avoids polling and the dual write,
  but adds heavy infrastructure. Deferred; the polling port can be swapped for a
  CDC-backed one later without touching the core.
