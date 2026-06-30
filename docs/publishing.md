# Publishing Outpost to npm

Outpost is published through a **manually-dispatched** GitHub Actions workflow
that resolves the version from the CHANGELOG, validates everything, builds the
exact tarball, and publishes it to npm **with provenance**. The process mirrors
the `next-secure-auth-starter` release pipeline, adapted for this single-package
repo.

## Manual only — never automatic

**npm publish and GitHub Releases are never triggered automatically.** The
publish workflow uses `workflow_dispatch` only — there are no `push`, `tag`, or
`release` triggers. Agents and CI must **not** run it unless a human explicitly
requests a release.

To publish: Actions → **Publish package to npmjs** → Run workflow (on `main`).
See [contributing.md](./contributing.md) for the full branch/PR/release rules
agents follow before a release.

## Release invariant

Every published version must satisfy:

```
npm @tgoliveira/outpost@X.Y.Z  ⟺  git tag vX.Y.Z  ⟺  GitHub Release vX.Y.Z
```

The workflow creates all three in one run (or completes the missing pieces in
**recovery** mode after a failed run). It refuses inconsistent states (e.g. a
git tag without a matching npm version).

Package: [`@tgoliveira/outpost`](https://www.npmjs.com/package/@tgoliveira/outpost)
· Workflow: [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
· Versioning script: [`scripts/prepare-release.mjs`](../scripts/prepare-release.mjs)

## One-time setup (before the first publish)

The workflow uses **OIDC trusted publishing** — there is **no npm token stored
anywhere**. The CI job mints a short-lived OIDC id-token, and npm verifies it
against the package's configured trusted publisher before allowing the publish.

1. The GitHub Environment named **`npmjs`** already exists in this repo (the
   workflow runs under it; required for OIDC trusted publishing on npmjs.com).
2. On npmjs.com, configure the package's **Trusted Publisher** (package page →
   Settings → Trusted Publishers, or the org/scope settings). Use:
   - **Provider:** GitHub Actions
   - **Repository:** `tgoliveira11/outpost`
   - **Workflow filename:** `publish.yml`
   - **Environment:** `npmjs`
3. For the very first publish of a brand-new package name, npm may require you
   to create the package once (e.g. a manual `npm publish` of the initial
   version, or initializing it from the dashboard) before trusted publishing can
   take over. Subsequent releases go entirely through the workflow.

That's the only manual configuration — and no secret to rotate. `package.json`
already sets `publishConfig.access = "public"` and
`publishConfig.provenance = true`.

> Prefer not to use OIDC? You can instead store an npm **Automation/Granular**
> token as an `NPM_TOKEN` secret in the `npmjs` environment and add
> `env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }` to the publish step. The
> workflow ships with OIDC because it keeps no long-lived credential.

## How to cut a release

1. Land your changes on `main`, with notes under the `## [Unreleased]` section
   of [`CHANGELOG.md`](../CHANGELOG.md). **New versions require non-empty
   Unreleased content** — the workflow bumps the version from those notes. If
   `[Unreleased]` is empty, the run enters **recovery mode** only (retry npm
   publish, git tag, and GitHub Release for the version already in
   `package.json`, with no bump). Recovery is for failed or partial publishes,
   not for shipping new work.
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

- **Trigger:** `workflow_dispatch` only — no automatic publish on push, tags, or
  GitHub Releases.
- **Branch guard:** `if: github.ref == 'refs/heads/main'` plus a `concurrency`
  group so two publishes cannot race.
- **Consistency:** refuses to publish a version that already exists on npm
  (except recovery), and refuses a git tag when npm does not have that version.
- **Recovery:** if a run fails after the version bump or mid-publish,
  re-dispatch on `main` with an **empty** `[Unreleased]` section. Recovery
  re-uses the current `package.json` version, skips the changelog bump,
  publishes to npm if needed, creates the `vX.Y.Z` tag if missing, and creates
  the GitHub Release if missing. Passing `patch`/`minor`/`major` with empty
  Unreleased fails early with a clear error.
- **Changelog:** agents document in-flight work under `## [Unreleased]` per
  [contributing.md](./contributing.md); the workflow rolls it into the dated
  release section.
