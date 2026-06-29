# Publishing Outpost to npm

Outpost is published with **trusted publishing (OIDC) + provenance** — no
long-lived `NPM_TOKEN` in CI. This is [ADR 0009](./adr/0009-trusted-publishing-provenance.md)
and TDR §5.6: a security/privacy-branded package should ship through a pipeline
that matches that promise. The biggest CI supply-chain vector — a stolen static
publish token — simply does not exist here.

## What's already configured

`package.json` sets:

```jsonc
{
  "publishConfig": {
    "access": "public",     // publish the scoped package publicly
    "provenance": true      // attach a provenance attestation on publish
  }
}
```

`provenance: true` tells npm to generate a signed attestation linking the
published tarball to the exact source commit and CI build that produced it.
Consumers see the "provenance" badge on the npm page and can verify the chain.

## How trusted publishing works

Instead of a stored token, the CI job requests a short-lived **OIDC id-token**
from the CI provider. `npm publish` presents it to the registry, which verifies
it came from the expected repository and workflow before allowing the publish —
and uses it to mint the provenance attestation. Nothing long-lived is stored.

Prerequisites (one-time):

- npm CLI new enough to support OIDC trusted publishing (recent npm 10/11+).
- On npmjs.com, configure the package's **trusted publisher** to point at this
  repository and the publishing workflow.

## Minimal GitHub Actions workflow

```yaml
# .github/workflows/release.yml
name: release

on:
  push:
    tags: ["v*"]            # publish on a version tag

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write       # REQUIRED — lets the job mint the OIDC token. No NPM_TOKEN.
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          registry-url: "https://registry.npmjs.org"
      - run: npm ci
      - run: npm run build
      - run: npm test
      # No NODE_AUTH_TOKEN / NPM_TOKEN: trusted publishing + provenance,
      # driven by publishConfig in package.json.
      - run: npm publish
```

The `id-token: write` permission is the load-bearing line — it is what allows the
runner to obtain the OIDC token npm verifies. There is deliberately **no**
`NODE_AUTH_TOKEN` or `secrets.NPM_TOKEN` anywhere in the job.

## Fallback: 2FA + granular tokens

If trusted publishing is unavailable (e.g. a registry or CI provider without
OIDC support), the documented fallback is:

- Publish with **2FA enabled** (`auth-and-writes`), and
- Use a **short-lived, granular access token** scoped to only this package,
  rather than a classic long-lived automation token.

This is the break-glass path only — it does not produce provenance and
reintroduces credential handling, so prefer trusted publishing whenever the
pipeline supports it.
