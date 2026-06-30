# GitHub repository settings

Operational guardrails configured on `tgoliveira11/outpost`. These complement
[contributing.md](./contributing.md) and are not fully expressible in git alone.

## `main` branch protection

| Rule | Setting |
|------|---------|
| Pull requests required | Yes — direct pushes to `main` are blocked for humans |
| Required status checks | `validate`, `branch-name` (strict: branch must be up to date) |
| Linear history | Enabled |
| Force push | Disabled |
| Branch deletion | Disabled |
| Lock branch | **Off** — the publish workflow must push release metadata to `main` |

The publish workflow (`github-actions[bot]`) can still push `Release X.Y.Z`
commits when a human dispatches it. That is intentional; see
[publishing.md](./publishing.md).

To inspect or adjust: **Settings → Branches → Branch protection rules → main**.

## `npmjs` environment

The publish job runs under the **`npmjs`** GitHub Environment so publication can
require an explicit approval gate before npm OIDC trusted publishing runs.

| Rule | Setting |
|------|---------|
| Required reviewers | Repository owner (`tgoliveira11`) |
| Deployment branches | `main` only (recommended) |

To inspect or adjust: **Settings → Environments → npmjs**.

## CI branch naming

Pull requests must use a branch prefix enforced in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

- `feature/` — product behavior or API changes
- `fix/` — bug fixes
- `docs/` — documentation-only changes
- `chore/` — tooling, CI, dependencies, release plumbing

`main` is never validated by this job (merges land via PR).
