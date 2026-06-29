# Architecture

> Clean Architecture in practice: a pure domain core, ports as seams, use cases for orchestration, and adapters at the edge — with dependencies pointing strictly inward.

Outpost is a transactional outbox with a pluggable transport layer. The design
goal is that the *core* (what guarantees durability, idempotency, lifecycle, and
auditing) never depends on a concrete provider, database, or framework. Those are
all swappable details wired in one place.

## The layers

| Layer | Path | Dependency rule |
|---|---|---|
| **Domain** (pure) | `src/domain/` | Imports nothing outward. Entities, the lifecycle state machine, error taxonomy. |
| **Ports** (interfaces) | `src/ports/` | Imports domain only. The seams adapters implement. |
| **Application** (use cases) | `src/application/` | Imports domain + ports. Orchestration + the dispatch pipeline. |
| **Adapters** (concrete) | `src/adapters/` | Implement ports. Providers, Drizzle, crypto, rate-limit, OTel, templates, system services. |
| **Edge** (wiring) | `src/http`, `src/client`, `src/workers` | HTTP handlers, the `Outpost` client, the polling workers. |
| **Composition root** | `src/create-outpost.ts` | The ONLY place concrete adapters are assembled. |

### The dependency rule

Dependencies point **inward only**. The domain knows nothing about Postgres,
Resend, or HTTP. Use cases depend on *ports* (interfaces), never on
implementations. The composition root (`createOutpost`) is where concrete
adapters are instantiated and injected, satisfying Dependency Inversion.

```
        ┌─────────────────────────────────────────────────────┐
        │  Edge: HTTP (OutpostRouter) · Client (Outpost) ·      │
        │        Workers (SendWorker, RetentionWorker)          │
        └───────────────────────┬─────────────────────────────┘
                                 │ depends on
        ┌───────────────────────▼─────────────────────────────┐
        │  Adapters: Resend/SMTP/Fake · Drizzle repos ·         │
        │  AES/Hybrid encryptors · HMAC hasher · rate limiters ·│
        │  OTel/console telemetry · template renderer           │
        └───────────────────────┬─────────────────────────────┘
                                 │ implement
        ┌───────────────────────▼─────────────────────────────┐
        │  Ports: EmailProvider · repositories · Encryptor ·    │
        │  RecipientHasher · RateLimiter · Clock · IdGenerator ·│
        │  Logger · Telemetry · TemplateRenderer · MxResolver   │
        └───────────────────────┬─────────────────────────────┘
                                 │ depend on
        ┌───────────────────────▼─────────────────────────────┐
        │  Application (use cases): EnqueueMessage ·            │
        │  DispatchMessage · IngestWebhook · ManageSuppression ·│
        │  ManageApiKey · Authenticate · message queries ·      │
        │  PurgeRetention · pipeline (sanitize/validate/retry)  │
        └───────────────────────┬─────────────────────────────┘
                                 │ depend on
        ┌───────────────────────▼─────────────────────────────┐
        │  Domain (pure): Message · lifecycle state machine ·   │
        │  Sealed · SuppressionEntry · ApiKey/scopes ·          │
        │  WebhookEvent · AuditEvent · RetentionPolicy · errors │
        └───────────────────────────────────────────────────── ┘
                          (no outward imports)
```

`createOutpost` (`src/create-outpost.ts`) sits above everything: it resolves
config, constructs the adapters, assembles them into a `CoreDeps`, and returns
the `Outpost` client. Swapping a provider, storage backend, or KMS is a change
*here*, never in the core.

## How SOLID lands

- **Single Responsibility** — each use case does one thing: `EnqueueMessage`
  persists, `DispatchMessage` sends one claimed message, `IngestWebhook`
  verifies + applies one webhook, `PurgeRetention` enforces retention.
- **Open/Closed** — adding a provider means adding an `EmailProvider`
  implementation and passing it in `providers: [...]`; the core does not change.
  Same for storage (`*Repository` ports) and KMS (`Encryptor` port).
- **Liskov Substitution** — `FakeEmailProvider` is substitutable for a real
  provider: same interface, same error contract (`ProviderError.transient` /
  `.permanent`). The in-memory repositories mirror the Drizzle semantics.
- **Interface Segregation** — ports are deliberately narrow. The
  `WebhookEventRepository` exposes only `record()`; a send-only consumer never
  depends on suppression-management methods.
- **Dependency Inversion** — use cases depend on the port interfaces in
  `src/ports/`; concrete adapters are injected at the composition root.

## The ports (and where they live)

