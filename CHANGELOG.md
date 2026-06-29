# Changelog

All notable changes to `@tgoliveira/outpost` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **npm publishing pipeline** (`.github/workflows/publish.yml`) — a manually
  dispatched, provenance-signed release workflow modeled on
  `next-secure-auth-starter`: changelog-driven versioning via
  `scripts/prepare-release.mjs`, `audit:security` + `validate` gates, exact
  tarball packing, registry/tag consistency guards, and automatic Git tag +
  GitHub Release. New `validate`, `audit:security`, and `prepare:release`
  scripts. See [docs/publishing.md](./docs/publishing.md).

### Changed

- CI (`ci.yml`) now runs the single `validate` script and verifies the packed
  package contents. The tag-triggered `release.yml` was replaced by the
  dispatch-driven `publish.yml`.

### Security

- **Fixed a ReDoS (catastrophic backtracking) in recipient email validation.**
  The address-syntax regex used an ambiguous nested quantifier in the local part
  (`[^\s@"]+(?:\.[^\s@"]+)*`). Because the recipient is attacker-controlled at
  enqueue, a crafted address such as `a.a.a…!` caused exponential matching time
  (~8s for 62 chars), i.e. a remote denial-of-service that could stall the event
  loop. The local part is now a single, unambiguous character class; matching is
  linear (sub-millisecond on 2000-char inputs). See
  `src/application/pipeline/domain-validation.ts`.
- **Fixed the header-injection guard rejecting legitimate input and tightened it.**
  `assertNoHeaderInjection` previously matched the space character, which both
  rejected ordinary multi-word subjects and under-specified the actual threat.
  It now scans character codes and rejects every C0 control character
  (`0x00–0x1F`, including CR, LF, NUL, TAB) and DEL (`0x7F`) while allowing all
  printable characters. The CRLF header-injection defense is unchanged in intent
  and now correct. See `src/application/pipeline/sanitize.ts`.
- **Bumped runtime peer dependencies to patched versions:**
  - `nodemailer` → `>=9.0.1` (resolves CRLF/SMTP command injection, List-header
    injection, `jsonTransport`/`raw` file-access & SSRF bypass, and OAuth2 TLS
    validation advisories — GHSA-vvjj-xcjg-gr5g, -268h-hp4c-crq3, -wqvq-jvpq-h66f,
    -p6gq-j5cr-w38f, -r7g4-qg5f-qqm2).
  - `drizzle-orm` → `>=0.45.2` (resolves the SQL-injection advisory affecting
    `<0.45.2`).
- Added an `esbuild` override (`^0.25.0`) to clear the esbuild dev-server
  advisories pulled in transitively by the build/test toolchain.
- Documented the residual dev-only advisories (vite dev-server, Windows-only)
  as reviewed and non-exploitable in this project's usage — see
  [docs/security-review.md](./docs/security-review.md). The published package
  (`dist/` only) and its runtime dependencies are free of known vulnerabilities.

### Added

- This `CHANGELOG.md`.
- `SECURITY.md` — vulnerability disclosure policy.
- `docs/security-review.md` — the security review report and threat assessment.

### Changed

- Replaced the fragile, driver-specific `rowCount` extraction in the Drizzle
  repositories with portable `.returning()`-based affected-row counts. This also
  fixed a latent bug where conditional `revoke`/`remove`/`delete` operations
  could report success on a no-op under drivers that don't surface `rowCount`.

## [1.0.0] - 2026-06-29

Initial implementation — a transactional outbox with pluggable transport for
Next.js (Phase 1 of the design record, [docs/tdr.md](./docs/tdr.md)).

### Added

- **Durable outbox core** — persist-before-dispatch ingestion; the database is
  the single source of truth.
- **At-most-once delivery** — required idempotency key at ingestion, re-checked
  at dispatch; message id forwarded as the provider idempotency key.
- **Pluggable transport** — `EmailProvider` port with Resend, generic
  SMTP/Mailpit, and an in-memory Fake adapter.
- **Lifecycle tracking** — `queued → sending → sent → delivered | bounced |
  complained | failed | suppressed`, driven by signature-verified provider
  webhooks.
- **Suppression list** — hard bounces and complaints auto-suppress; matched by
  keyed HMAC so it works under encryption.
- **Retry + Dead Letter Queue** — exponential backoff with full jitter, error
  classification, and crash-safe lease reclaim of abandoned `sending` rows.
- **Encryption at rest** — optional AES-256-GCM (symmetric) or RSA-hybrid
  (asymmetric, least-privilege seal/open split); KMS-friendly `Encryptor` port.
- **Append-only audit trail + OpenTelemetry** hooks.
- **Configurable retention/purge worker** — redaction default, terminal-rows-only,
  batched.
- **Authenticated API** — opaque hashed keys with scopes, expiry, and immediate
  revocation.
- **Clean Architecture core** (domain → ports → application → adapters) with
  Drizzle/Postgres persistence and a Next.js HTTP layer.
- Full documentation set (`AGENTS.md`, `docs/`, 9 ADRs) and ≥90%-enforced test
  coverage (104 tests at release).

[Unreleased]: https://github.com/tgoliveira11/outpost/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tgoliveira11/outpost/releases/tag/v1.0.0
