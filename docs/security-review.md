# Security review

> Internal security review of `@tgoliveira/outpost`. Scope: the package source
> (`src/`), its dependency tree, and the published artifact. Goal: ensure there
> are no issues exploitable by an attacker. Date: 2026-06-29.

## Summary

| Area | Result |
|---|---|
| Code review (injection, DoS, authz, crypto, secrets) | **2 issues found and fixed** |
| Runtime dependencies (`nodemailer`, `drizzle-orm`) | **Fixed** (upgraded to patched versions) |
| Dev-tooling dependencies (vitest → vite dev server) | **Reviewed — non-exploitable, accepted** |
| Published artifact (`dist/`) | **Clean** — no known vulnerabilities |

The shipped package and everything it loads at runtime are free of known
vulnerabilities. The residual `npm audit` findings are dev-only and not
reachable in this project's usage (details below).

## Findings (fixed)

### 1. ReDoS in recipient email validation — High (remote DoS) — FIXED

- **Where:** `src/application/pipeline/domain-validation.ts`, `ADDR_RE`.
- **Issue:** the local-part pattern `[^\s@"]+(?:\.[^\s@"]+)*` was ambiguous —
  `.` is a member of `[^\s@"]`, so a run of dot-separated characters with no
  `@` could be partitioned exponentially many ways, causing catastrophic
  backtracking. Measured ~8.5s for a 62-character input.
- **Impact:** the recipient address is attacker-controlled at `outpost.send()`
  (validated synchronously during enqueue). A caller with a `messages:send` key
  could stall the Node event loop, denying service to the whole process.
- **Fix:** the local part is now a single negated class `[^\s@"]+` with no nested
  quantifier. Matching/rejection is linear — sub-millisecond on a 2000-char
  pathological input. Validation semantics are unchanged for real addresses
  (verified against a suite of valid/invalid cases). Regression test added in
  `test/pipeline.test.ts` ("no ReDoS").

### 2. Header-injection guard matched spaces; under-specified — Medium — FIXED

- **Where:** `src/application/pipeline/sanitize.ts`, `assertNoHeaderInjection`.
- **Issue:** the guard rejected any value containing a space, which (a) broke
  ordinary multi-word subjects/recipients and (b) expressed the wrong invariant
  — the real threat is control characters (CR/LF for header injection, NUL for
  truncation), not spaces.
- **Impact:** primarily a correctness/availability bug (legitimate sends
  rejected). The CRLF defense itself was present, so no injection was possible;
  but relying on a coincidentally-broad rule is fragile.
- **Fix:** the guard now scans character codes and rejects all C0 control
  characters (`0x00–0x1F`, including CR, LF, NUL, TAB) and DEL (`0x7F`), while
  allowing every printable character including the space. Regression tests added
  (multi-word subject allowed; CR/LF/NUL/DEL rejected).

### 3. Fragile affected-row counting — Low (latent correctness) — FIXED

- **Where:** `src/adapters/drizzle/repositories.ts`.
- **Issue:** a helper guessed affected-row counts and fell back to the *expected*
  count when a driver didn't expose `rowCount`, so conditional
  `revoke`/`remove`/`delete` could report success on a no-op (e.g. revoking an
  already-revoked key returned `true`).
- **Fix:** switched to portable `.returning()` and count the rows actually
  affected. Covered by the PGlite-backed repository tests.

## Dependency audit

### Runtime peer dependencies — fixed

These are loaded at runtime by consumers and were upgraded to patched versions
(see `peerDependencies` in `package.json` and the CHANGELOG):

- **`nodemailer` → `>=9.0.1`** — resolves CRLF/SMTP command injection,
  `List-*` header injection, `jsonTransport`/`raw` file-access & SSRF bypass, and
  OAuth2 TLS-validation advisories. Note: Outpost's own pipeline already rejects
  CRLF in `To`/`Subject`/headers and does not use the `raw` option or OAuth2, so
  most vectors were not reachable through Outpost — the upgrade closes them for
  consumers who use nodemailer directly too.
- **`drizzle-orm` → `>=0.45.2`** — resolves the SQL-injection advisory in
  `<0.45.2`. Outpost's queries are fully parameterized via the Drizzle query
  builder; the single `sql\`...\`` fragment uses only a column reference and a
  literal constant (no user input).

### Dev-tooling dependencies — reviewed, non-exploitable

After an `esbuild` override (`^0.25.0`) cleared the esbuild advisories, the
remaining `npm audit` findings are all in the **vitest → vite** chain:

- `vite` ≤ 6.4.2: `server.fs.deny` bypass and `launch-editor` NTLMv2 disclosure.

These are **not exploitable here** because:

1. They affect the **Vite dev server**; this project never runs one — tests run
   headless via `vitest run`, and the package is bundled with `tsup`/esbuild
   (no `serve`).
2. They are **Windows-specific**; CI runs on Linux.
3. `vitest`/`vite` are **devDependencies** — the published package ships only
   `dist/` (see `files` in `package.json`), so consumers never install them.

Forcing the fix requires a `vitest` v4 major upgrade, which would risk the
coverage configuration for no real security benefit. These are therefore
accepted and tracked. Re-evaluate when upgrading the test toolchain.

> Reproduce the triage: `npm audit` (dev tree) vs. `npm audit --omit=dev`
> (runtime/shipped tree — clean).

## Areas reviewed and found sound

- **Authentication** (`src/application/authenticate.ts`): keys are opaque
  256-bit secrets; only a SHA-256 hash is stored; expiry and revocation are
  enforced on every request (no caching). Scope checks enforce least privilege.
- **Webhook verification** (`src/adapters/providers/resend.ts`): Svix signatures
  are verified over the raw body with a constant-time comparison
  (`timingSafeEqual`) before any payload is trusted. *Low-severity note:* there
  is no timestamp-freshness check, so a captured signed webhook could be
  replayed; worst case is re-applying an idempotent state transition or
  re-suppressing an already-bounced address. Tracked as a hardening item
  (optional tolerance window); not currently exploitable for escalation.
- **SQL injection:** none — all queries are parameterized via Drizzle.
- **Crypto** (`src/adapters/crypto/`): vetted primitives only (AES-256-GCM,
  RSA-OAEP, HMAC-SHA256); no hand-rolled crypto; the asymmetric seal/open split
  is enforced in the type system (the web tier physically cannot decrypt).
- **Secret handling:** API-key plaintext is shown once and never logged; private
  keys and key hashes never appear in logs, audit details, or error responses.
  HTTP errors map to status codes without leaking internals (generic 500).
- **Dangerous sinks:** no `eval`, `Function`, `child_process`, or dynamic
  `require` of user input anywhere in `src/`.

## Methodology

- Manual code review of all input-handling, crypto, auth, and persistence paths.
- Targeted ReDoS probing of user-input regexes (measured backtracking time).
- `grep` sweeps for dangerous sinks, raw SQL, and secret logging.
- `npm audit` of the full and runtime-only dependency trees, with per-advisory
  reachability analysis.
- 107 automated tests, including regression tests for both fixed issues.

For the standing security model (encryption, key management, PII), see
[security.md](./security.md). To report a vulnerability, see
[../SECURITY.md](../SECURITY.md).
