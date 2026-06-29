# Technical Design Record: Outpost

**A transactional outbox with pluggable transport for Next.js**

| Field | Value |
|---|---|
| Document type | Technical Design Record (TDR) |
| Status | Draft — for review |
| Package name | `outpost` (scoped, e.g. `@tgoliveira/outpost`) |
| Version target | 1.0.0 |
| Tech stack | Next.js, Drizzle ORM, PostgreSQL, SMTP/provider adapters |
| Author | Engineering |
| Last updated | 2026-06-29 |

---

## 1. Summary

Outpost is **not an email client**. It is a **transactional outbox with a pluggable transport layer**, delivered as an npm package that any Next.js application can consume. Email is the first — and, in v1, only — transport. The architecture is deliberately channel-agnostic at its core so that SMS, push, or webhooks can be added later without redesign, but v1 ships email only to avoid premature abstraction.

The value of Outpost is not "sending email" (libraries already do that). The value is **guaranteeing that a message is never lost, is delivered at-most-once, is fully auditable, and that the sending provider is a swappable detail.** Outpost persists every message before it is dispatched, processes it through a controlled outbound pipeline (sanitization, rate limiting, domain validation, encryption-at-rest), tracks its full lifecycle via provider webhooks, enforces a suppression list, and retains or redacts data according to a configurable policy. It ships with observability and audit enabled by default and an administration panel for operators.

This document specifies the functional scope, the security model, the public API surface, the data model, the architecture (Clean Architecture + SOLID), and a two-phase implementation plan.

---

## 2. Goals and non-goals

### 2.1 Goals

- Durable, at-most-once delivery of transactional email via a persisted outbox.
- A provider-agnostic transport abstraction (Mailpit/SMTP for dev; Resend, SendGrid, Postmark, AWS SES, generic SMTP for prod).
- Full message lifecycle tracking driven by provider webhooks (delivered, bounced, complained).
- Automatic suppression list management fed by hard bounces and complaints.
- Idempotent ingestion (no duplicate sends under retry).
- Configurable encryption-at-rest of message payload (body + recipient).
- Observability (OpenTelemetry traces/metrics) and an append-only audit trail, on by default.
- A configurable retention/purge worker enforcing data-minimization.
- Authenticated API surface: every call requires an API key that can be expired/revoked from the admin panel.
- An administration panel for operators (message inspection, key management, suppression list, retry/replay).
- Clean Architecture boundaries and SOLID throughout, so the core is testable and the transport/storage are swappable.

### 2.2 Non-goals (v1)

- **Not** end-to-end encryption against the email provider. The provider necessarily receives readable content; Outpost provides encryption *at rest*, not E2E. This boundary is stated explicitly to avoid a false privacy promise.
- **Not** a marketing/bulk email platform. Outpost targets transactional messages. Marketing-specific concerns (campaigns, segmentation, large-list compliance) are out of scope.
- **Not** mailbox-level address verification. Outpost validates syntax and MX records only; it does not probe whether an individual mailbox exists (unreliable and reputation-damaging).
- **Not** multi-channel in v1. SMS/push/webhook transports are deferred to a future major version; only the *core* is built channel-agnostic.
- **Not** a deliverability guarantee. Outpost reduces obvious errors and protects sender reputation; it cannot guarantee inbox placement.

---

## 3. Functional requirements

### 3.1 Message ingestion

- A consuming application enqueues a message via the public API. The message is **persisted to the outbox table before anything else happens** (durability is the first principle).
- Ingestion accepts an **idempotency key** (caller-supplied or derived from content). A repeated enqueue with the same key returns the original message rather than creating a duplicate.
- On ingestion, the recipient is checked against the **suppression list**; suppressed recipients are recorded as `suppressed` and never dispatched.
- Payload (body + recipient) MAY be encrypted at rest at this stage (see §5.4).

### 3.2 Outbound pipeline (the send worker)

A worker polls the outbox for messages in a non-terminal, ready state and processes each through the pipeline:

