# ADR 0007: Retention = redact PII, keep audit; act on terminal + aged only

- Status: Accepted
- Date: 2026-06-29

## Context

Bodies and recipients are PII; an outbox and audit trail that keep them forever
become a permanent plaintext-PII liability (and at-rest encryption does not
exempt data from expiry). But blindly deleting rows is dangerous: deleting a
message before its webhook window closes breaks bounce/complaint handling and
idempotency, and deleting the audit row destroys the "who did what when" record
that the system exists to provide. Data minimization and auditability pull in
opposite directions and must be reconciled.

## Decision

The retention worker **redacts rather than deletes by default**: it wipes the
PII payload (`*_sealed` columns) while keeping the audit row (metadata + HMAC).
It acts **only on rows in a terminal state that are past both the operational
TTL and the webhook grace window** — never on `sent` alone. Operational and
audit data have independent TTLs. Purges run in **batches** (default 1000) with
pauses to avoid table locks that would starve the send worker. Realized by the
`RetentionPolicy` domain type (`src/domain/retention.ts`, `purgeCutoff` takes the
most conservative of the two cutoffs), the `RetentionWorker`, and
`OutboxRepository.claimTerminalForPurge`. The worker logs how many rows it
touched per cycle.

## Consequences

- PII expires on a policy while the audit trail survives — satisfies
  data-minimization without losing accountability.
- Safe to run concurrently with the send worker: it only ever touches terminal,
  aged rows, never in-flight ones.
- Batched deletes avoid long locks that would block dispatch.
- Per-cycle counts make both failure modes observable: "stopped cleaning" and
  "cleaning too much."
- Cost: redacted rows still occupy storage (audit metadata is retained for its
  own, longer TTL); true deletion requires opting out of `redactOnPurge`.

## Alternatives considered

- **Hard-delete on expiry.** Loses the audit trail and risks purging before the
  webhook window. Rejected as default (available via `redactOnPurge: false`).
- **Never purge (rely on encryption).** Encryption protects at rest but does not
  satisfy data-minimization or limit blast radius over time. Rejected.
