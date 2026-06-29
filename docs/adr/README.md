# Architecture Decision Records

This directory records the load-bearing architectural decisions behind Outpost.
They derive from the [Technical Design Record](../tdr.md) — §11 (decision log)
and §5 (security design) are the basis for these records.

## Format

Each ADR is a short, immutable document with a fixed shape:

```
# ADR NNNN: <title>
- Status: Accepted | Superseded | Proposed
- Date: <ISO date>
## Context        — the problem / hazard that forced a choice
## Decision       — what we chose
## Consequences   — the trade-offs that follow, good and bad
## Alternatives considered — what we rejected and why
```

ADRs are append-only: once accepted, a record is not edited in place. If a
decision changes, a new ADR supersedes the old one (and the old one's status is
updated to point at it). Numbers are stable.

## Index

| # | Decision | Realized in |
|---|---|---|
| [0001](./0001-persist-before-dispatch.md) | Persist-before-dispatch (transactional outbox) — `send()` writes a durable row before anything is sent. | `EnqueueMessage` use case, `OutboxRepository.insert` |
| [0002](./0002-send-worker-polls-outbox.md) | The send worker polls the outbox; ingestion never dual-writes to a queue. | `SendWorker` + `OutboxRepository.claimBatchForSending` |
| [0003](./0003-idempotency-key-required.md) | Idempotency key required at ingestion and re-checked at dispatch. | `findByIdempotencyKey`, dispatch idempotency guard |
| [0004](./0004-domain-validation-syntax-mx.md) | Domain validation = syntax + MX only; no mailbox probing. | Domain-validation pipeline stage, `MxResolver` |
| [0005](./0005-encryption-at-rest-not-e2e.md) | Encryption-at-rest (not E2E); keys in KMS; asymmetric least-privilege split. | `HybridSealEncryptor` / `HybridOpenEncryptor`, `AesGcmEncryptor` |
| [0006](./0006-recipient-encrypted-plus-hmac.md) | Recipient stored as encrypted value + searchable keyed HMAC. | `HmacRecipientHasher`, `recipient_hmac` column |
| [0007](./0007-retention-redact-keep-audit.md) | Retention = redact PII, keep audit; act on terminal + aged rows only. | `RetentionPolicy`, `RetentionWorker`, `claimTerminalForPurge` |
| [0008](./0008-channel-agnostic-core-email-only.md) | Channel-agnostic core, email-only in v1. | `EmailProvider` port, channel-agnostic domain |
| [0009](./0009-trusted-publishing-provenance.md) | Trusted publishing (OIDC) + provenance for npm releases. | `publishConfig.provenance`, GitHub Actions OIDC |