1. **Idempotency guard** — re-check the idempotency key to avoid double-send under concurrent workers or retries.
2. **Sanitization** — HTML sanitization (anti-XSS), header-injection prevention (reject CRLF in To/Subject/headers), size limits, attachment validation (MIME type + size).
3. **Domain validation** — syntax validation (always) + MX record check (optional, cached). No mailbox probing.
4. **Rate limiting** — layered: per provider, per recipient domain, and global.
5. **Decryption** — if payload is encrypted, decrypt *only here*, in the send worker, immediately before dispatch (see §5.4).
6. **Dispatch** — hand the message to the selected `EmailProvider` adapter.
7. **State transition** — update lifecycle state and write an audit event.

### 3.3 Message lifecycle

```
                 ┌─────────────┐
   enqueue ─────▶│   queued    │
                 └──────┬──────┘
                        │ picked up by send worker
                        ▼
                 ┌─────────────┐   suppressed recipient
                 │  sending    │──────────────────────────▶┌────────────┐
                 └──────┬──────┘                            │ suppressed │
                        │ provider accepted                 └────────────┘
                        ▼
                 ┌─────────────┐
                 │    sent     │   (accepted by provider, not yet confirmed)
                 └──────┬──────┘
                        │ webhook ingestion
            ┌───────────┼───────────┬──────────────┐
            ▼           ▼           ▼              ▼
     ┌───────────┐┌──────────┐┌────────────┐┌──────────┐
     │ delivered ││ bounced  ││ complained ││  failed  │
     └───────────┘└──────────┘└────────────┘└──────────┘
                       │            │
                       └────────────┴──▶ feed suppression list (hard bounce / complaint)

  Transient error during dispatch → retry with exponential backoff + jitter
  Permanent error OR retries exhausted → failed (terminal) → Dead Letter Queue
```

- `queued → sending → sent` is the happy path through dispatch.
- `sent` means *accepted by the provider*, not *delivered*. Delivery confirmation arrives asynchronously via webhook.
- `delivered | bounced | complained | failed | suppressed` are terminal states.
- **Hard bounces and complaints automatically feed the suppression list.**

### 3.4 Retry policy and Dead Letter Queue

- Errors are classified as **transient** (timeout, 429, provider 5xx → retry with exponential backoff + jitter) or **permanent** (invalid address, content rejected → no retry, straight to failed).
- After exhausting the configured retry budget, a message enters `failed` (terminal) and is recorded in a **Dead Letter Queue** — inspectable and manually re-enqueueable from the admin panel.

### 3.5 Webhook ingestion (the webhook worker)

- A dedicated endpoint/worker ingests provider webhooks (delivered, bounced, complained, opened).
- Webhook payloads are verified (signature/secret per provider) before being trusted.
- Events update the corresponding message's lifecycle state and append an audit event.
- Hard bounces and complaints write to the suppression list.

### 3.6 Suppression list

- A table of addresses that must never receive email: hard bounces, complaints, unsubscribes, known-invalid addresses.
- Every outbound message is checked against it before dispatch.
- Because the recipient may be encrypted at rest, suppression matching uses a **searchable keyed HMAC of the address**, not the plaintext (see §5.4).
- Manageable from the admin panel (view, add, remove with reason and audit trail).

### 3.7 Templating

- Transactional messages are typically template-based with variables.
- Templates are versioned. Variable interpolation **escapes/sanitizes user-supplied data** to prevent injection.

### 3.8 Provider adapters

- A single `EmailProvider` interface with multiple implementations: Mailpit/SMTP (dev), Resend, SendGrid, Postmark, AWS SES, generic SMTP (prod).
- The environment selects the adapter via configuration.
- The interface is designed from day one to permit **provider fallback** (failover from a failing provider to a backup), even though automatic fallback ships in Phase 2.
- A test/in-memory fake adapter is provided for CI.

### 3.9 Retention / purge worker

- A worker enforces the retention policy: it acts on messages in a **terminal state, older than a configurable age, after the webhook window has closed** — never on `sent` alone (which would break bounce/complaint handling and idempotency).
- Default behavior is **redaction, not blind deletion**: the PII payload (encrypted body, encrypted recipient) is purged while the audit row (metadata + HMAC hash) is preserved. This satisfies data-minimization while keeping the audit trail.
- Operational data (short TTL) and audit data (longer TTL) have independent retention configuration.
- Deletes run in **batches** (e.g. 1,000 rows with pauses) to avoid table locks that would starve the send worker. The worker never touches non-terminal rows.
- The worker logs how many rows it purged/redacted per cycle (observability: detect both "stopped cleaning" and "cleaning too much").

