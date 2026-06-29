# Configuration

> Every `createOutpost` option, the four encryption variants, rate-limit budgets, and the tunable config overrides with their defaults.

`createOutpost(options)` is the composition root. It validates the options,
resolves config defaults, wires the adapters, and returns the `Outpost` client.
`OutpostOptions` extends `ConfigOverrides`, so the tuning fields (`retry`,
`retention`, `sanitize`, `attachments`, `domainValidation`, `sendBatchSize`,
`rateLimits`) sit at the top level alongside the wiring fields.

## `OutpostOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `repositories` | `{ outbox, suppressions, audit, apiKeys, webhookEvents }` | — (required) | The five persistence ports. Build from Drizzle (`@tgoliveira/outpost/drizzle`) or use `inMemoryRepositories()` from `@tgoliveira/outpost/testing`. |
| `providers` | `EmailProvider[]` | — (required, ≥1) | Transport adapters. The first is the default unless `defaultProvider` is set. Empty array throws. |
| `defaultProvider` | `string` | first provider's `name` | Which provider name to use when a message doesn't specify one. Must be present in `providers` or `createOutpost` throws. |
| `recipientHmacKey` | `string \| Buffer` | — (required) | Key for the deterministic recipient HMAC. Backs suppression matching and recipient-keyed lookups even with encryption off. **Must be ≥16 bytes** of entropy and live outside the DB; otherwise the `HmacRecipientHasher` constructor throws. |
| `encryption` | `EncryptionOptions` | `{ mode: "none" }` | Encryption-at-rest posture (see below). |
| `rateLimits` | `RateLimitConfig` | `{}` (unlimited) | Layered rate-limit budgets (see below). |
| `templates` | `TemplateRenderer` | `undefined` | Template renderer (e.g. `InMemoryTemplateRenderer`). Required only if you send with `template`. |
| `telemetry` | `Telemetry` | `NoopTelemetry` | Pre-built telemetry. For OTel: `telemetry: await OtelTelemetry.create()`. See [observability.md](./observability.md). |
| `logger` | `Logger` | `ConsoleLogger` (JSON lines, min level `info`) | Structured logger port. |
| `clock` | `Clock` | `SystemClock` | Injectable clock. Pass `FakeClock` in tests for determinism. |
| `ids` | `IdGenerator` | `UuidGenerator` | Id generator (UUID v4). |
| `rateLimiter` | `RateLimiter` | `InMemoryRateLimiter` if `rateLimits` set, else `UnlimitedRateLimiter` | Override the limiter (e.g. a Redis-backed one for multi-worker setups). |
| `mxResolver` | `MxResolver` | `DnsMxResolver` if `domainValidation.mx` is on, else `undefined` | MX lookup adapter. |
| `sanitizeHtml` | `(html: string) => string` | built-in `stripDangerousHtml` fallback | A strong HTML sanitizer (e.g. `sanitize-html` / DOMPurify). Strongly recommended for production. |
| `random` | `() => number` | `Math.random` | Random source for retry jitter. Pass a fixed value in tests. |
| `defaultActor` | `string` | `"programmatic"` | Audit actor label for programmatic calls. The HTTP layer overrides this with `key:<id>`. |
| `retry` | `Partial<RetryConfig>` | see [Retry](#retry) | Retry/backoff overrides. |
| `retention` | `Partial<RetentionPolicy>` | see [Retention](#retention) | Retention policy overrides. |
| `sanitize` | `Partial<SanitizeLimits>` | see [Sanitize limits](#sanitize-limits) | Size ceilings overrides. |
| `attachments` | `Partial<AttachmentPolicy>` | see [Attachments](#attachments) | Attachment policy overrides. |
| `domainValidation` | `Partial<Omit<DomainValidationConfig, "mailboxProbe">>` | see [Domain validation](#domain-validation) | Recipient-domain checks. `mailboxProbe` is forced to `false` and cannot be enabled. |
| `sendBatchSize` | `number` | `50` | Max rows the send worker claims per poll. |

## Encryption (`EncryptionOptions`)

A discriminated union with four variants. See [security.md](./security.md) for
the threat model.

```ts
type EncryptionOptions =
  | { mode: "none" }
  | { mode: "symmetric"; key: Buffer | string; keyId?: string }
  | { mode: "asymmetric"; publicKey: string; privateKey?: string; keyId?: string }
  | { sealEncryptor: Encryptor; openEncryptor: Encryptor };
```

| Variant | Behavior |
|---|---|
| `{ mode: "none" }` | **Default.** Encryption disabled — `NoopEncryptor` stores base64 plaintext with `alg: "plain"`. The column shape never changes, so you can enable encryption later with no row-format migration. Dev default. |
| `{ mode: "symmetric", key, keyId? }` | AES-256-GCM. One 32-byte key seals and opens. `key` is a `Buffer` or a base64 string (decoded to 32 bytes). Simplest single-process posture. Key must come from KMS/secrets. |
| `{ mode: "asymmetric", publicKey, privateKey?, keyId? }` | RSA-hybrid least-privilege split. The web tier seals with `publicKey` and physically cannot read back; the send worker opens with `privateKey`. **Omit `privateKey` in the web tier** — the opener then refuses, preserving the "web cannot read" invariant. |
| `{ sealEncryptor, openEncryptor }` | Bring-your-own KMS. Supply a pair of objects implementing the `Encryptor` port (envelope encryption against AWS KMS / GCP KMS / Vault). |

```ts
// Symmetric:
createOutpost({ /* … */, encryption: { mode: "symmetric", key: process.env.OUTPOST_AES_KEY! } });

// Asymmetric, web tier (seal only — no privateKey):
createOutpost({ /* … */, encryption: { mode: "asymmetric", publicKey: PUB } });

// Asymmetric, send-worker tier (can open):
createOutpost({ /* … */, encryption: { mode: "asymmetric", publicKey: PUB, privateKey: PRIV } });
```

## Rate limits (`RateLimitConfig`)

Layered token-bucket budgets. Each budget is `{ max, windowMs }` — at most `max`
sends per `windowMs` window. Any layer left unset is unlimited.

```ts
interface RateLimitConfig {
  global?:             { max: number; windowMs: number }; // ceiling across everything
  perProvider?:        { max: number; windowMs: number }; // per provider name
  perRecipientDomain?: { max: number; windowMs: number }; // per recipient domain
}
```

When a layer is over budget at dispatch, the message is **re-queued with a short
1–5s jittered backoff** — it is never dropped, and the attempt is not counted
against the retry budget. The default `InMemoryRateLimiter` is correct for a
single process; for multiple send workers implement the `RateLimiter` port
against Redis (shared counters).

```ts
createOutpost({
  // …
  rateLimits: {
    global: { max: 100, windowMs: 1000 },          // 100/s overall
    perProvider: { max: 80, windowMs: 1000 },      // 80/s per provider
    perRecipientDomain: { max: 10, windowMs: 1000 }, // 10/s per domain
  },
});
```

## Config overrides

These are partial overrides merged onto built-in defaults via `resolveConfig`.

### Retry

`Partial<RetryConfig>` — exponential backoff with full jitter for transient
failures (`DEFAULT_RETRY`).

| Field | Default | Description |
|---|---|---|
| `maxAttempts` | `5` | Max dispatch attempts before dead-lettering to `failed`. |
| `baseDelayMs` | `30_000` (30s) | Base backoff; first retry waits ~this before jitter. |
| `maxDelayMs` | `3_600_000` (1h) | Cap on the backoff. |

Backoff for the next attempt is `min(maxDelayMs, baseDelayMs * 2^(attempts-1))`,
then full-jitter (random in `[0, that]`).

### Retention

`Partial<RetentionPolicy>` — data minimization (`DEFAULT_RETENTION`). See
[workers.md](./workers.md) and [database.md](./database.md).

| Field | Default | Description |
|---|---|---|
| `operationalTtlDays` | `30` | Age after which a terminal outbox row's PII may be purged. |
| `auditTtlDays` | `365` | Age after which audit events may be deleted. |
| `redactOnPurge` | `true` | When true, purge **redacts** PII (keeps the row + metadata + HMAC); when false it deletes the row. |
| `webhookWindowHours` | `72` | Grace window after a terminal state during which a row is NOT purged, so late delivery/bounce webhooks can still arrive. |
| `batchSize` | `1000` | Rows redacted/deleted per batch, to avoid long table locks. |

### Sanitize limits

`Partial<SanitizeLimits>` — size ceilings (`DEFAULT_SANITIZE_LIMITS`). CRLF/NUL
header-injection rejection is always on regardless of these.

| Field | Default | Description |
|---|---|---|
| `maxSubjectBytes` | `2_000` | Max subject size. |
| `maxBodyBytes` | `5_000_000` (5 MB) | Max combined html+text body size. Empty body is rejected. |
| `maxRecipientBytes` | `320` | Max recipient address (RFC 5321 limit). |
| `maxHeaderValueBytes` | `4_000` | Max custom header value size. |

### Attachments

`Partial<AttachmentPolicy>` (`DEFAULT_ATTACHMENT_POLICY`).

| Field | Default | Description |
|---|---|---|
| `allowedMimeTypes` | `["application/pdf", "image/png", "image/jpeg", "image/gif", "text/plain", "text/csv"]` | MIME allow-list. |
| `maxSizeBytes` | `10_000_000` (10 MB) | Max single-attachment size. |

### Domain validation

`Partial<Omit<DomainValidationConfig, "mailboxProbe">>`
(`DEFAULT_DOMAIN_VALIDATION`).

| Field | Default | Description |
|---|---|---|
| `syntax` | `true` | RFC-5322-ish address syntax check. Always enforced at enqueue. |
| `mx` | `false` | Optional, cached MX lookup at dispatch. Requires an `MxResolver`. |
| `mxCacheTtlMs` | `3_600_000` (1h) | TTL for the MX result cache. |
| `mailboxProbe` | `false` (**forced**) | Per-mailbox existence probing is never supported — it is unreliable and damages sender reputation. The override type omits it and `resolveConfig` forces `false`. |

### Send batch size

| Option | Default | Description |
|---|---|---|
| `sendBatchSize` | `50` | Max rows the send worker claims per poll cycle. The `SendWorker` `batchSize` option can override this per worker. |

## Worked example

```ts
const outpost = createOutpost({
  repositories,
  providers: [resend],
  recipientHmacKey: process.env.OUTPOST_HMAC_KEY!,
  encryption: { mode: "symmetric", key: process.env.OUTPOST_AES_KEY! },
  rateLimits: { global: { max: 200, windowMs: 1000 } },
  retry: { maxAttempts: 8, baseDelayMs: 15_000 },
  retention: { operationalTtlDays: 14, redactOnPurge: true },
  sendBatchSize: 100,
  sanitizeHtml: (html) => sanitizeHtml(html), // a real sanitizer
});
```
