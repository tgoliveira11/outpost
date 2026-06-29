# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | ✅ |
| < 1.0 | ❌ |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for an
unfixed vulnerability.

- Use [GitHub Security Advisories](https://github.com/tgoliveira11/outpost/security/advisories/new)
  ("Report a vulnerability"), or
- email the maintainer listed in `package.json`.

Include: affected version, a description, reproduction steps or a proof of
concept, and the impact you foresee. We aim to acknowledge within 72 hours and
to ship a fix or mitigation for confirmed issues as quickly as is practical,
coordinating disclosure with you.

## Scope

In scope: the published `@tgoliveira/outpost` package (the code under `dist/`,
built from `src/`) and its documented configuration surface.

Out of scope: vulnerabilities that require a misconfiguration the docs warn
against (e.g. storing the `recipientHmacKey` or an encryption key in the
database, using the `FakeEmailProvider`/in-memory repositories in production),
and advisories in **dev-only** tooling that are not reachable in normal use or
shipped to consumers (see [docs/security-review.md](./docs/security-review.md)).

## Security model

Outpost is built security-first. The standing model — encryption at rest, key
management, webhook verification, API-key lifecycle, input sanitization, and PII
retention — is documented in [docs/security.md](./docs/security.md), with the
rationale for each decision in [docs/adr/](./docs/adr/). The most recent review
is in [docs/security-review.md](./docs/security-review.md).

## Hardening checklist for operators

- Hold the `recipientHmacKey` and encryption keys in a KMS/secret manager, never
  in the database or alongside a DB dump.
- Use the asymmetric encryption mode so the web tier cannot decrypt payloads.
- Scope API keys to least privilege; rotate and revoke from the admin surface.
- Configure each provider's `webhookSecret` so webhook signatures are verified.
- Set rate limits and a retention policy appropriate to your data.
- Configure SPF/DKIM/DMARC on your sending domain.