### 3.10 Email authentication awareness

- Outpost does not configure DNS, but it documents and provides a **health check** that validates the sending domain has SPF / DKIM / DMARC configured, because their absence collapses deliverability.

### 3.11 Compliance

- Outpost handles `List-Unsubscribe` headers and respects the legal boundary between transactional and marketing email (treated differently under CAN-SPAM, LGPD, GDPR).
- PII handling: bodies and recipient addresses are PII. The audit trail and logs must not become a permanent plaintext PII store — hence configurable retention, redaction, and at-rest encryption.

### 3.12 Administration panel

- Operator-facing UI providing: message search and inspection (respecting encryption — operators see metadata; body access is gated and audited), lifecycle status, DLQ inspection and replay, suppression list management, **API key management (create, label, expire, revoke)**, retention policy configuration, and observability dashboards (throughput, success/bounce/complaint rates, queue depth).

---

## 4. API surface (for the consuming application)

All API calls are authenticated (see §5.1). The package exposes both a typed programmatic client (for server-side use within the same app) and HTTP endpoints (for cross-service use). Shapes below are illustrative and language-level (TypeScript), not final signatures.

### 4.1 Authentication

Every request carries an API key in the `Authorization: Bearer <key>` header (or `x-outpost-key`). Keys are created, labeled, and **expired/revoked from the admin panel**. A request with a missing, expired, or revoked key is rejected with `401`.

### 4.2 Core endpoints / client methods

| Operation | HTTP | Client method | Notes |
|---|---|---|---|
| Enqueue a message | `POST /api/outpost/messages` | `outpost.send(input)` | Requires idempotency key; persists then queues |
| Get a message | `GET /api/outpost/messages/:id` | `outpost.get(id)` | Returns lifecycle state + metadata |
| List messages | `GET /api/outpost/messages` | `outpost.list(query)` | Filter by state, recipient hash, date |
| Replay a failed message | `POST /api/outpost/messages/:id/replay` | `outpost.replay(id)` | Re-enqueues from DLQ |
| Check suppression | `GET /api/outpost/suppressions/:hash` | `outpost.isSuppressed(addr)` | Matches on HMAC |
| Add suppression | `POST /api/outpost/suppressions` | `outpost.suppress(addr, reason)` | |
| Remove suppression | `DELETE /api/outpost/suppressions/:hash` | `outpost.unsuppress(addr)` | Audited |
| Provider webhook sink | `POST /api/outpost/webhooks/:provider` | n/a | Signature-verified; not key-authenticated, verified per provider |

### 4.3 Example: enqueue

```ts
const result = await outpost.send({
  idempotencyKey: "order-1234-receipt",      // required; dedupes
  to: "customer@example.com",
  template: { id: "receipt", version: 3, vars: { name, total } },
  // or: subject + html/text for non-templated messages
  metadata: { orderId: "1234" },             // stored in clear, queryable
});
// → { id, state: "queued", idempotencyKey }
```

### 4.4 Configuration (at initialization)

```ts
const outpost = createOutpost({
  db: drizzleClient,                  // Drizzle + Postgres
  provider: resendAdapter({ ... }),   // or smtpAdapter, sesAdapter, mailpitAdapter...
  encryption: {                       // optional, off by default
    mode: "asymmetric",               // API encrypts with public key; worker decrypts with private
    publicKey, kms: { ... },          // key material lives in KMS/Vault, NOT in the DB
  },
  rateLimits: { global, perProvider, perRecipientDomain },
  retention: { operationalTtlDays, auditTtlDays, redactOnPurge: true },
  domainValidation: { syntax: true, mx: true, mailboxProbe: false },
  observability: { otel: true },      // on by default
});
```

---

## 5. Security design

Security and privacy are first-class and on by default. The following are the load-bearing decisions; each warrants an ADR.

### 5.1 API authentication and key lifecycle

- Every API call requires a key. Keys are **opaque, high-entropy secrets**. Only a **hash** of the key is stored (the plaintext is shown once at creation and never again).
- Keys carry: a label, creation timestamp, optional **expiry**, and a revoked flag. Both are enforced on every request.
- Expiry and revocation are managed from the admin panel and take effect immediately (revocation is not deferred by caching beyond a short, documented window).
- Keys are scoped to least privilege where practical (e.g. a send-only key cannot manage suppressions).

