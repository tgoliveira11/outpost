# Publishing Outpost to npm

Outpost is published through a manually-dispatched GitHub Actions workflow that
resolves the version from the CHANGELOG, validates everything, builds the exact
tarball, and publishes it to npm **with provenance**. The process mirrors the
`next-secure-auth-starter` release pipeline, adapted for this single-package
repo.

Package: [`@tgoliveira/outpost`](https://www.npmjs.com/package/@tgoliveira/outpost)
· Workflow: [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
· Versioning script: [`scripts/prepare-release.mjs`](../scripts/prepare-release.mjs)

## One-time setup (before the first publish)

The workflow authenticates to npm with a token held in a protected GitHub
Environment, and generates provenance via OIDC.

1. **Create a granular npm token** for the `@tgoliveira` scope at
   <https://www.npmjs.com/settings/tgoliveira/tokens> — an **Automation** or
   **Granular Access** token with publish rights to this package.
2. **Create a GitHub Environment** named `npmjs`
   (repo → Settings → Environments → New environment). Optionally add required
   reviewers so every publish needs an approval.
3. **Add the token as a secret** in that environment named **`NPM_TOKEN`**.
4. (Recommended) On npmjs.com, also enable **2FA** for the account and, if you
   prefer, configure this repo + `publish.yml` as a **trusted publisher** so the
   token can be retired later.

That's the only manual configuration. `package.json` already sets
`publishConfig.access = "public"` and `publishConfig.provenance = true`.

## How to cut a release

1. Land your changes on `main`, with notes under the `## [Unreleased]` section
   of [`CHANGELOG.md`](../CHANGELOG.md).
2. Run the **"Publish package to npmjs"** workflow
   (Actions tab → Run workflow), on `main`. Optionally set the `version` input:
   - **blank / `auto`** → version inferred from the Unreleased changelog
     (`**Breaking:**` → major; an `### Added` with entries → minor; otherwise
     patch).
   - **`patch` / `minor` / `major`** → bump that part.
   - **`x.y.z`** → that exact version (must be greater than the current one).

The job then, in order:

1. `npm ci`, and checks npm ≥ 11.5.1 (needed for provenance).
2. `npm run audit:security` — fails on **high/critical in shipped dependencies**
   (`--omit=dev`; dev-only tooling advisories don't block — see
   [security-review.md](./security-review.md)).
3. `node scripts/prepare-release.mjs` — writes the new version into
   `package.json` + `package-lock.json` and rolls `## [Unreleased]` into a dated
   `## [x.y.z]` section.
4. `npm run validate` — typecheck, lint, tests + ≥90% coverage, and build.
5. `npm pack` — builds the **exact** tarball that will be published.
6. Guards against re-publishing an existing npm version or creating an
   inconsistent tag (with a `recovery` path to retry a half-finished release).
7. Commits the release metadata back to `main`, then
   `npm publish <tarball> --access public --provenance`.
8. Creates and pushes the `vX.Y.Z` tag and a generated GitHub Release.

## Provenance

`--provenance` (and `publishConfig.provenance`) makes npm attach a signed
attestation linking the tarball to the exact source commit and CI run that
produced it, via the workflow's OIDC `id-token`. Consumers see the
**provenance** badge on the npm page and can verify the build chain. This is
[ADR 0009](./adr/0009-trusted-publishing-provenance.md) / TDR §5.6.

## Verifying locally before you dispatch

You can dry-run the whole pipeline without publishing:

```bash
npm run validate                 # types, lint, tests+coverage, build
npm run audit:security           # shipped-dependency vulnerabilities (gating)
npm pack --dry-run               # exact file list that would ship
RELEASE_SPEC=patch node scripts/prepare-release.mjs   # preview the version/changelog edit
#   …then `git checkout -- package.json package-lock.json CHANGELOG.md` to undo
npm publish --dry-run --access public                 # full publish rehearsal, no upload
```

## Notes

- The workflow is **dispatch-only** and guarded with `if: github.ref ==
  'refs/heads/main'` and a `concurrency` group, so two publishes can't race.
- It refuses to publish a version that already exists on npm, and refuses to tag
  a release that wasn't published — keeping npm, the git tag, and the GitHub
  Release consistent.
- If a run fails after the version bump but before publish, re-dispatching
  enters `recovery` mode and re-attempts the existing version without bumping
  again.