| Port | File | Implemented by |
|---|---|---|
| `EmailProvider` | `src/ports/email-provider.ts` | `ResendEmailProvider`, `SmtpEmailProvider`, `FakeEmailProvider` |
| `OutboxRepository` | `src/ports/repositories.ts` | `DrizzleOutboxRepository`, `InMemoryOutboxRepository` |
| `SuppressionRepository` | `src/ports/repositories.ts` | `Drizzle…`, `InMemory…` |
| `AuditRepository` | `src/ports/repositories.ts` | `Drizzle…`, `InMemory…` |
| `ApiKeyRepository` | `src/ports/repositories.ts` | `Drizzle…`, `InMemory…` |
| `WebhookEventRepository` | `src/ports/repositories.ts` | `Drizzle…`, `InMemory…` |
| `Encryptor` (seal/open) | `src/ports/crypto.ts` | `NoopEncryptor`, `AesGcmEncryptor`, `HybridSealEncryptor`, `HybridOpenEncryptor` |
| `RecipientHasher` | `src/ports/crypto.ts` | `HmacRecipientHasher` |
| `RateLimiter` | `src/ports/services.ts` | `InMemoryRateLimiter`, `UnlimitedRateLimiter` |
| `Clock` | `src/ports/services.ts` | `SystemClock`, `FakeClock` |
| `IdGenerator` | `src/ports/services.ts` | `UuidGenerator` |
| `Logger` | `src/ports/services.ts` | `ConsoleLogger`, `NoopLogger` |
| `Telemetry` | `src/ports/services.ts` | `NoopTelemetry`, `OtelTelemetry` |
| `TemplateRenderer` | `src/ports/template.ts` | `InMemoryTemplateRenderer` |
| `MxResolver` | `src/application/pipeline/domain-validation.ts` | `DnsMxResolver` |

To add a provider, implement `EmailProvider`. To swap storage, implement the
repository ports. To back encryption with a KMS, implement the `Encryptor` pair.
Nothing inward changes — see [providers.md](./providers.md) and
[security.md](./security.md).

## The three workers

The system runs three independent background processors (`src/workers/`, plus the
webhook sink in the HTTP layer):

1. **SendWorker** (`src/workers/send-worker.ts`) — polls the outbox, atomically
   claims a batch with `FOR UPDATE SKIP LOCKED`, and runs each row through
   `DispatchMessage`. Safe to run as multiple instances.
2. **RetentionWorker** (`src/workers/retention-worker.ts`) — periodically runs
   `PurgeRetention`, which redacts (or deletes) terminal, aged rows past the
   webhook window.
3. **Webhook ingestion** — not a long-running worker but the `IngestWebhook` use
   case, driven by the HTTP webhook sink (`OutpostRouter.webhook`). It lives in
   the HTTP layer because the provider, not a loop, triggers it.

See [workers.md](./workers.md) for deployment shapes.

## The message lifecycle (state machine)

The lifecycle is encoded purely in `src/domain/lifecycle.ts`. Use cases consult
`canTransition(from, to)` rather than re-deriving the rules; an unlisted
transition is a domain-invariant violation and is rejected.

```
              ┌─────────────┐
 enqueue ────▶│   queued    │
              └──────┬──────┘
                     │ claimed by send worker
                     ▼
              ┌─────────────┐  suppressed recipient
              │  sending    │────────────────────────▶ suppressed
              └──────┬──────┘
                     │ provider accepted
                     ▼
              ┌─────────────┐
              │    sent     │  (accepted, not yet confirmed)
              └──────┬──────┘
                     │ webhook
      ┌──────────────┼───────────────┬────────────┐
      ▼              ▼               ▼            ▼
  delivered       bounced        complained     failed

  Transient dispatch error → back to `queued` with backoff (retry).
  Permanent error / retries exhausted → `failed` (terminal, DLQ).
  DLQ replay re-enqueues a `failed` message → `queued`.
```

Allowed transitions (`ALLOWED_TRANSITIONS`):

| From | To |
|---|---|
| `queued` | `sending`, `suppressed`, `failed` |
| `sending` | `sent`, `queued` (transient retry), `failed`, `suppressed` |
| `sent` | `delivered`, `bounced`, `complained`, `failed` |
| `delivered` / `bounced` / `complained` / `suppressed` | *(terminal)* |
| `failed` | `queued` (DLQ replay) |

**Terminal states** are `delivered`, `bounced`, `complained`, `failed`,
`suppressed`. The retention worker only ever acts on terminal rows (and only past
the webhook window), which is what makes it safe to run alongside the send worker.
Reaching `bounced` (hard) or `complained` feeds the suppression list
(`shouldSuppressOn`).
