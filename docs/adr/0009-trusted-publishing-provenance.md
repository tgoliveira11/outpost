# ADR 0009: Trusted publishing (OIDC) + provenance

- Status: Accepted
- Date: 2026-06-29

## Context

Outpost is a security/privacy-branded package, so how it is *published* must be
coherent with that promise. The npm ecosystem tightened sharply in 2025 after a
run of supply-chain attacks: stolen long-lived `NPM_TOKEN`s in CI were a primary
vector for publishing malicious versions of legitimate packages. A package that
preaches least privilege and key separation while shipping with a static publish
token in a CI secret would be contradicting itself.

## Decision

Adopt **trusted publishing via OIDC + provenance** from the first release. The
CI job exchanges a short-lived, workload-scoped OIDC token with npm at publish
time — there is **no long-lived `NPM_TOKEN`** stored anywhere. npm verifies the
token came from the expected repository/workflow and auto-generates a
**provenance attestation** linking the published tarball to the exact commit and
build that produced it. `package.json` already sets
`publishConfig.provenance: true` and `publishConfig.access: public`. The GitHub
Actions workflow grants `id-token: write` and runs `npm publish` with no token.
See [docs/publishing.md](../publishing.md). 2FA + short-lived granular tokens
are the documented fallback when trusted publishing is unavailable.

## Consequences

- No long-lived publish credential exists to steal — the largest CI supply-chain
  vector is removed.
- Consumers can verify provenance (the npm "provenance" badge) and trace any
  release to its source commit and build.
- The security posture of the release pipeline matches the package's brand.
- Cost: publishing is coupled to the CI provider's OIDC support and a correctly
  configured workflow; a local `npm publish` from a laptop is no longer the
  blessed path (and would lack provenance).

## Alternatives considered

- **Long-lived `NPM_TOKEN` in CI.** The status quo that 2025's attacks
  exploited. Rejected as incoherent with the package's promise.
- **Manual local publish with 2FA.** Acceptable as a fallback, but it does not
  produce provenance and reintroduces human/credential handling. Kept only as a
  documented break-glass option.
