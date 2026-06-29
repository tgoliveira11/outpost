# ADR 0003: Idempotency key required at ingestion

- Status: Accepted
- Date: 2026-06-29

## Context

Callers retry. A request handler times out, a deploy restarts a process
mid-flight, a client library retries a 500 — and the same logical message gets
enqueued twice. For transactional mail, sending a password reset or a receipt
twice is a visible defect and an abuse vector. Retries are unavoidable, so
deduplication must be a property of the system, not the caller's discipline.

## Decision

`send()` **requires** an `idempotencyKey`. On ingestion, Outpost looks up the
key via `OutboxRepository.findByIdempotencyKey`; a repeat returns the original
message instead of creating a duplicate (backed by a unique constraint on the
column). The guard runs again at dispatch, so concurrent workers or a re-enqueue
cannot double-send. The key is meant to be derived from the business event
(`order-1234-receipt`), not a random UUID — a random key per attempt would
defeat dedupe entirely. This is documented as a hard rule.

## Consequences

- At-most-once delivery under retries: the same business event maps to one
  sent message.
- The dedupe guarantee is honest because it is enforced at both ingestion and
  dispatch, not just optimistically at the edge.
- Cost: the caller must produce a stable, business-meaningful key. A poorly
  chosen key (random per call) silently reintroduces duplicates — a
  documentation/education burden.
- A unique index on `idempotency_key` is required and adds write cost.

## Alternatives considered

- **Optional / server-generated key.** Convenient, but a server-generated key
  cannot dedupe across separate retry attempts (each attempt is a new request).
  Rejected — it would make the at-most-once promise false.
- **Content-hash dedupe only.** Two legitimately distinct messages with
  identical content would collide. An explicit key is more precise.
