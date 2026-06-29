# Security

> How Outpost protects message content, authenticates callers and webhooks, and
> minimizes PII. Security and privacy are first-class and on by default where
> the brand demands it. This page is the operator's reference; the rationale for
> each decision lives in the [ADRs](./adr/).

## Threat model at a glance

| Threat | Mitigation |
|---|---|
| Leaked DB dump / stolen backup / curious DBA / SQLi reading the table | Encryption at rest (bodies + recipients sealed); keys held outside the DB |
| Web tier compromise reading historical bodies | Asymmetric split — web tier holds only the public key, cannot decrypt |
| Duplicate transactional sends under retry | Idempotency guard at ingestion + dispatch; provider idempotency key |
| Sender-reputation damage | Suppression list + bounce/complaint feedback + layered rate limiting |
| Header injection / spoofing (`\r\nBcc:`) | CRLF rejected in To/Subject/headers before dispatch |
| XSS in rendered bodies | HTML sanitization (pluggable strong sanitizer; built-in fallback) |
| Forged provider webhooks | Per-provider signature verification before any trust |
| Stolen/old API key | Opaque hashed keys, scopes, expiry, immediate revocation |
| PII accumulating forever in logs/audit | Configurable retention with redaction default |

## Encryption at rest

**This is encryption at rest, not end-to-end.** The provider necessarily
receives readable content to deliver it; Outpost protects the database and
backups, not the wire to the provider. Stated plainly so there is no false
privacy promise (ADR [0005](./adr/0005-encryption-at-rest-not-e2e.md)).

### What is encrypted vs. clear

- **Sealed (encrypted):** recipient address, message body. Stored in the
  `recipient_sealed` / `body_sealed` JSONB columns.
- **Clear (queryable):** state, timestamps, provider, idempotency key, recipient
  **HMAC**, subject, caller metadata. These must stay clear or the polling
  worker and suppression lookups stop working.

### Modes (`encryption` option)

```ts
// 1. Off (dev default). Columns hold base64 plaintext, alg "plain".
encryption: { mode: "none" }

// 2. Symmetric — one AES-256-GCM key seals and opens. Simple, single-process.
encryption: { mode: "symmetric", key: process.env.OUTPOST_AES_KEY! /* base64, 32 bytes */ }

// 3. Asymmetric — least-privilege split (recommended for the security brand).
//    Web/ingestion tier: public key only (omit privateKey → it cannot read back).
//    Send worker: include privateKey so it alone can decrypt.
encryption: { mode: "asymmetric", publicKey, privateKey }

// 4. Bring your own — back the Encryptor port with AWS KMS / GCP KMS / Vault.
encryption: { sealEncryptor, openEncryptor }
```

Generate keys:

```bash
# Symmetric AES-256 key (base64, 32 bytes):
openssl rand -base64 32

# RSA keypair for asymmetric mode:
openssl genrsa -out outpost_private.pem 2048
openssl rsa -in outpost_private.pem -pubout -out outpost_public.pem
```

### Three rules that keep it from being theater

1. **Keys live outside the database.** Pull them from a KMS/Vault/secret
   manager. Never store a key in a column or in the same dump as the data. The
   bundled local-key classes are the reference and the dev default — for
   production, implement the `Encryptor` port against your KMS (envelope
   encryption).
2. **Asymmetric honors least privilege.** The ingestion API encrypts with the
   public key; only the send worker holds the private key. Compromising the web
   API cannot expose plaintext bodies — `HybridSealEncryptor.open()` throws by
   construction.
3. **Searchable HMAC for the recipient.** Because the recipient is sealed,
   suppression and idempotency-by-recipient would break. A deterministic keyed
   HMAC of the normalized address is stored as a separate searchable column
   (ADR [0006](./adr/0006-recipient-encrypted-plus-hmac.md)).

### `recipientHmacKey` (required)

A keyed HMAC-SHA256 of the recipient address. It is **mandatory** even with
encryption off, because suppression matching and recipient lookups depend on it.

