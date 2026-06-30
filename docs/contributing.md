# Contributing — branch, PR, and release workflow

> Rules for humans and AI agents working in this repository. Read this after
> [AGENTS.md](../AGENTS.md) when you are changing Outpost itself (not integrating
> it into another app).

Before starting work, also check:

- [AGENTS.md](../AGENTS.md) — integration mental model and task recipes
- [.cursor/rules/](../.cursor/rules/) — Cursor agent guardrails (if present)
- [docs/publishing.md](./publishing.md) — npm release process (manual only)
- [docs/CURRENT_PRODUCT_SURFACE.md](./CURRENT_PRODUCT_SURFACE.md) — what ships today
- [CHANGELOG.md](../CHANGELOG.md) — user-facing change log

## Branching

- Branch from **`main`** — there is no `develop` branch.
- Use a typed prefix: `feature/`, `fix/`, `docs/`, or `chore/` (e.g.
  `feature/admin-observability`, `fix/redos-email-validation`).
- CI enforces these prefixes on pull requests (see
  [repo-settings.md](./repo-settings.md)).
- **Do not commit directly to `main`** unless the user explicitly asks.
- **Never push to `main`** without explicit user approval.

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
  `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, etc.
- Focus commit messages on **why**, not a file list.
- **Create commits only when the user asks.** Leave work uncommitted otherwise.

## Pre-PR checklist

Before opening a pull request (or when the user asks you to prepare one):

1. `npm run validate` — typecheck, lint, tests (≥90% coverage), build.
2. Update [`CHANGELOG.md`](../CHANGELOG.md) under `## [Unreleased]` for
   user-visible changes (see [Changelog conventions](#changelog-conventions)).
3. Update [`docs/CURRENT_PRODUCT_SURFACE.md`](./CURRENT_PRODUCT_SURFACE.md) when
   exports, HTTP routes, admin pages, or published artifacts change.
4. Update relevant docs (`docs/*.md`, `AGENTS.md`) when behavior or integration
   paths change.
5. Confirm no secrets, credentials, or `.env` files are staged.

## Pull requests

- Open a PR with `gh pr create` **only when the user asks**.
- **Do not merge, approve, or push** without explicit user approval.
- **Squash merge** is preferred when merging.
- After merge (when the user handles it): `git checkout main && git pull`, then
  delete the local feature branch.

## Releases and publishing

**npm publish and GitHub Releases are never automatic.** No push, tag, or
`release` event triggers publication.

To cut a release, a human must explicitly dispatch the
[Publish package to npmjs](https://github.com/tgoliveira11/outpost/actions/workflows/publish.yml)
workflow on `main`. Agents must **not** run this workflow unless the user
explicitly requests it.

Full steps: [publishing.md](./publishing.md).

GitHub-side gates: [repo-settings.md](./repo-settings.md) (branch protection,
`npmjs` environment reviewers).

### Release invariant

For every published version **X.Y.Z**:

```
npm @tgoliveira/outpost@X.Y.Z  ⟺  git tag vX.Y.Z  ⟺  GitHub Release vX.Y.Z
```

The publish workflow enforces this. If a run fails mid-flight, re-dispatch on
`main` — recovery mode completes the missing step without bumping the version
again.

## Changelog conventions

[`CHANGELOG.md`](../CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/).

- All in-flight notes go under `## [Unreleased]`.
- Use subsections: `### Added`, `### Changed`, `### Fixed`, `### Security`,
  `### Removed` — only include sections that have entries.
- Each entry is a `-` bullet; link to docs or source when helpful.
- A `**Breaking:**` marker in Unreleased forces a **major** bump (or **minor**
  while the package is pre-1.0). An `### Added` section with entries forces
  **minor**; otherwise the release script infers **patch**.
- The publish workflow rolls Unreleased into `## [X.Y.Z] - YYYY-MM-DD` and
  writes the version into `package.json`. Do not hand-edit released sections for
  new work — append to Unreleased instead.