### 5.2 Webhook authentication

- Webhook endpoints are **not** API-key authenticated (the provider calls them). Each provider's webhook is verified by its own signature/secret scheme before the payload is trusted. Unverified webhooks are rejected and logged.

### 5.3 Input sanitization

- HTML sanitization against XSS for rendered bodies.
- **Header-injection prevention**: reject CRLF in `To`, `Subject`, and custom headers (a real spam/spoofing vector).
- Template variable escaping to prevent injection via user-supplied data.
- Attachment MIME-type and size validation.

### 5.4 Encryption at rest (configurable)

This protects data at rest (leaked dump, stolen backup, curious DBA, SQLi reading the table). It does **not** protect the moment of sending — the body is necessarily decrypted to be handed to the provider. This is encryption-at-rest, **not E2E**, and the documentation states so plainly.

Three conditions prevent this from becoming security theater:

1. **Key material lives outside the database** — in a KMS/Vault (AWS KMS, GCP KMS, HashiCorp Vault). The master key never touches the DB or the application code. Storing the key as an env var on the same service that reads the DB defeats the purpose.
2. **Asymmetric model honoring least privilege** — the ingestion API encrypts with the **public** key; only the **send worker** holds the **private** key to decrypt. By construction, the component that writes can never read back, and compromising the web API does not expose plaintext bodies. No shared secret between the two services.
3. **Searchable HMAC for the recipient** — because the recipient is encrypted, suppression matching and idempotency-by-recipient would break. A deterministic **keyed HMAC** of the address is stored as a separate searchable column alongside the encrypted value.

What is encrypted vs. clear:
- **Encrypted**: body, recipient address (the PII payload).
- **Clear (queryable)**: status, timestamps, provider, idempotency key, recipient HMAC, caller metadata. Encrypting the index would make the outbox unqueryable and the polling worker non-functional.
- **Algorithm**: AEAD (AES-256-GCM) for symmetric, or a hybrid scheme (data key wrapped by the public key, payload sealed with the symmetric data key). No hand-rolled crypto.

### 5.5 PII minimization and retention

- Bodies and recipients are PII; the audit trail and logs must not become a permanent plaintext PII store.
- The retention worker (§3.9) is the *executor* of this policy: redact the PII payload on purge, keep the audit metadata. Encryption does not exempt data from expiry.

### 5.6 Supply-chain security (publishing)

Because Outpost is a security/privacy-branded package published to npm, it should be published in a way coherent with that promise. The npm ecosystem tightened sharply in 2025 in response to supply-chain attacks: 2FA, short-lived granular tokens, and **trusted publishing via OIDC** (which eliminates long-lived tokens in CI/CD and auto-generates provenance attestations). Outpost should adopt **trusted publishing + provenance** from its first release.

### 5.7 Threat-model notes (for ADRs)

- Dual-write hazard: writing to the DB and publishing to a queue in two operations can leave them inconsistent. **Mitigation: the send worker polls the outbox table** (or uses CDC) rather than the ingestion request publishing to a queue. The DB is the single source of truth; the queue is transport only.
- Double-send under retry: mitigated by the idempotency guard at both ingestion and dispatch.
- Reputation damage: mitigated by suppression list + bounce/complaint feedback loop + layered rate limiting.
- Key compromise: mitigated by KMS-held keys, asymmetric split, least-privilege API keys, and immediate revocation.

---

## 6. Architecture (Clean Architecture + SOLID)

Outpost is layered so the domain core has **zero dependency** on Next.js, Drizzle, Postgres, or any provider. Dependencies point inward only.