- Must be **≥ 16 bytes** of entropy. `openssl rand -base64 32`.
- Must live **outside the DB** (a leaked dump + the key would let an attacker
  confirm whether a known address is present).
- Must be **stable forever.** Changing it orphans every existing suppression
  entry and breaks recipient lookups for existing rows.

## API key authentication

- Keys are opaque, high-entropy secrets prefixed `opk_`. Only a **SHA-256 hash**
  is stored; the plaintext is shown **once** at creation and is unrecoverable.
- Each key carries a label, scopes, optional expiry, and a revoked flag —
  expiry and revocation are enforced on **every** request (no long-lived
  caching), so revocation is effectively immediate.
- Scopes implement least privilege:
  `messages:send`, `messages:read`, `messages:replay`, `suppressions:read`,
  `suppressions:write`, `keys:manage`, and `admin` (implies all).
- Present the key as `Authorization: Bearer opk_...` or `x-outpost-key: opk_...`.
  Missing/expired/revoked → `401`; valid key without the required scope → `403`.

```ts
const { secret } = await outpost.keys.create({ label: "ci", scopes: ["messages:send"] });
// store `secret` now — it is never shown again
await outpost.keys.revoke(keyId); // immediate
```

## Webhook authentication

Webhook endpoints are **not** API-key authenticated — the provider calls them.
Trust is established by verifying the provider's signature against the raw
request body **before** the payload is parsed or trusted (ADR
[0005](./adr/0005-encryption-at-rest-not-e2e.md), TDR §5.2):

- **Resend** uses the Svix scheme (`svix-id` / `svix-timestamp` /
  `svix-signature`, HMAC-SHA256 over `id.timestamp.body`). Set `webhookSecret`
  on the provider. Tampered or unsigned payloads are rejected and logged.
- The HTTP handler reads the **raw body** (`req.text()`) so the signature is
  verified over the exact bytes the provider signed — never re-serialize first.

Implementing a custom provider? `verifyWebhook(raw)` must throw
`WebhookVerificationError` on any signature failure.

## Input sanitization

Applied at ingestion and re-applied to decrypted data before dispatch (defense
in depth):

- **Header-injection prevention** — CRLF / control characters rejected in `To`,
  `Subject`, and custom headers. This is the primary spam/spoofing defense.
- **HTML sanitization** — a built-in conservative stripper removes
  `<script>`/`<iframe>`/`on*=`/`javascript:` etc. For production, plug a hardened
  sanitizer via `createOutpost({ sanitizeHtml })` (e.g. `sanitize-html` or
  DOMPurify) — the built-in is a fallback, not a full sanitizer.
- **Template variable escaping** — variables are HTML-escaped on render.
- **Size + attachment limits** — configurable; oversized payloads rejected.

## PII minimization and retention

Bodies and recipients are PII; logs and the audit trail must not become a
permanent plaintext PII store. The retention worker (ADR
[0007](./adr/0007-retention-redact-keep-audit.md)):

- Acts **only** on terminal rows older than the operational TTL **and** past the
  webhook window — never on `sent` alone (that would break bounce handling).
- **Redacts by default** (wipes `*_sealed` PII, keeps the audit row + HMAC),
  rather than deleting. Set `retention.redactOnPurge: false` to hard-delete.
- Operational TTL and audit TTL are independent (audit is kept longer).
- Runs in batches to avoid long table locks; logs counts per cycle so you can
  detect both "stopped cleaning" and "cleaning too much".

Encryption does **not** exempt data from expiry — sealed data is still purged on
schedule.

## Supply-chain (publishing)

Outpost is published with **trusted publishing (OIDC) + provenance** — no
long-lived npm token in CI. See [publishing.md](./publishing.md) and ADR
[0009](./adr/0009-trusted-publishing-provenance.md).

## Email authentication (SPF / DKIM / DMARC)

Outpost does not configure DNS, but their absence collapses deliverability. Make
sure your sending domain has SPF, DKIM, and DMARC records before going live;
provider dashboards (Resend/SES) walk you through it. (A built-in health check
is planned for Phase 2.)