```
┌──────────────────────────────────────────────────────────────┐
│  Frameworks & Drivers (outermost)                              │
│  Next.js routes/handlers · Admin panel UI · Drizzle/Postgres   │
│  Provider SDKs (Resend, SES, SMTP...) · KMS client · OTel      │
└───────────────┬────────────────────────────────────────────────┘
                │ implements interfaces defined inward
┌───────────────▼────────────────────────────────────────────────┐
│  Interface Adapters                                            │
│  Repositories (DrizzleOutboxRepository) · EmailProvider impls  │
│  Encryptor impls (KmsEncryptor) · Controllers · Presenters     │
└───────────────┬────────────────────────────────────────────────┘
                │ depends on
┌───────────────▼────────────────────────────────────────────────┐
│  Use Cases (application)                                       │
│  EnqueueMessage · DispatchMessage · IngestWebhook              │
│  ManageSuppression · PurgeRetention · ManageApiKey             │
└───────────────┬────────────────────────────────────────────────┘
                │ depends on
┌───────────────▼────────────────────────────────────────────────┐
│  Entities / Domain (innermost, pure)                           │
│  Message · LifecycleState · SuppressionEntry · ApiKey          │
│  RetentionPolicy · Idempotency rules · domain invariants       │
└────────────────────────────────────────────────────────────────┘
```

How the SOLID principles land:

- **S (Single responsibility)** — each use case does one thing; the send worker, webhook worker, and retention worker are separate units with separate reasons to change.
- **O (Open/closed)** — adding a new provider or storage backend means adding an adapter, not modifying the core.
- **L (Liskov)** — every `EmailProvider` implementation is substitutable; the fake adapter behaves like a real one for tests.
- **I (Interface segregation)** — narrow ports: `EmailProvider`, `OutboxRepository`, `SuppressionRepository`, `Encryptor`, `RateLimiter`, `Clock`. A send-only consumer never depends on suppression-management methods.
- **D (Dependency inversion)** — use cases depend on interfaces (ports); concrete Drizzle/Resend/KMS implementations are injected at the edge.

Key ports (interfaces):

```ts
interface EmailProvider {
  send(msg: DispatchableMessage): Promise<ProviderReceipt>;
  verifyWebhook(req: RawWebhook): Promise<WebhookEvent>;  // enables fallback + uniform ingestion
}
interface OutboxRepository {
  insert(msg): Promise<Message>;
  findByIdempotencyKey(key): Promise<Message | null>;
  claimBatchForSending(limit): Promise<Message[]>;        // polling, lock-safe
  updateState(id, state, audit): Promise<void>;
  claimTerminalForPurge(olderThan, limit): Promise<Message[]>;
}
interface Encryptor { seal(plaintext): Promise<Sealed>; open(sealed): Promise<string>; }
interface RateLimiter { acquire(scope): Promise<boolean>; }
```

The three workers (send, webhook, retention) are independent processes/loops, each driven by use cases, each safe to run concurrently (the retention worker never touches non-terminal rows; the send worker claims rows lock-safely).

---

## 7. Data model (Drizzle / PostgreSQL)

Tables (columns illustrative):

- **`outbox`** — `id`, `idempotency_key` (unique), `state`, `recipient_hmac` (searchable), `recipient_sealed`, `body_sealed`, `subject`, `template_id`, `template_version`, `provider`, `metadata` (jsonb, clear), `attempts`, `next_attempt_at`, `scheduled_for`, `created_at`, `updated_at`. PII columns (`*_sealed`) are encrypted when encryption is enabled; index columns stay clear.
- **`audit_events`** — append-only: `id`, `message_id`, `event_type`, `actor` (api key id / system), `provider_response` (redactable), `at`. Longer retention than `outbox`.
- **`suppressions`** — `recipient_hmac` (unique), `reason` (`hard_bounce` | `complaint` | `unsubscribe` | `invalid` | `manual`), `created_at`, `created_by`.
- **`webhook_events`** — raw verified provider events for traceability and replay.
- **`api_keys`** — `id`, `label`, `key_hash`, `scopes`, `expires_at`, `revoked_at`, `created_at`, `last_used_at`. Only the hash is stored.

Indexing supports the polling worker (`state`, `next_attempt_at`), suppression lookups (`recipient_hmac`), and idempotency (`idempotency_key`).

---

## 8. Observability

- **OpenTelemetry** traces and metrics on by default: enqueue→dispatch→delivery spans, queue depth, throughput, success/bounce/complaint rates, retry counts, DLQ size, purge counts per cycle.
- The append-only audit trail is the durable record of *who did what when*; OTel is the operational telemetry.

---

## 9. Implementation plan (two phases)

### Phase 1 — Core, MVP, single provider (blocking for a usable, honest v1)

Goal: a durable, auditable, idempotent transactional email outbox that does not duplicate sends and does not damage sender reputation.

- Domain core + use cases (Clean Architecture skeleton, all ports defined).
- Drizzle/Postgres `OutboxRepository` and schema (outbox, audit, suppressions, api_keys, webhook_events).
- **Polling send worker** (no dual-write), with sanitization, layered rate limiting, syntax + MX domain validation.
- **Idempotency** at ingestion and dispatch — *blocking*.
- **Suppression list** + **bounce/complaint webhook ingestion** — *blocking* (these protect reputation; shipping without them is irresponsible).
- Retry with backoff + jitter, error classification, and **Dead Letter Queue**.
- Two provider adapters: **Mailpit/SMTP (dev)** and one production provider (**Resend** recommended first), plus the in-memory fake for tests.
- API surface + **API-key authentication with admin-managed expiry/revocation**.
- Append-only audit trail + OpenTelemetry, on by default.
- **Encryption-at-rest** of payload with KMS-held keys, asymmetric split, recipient HMAC.
- **Retention/purge worker** with redaction default and batched deletes.
- Minimal admin panel: message inspection, DLQ replay, suppression management, API-key management, retention config.
- Trusted publishing (OIDC) + provenance for npm release.

Rationale for what is blocking: idempotency, suppression, and bounce/complaint handling are the three features that separate a real transactional system from a duplicate-sending, reputation-burning script. Encryption-at-rest and the retention worker are included in Phase 1 because the package is explicitly security/privacy-branded and these are coherence requirements, not nice-to-haves.

### Phase 2 — Resilience, breadth, and channel-readiness

- **Automatic provider fallback** (failover across adapters on provider outage/5xx).
- Remaining production adapters: **SendGrid, Postmark, AWS SES, generic SMTP**.
- **Templating** with versioning and a template editor in the admin panel.
- **Scheduling** (`scheduled_for`) for future/windowed sends.
- Open-tracking and richer delivery analytics in the admin dashboard.
- SPF/DKIM/DMARC health-check tooling and setup guidance.
- Granular API-key scopes and per-key rate limits.
- Channel-agnostic generalization validated by a **second transport** (e.g. SMS) — only now, because the abstraction has been proven by a real second case rather than guessed.
- Cold-storage archival tier before hard delete; advanced compliance tooling (per-region retention).

---

## 10. Open questions / decisions to confirm

1. **Standalone vs. coupled** — is Outpost a fully standalone package (any Next.js app consumes it) or coupled to the privacy app discussed previously? (Affects packaging, config surface, and whether the admin panel ships embedded or standalone.)
2. **Worker runtime** — Next.js route handlers + a scheduler (cron/queue runner) vs. a separate long-running worker process? Postgres-based polling works in both, but deployment shape differs.
3. **Queue substrate** — pure Postgres polling (simplest, fewest dependencies, recommended for v1) vs. an external queue (Redis/SQS) behind the same port.
4. **Default encryption posture** — off by default (opt-in) vs. on by default. Given the brand, on-by-default is defensible but raises setup friction (KMS required).

---

## 11. Decision log (to be expanded as ADRs)

| # | Decision | Rationale |
|---|---|---|
| 1 | Persist-before-dispatch (transactional outbox) | Durability; survive crash/queue/provider failure |
| 2 | Send worker polls the outbox (no dual-write to a queue) | Avoids DB/queue inconsistency |
| 3 | Idempotency key required at ingestion | Prevents duplicate transactional sends under retry |
| 4 | Domain validation = syntax + MX only, no mailbox probing | Mailbox probing is unreliable and reputation-damaging |
| 5 | Encryption-at-rest, not E2E; keys in KMS; asymmetric split | Honest scope; key separated from data; least privilege |
| 6 | Recipient stored as encrypted value + searchable HMAC | Keeps suppression/idempotency working under encryption |
| 7 | Retention = redact PII, keep audit; act on terminal+aged only | Data-minimization without losing the audit trail |
| 8 | Channel-agnostic core, email-only v1 | Avoids premature abstraction; validate before generalizing |
| 9 | Trusted publishing (OIDC) + provenance | Coherence with the package's security promise |
