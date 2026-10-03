# Repository settings

The GitHub configuration the workflows depend on. `scripts/bootstrap.mjs` creates all of it —
run `node scripts/bootstrap.mjs --plan` and read the plan before applying it
(`docs/bootstrap.md`). This page is the checklist to verify it against, and to work from if you
would rather configure it by hand.

## Branch protection on `main`

Protect `main` with pull requests, block force pushes and block deletions. Require these three
status checks, which are the three jobs of `ci.yml`:

- `CI / verify`
- `CI / e2e`

Requiring branches to be current before merge is optional, and it serialises merges on a small
team; linear history is optional too. `scripts/bootstrap.mjs` therefore sets `strict: false`,
and zero required approvals so a solo maintainer is not locked out of their own repository —
raise the approval count once there is somebody to approve.

## Environments

Two, and the split between them is about who has to approve a deployment.

**`staging`** — secrets `CLEVER_TOKEN`, `CLEVER_SECRET`, `SEED_PASSWORD`;
variable `STAGING_URL`. No required reviewers, because it only ever deploys a commit that
already has a successful same-repository `CI` run on `main`.

**`production`** — secrets `CLEVER_TOKEN`, `CLEVER_SECRET`; variable
`PRODUCTION_URL`; **required reviewers**, so an artifact promotion cannot start without human
approval. No `SEED_PASSWORD`: production is never seeded.

There is no third environment. The Cloudflare arrangement had a `production-backup` one, so
that a nightly export could run unattended without waiting for a reviewer. The database plan
takes its own backups now, so nothing schedules a workflow and nothing needs a
lower-privilege credential.

`STAGING_URL` and `PRODUCTION_URL` are the origins the smoke script calls, and
`CLEVER_APP_NAME` is what lets a workflow link its checkout to the right application. All
three are set by `scripts/bootstrap.mjs` from what the platform actually assigned, so they
cannot disagree with the deployment.

## Repository options

Enable the **template** flag if this copy is itself meant to be reused as a template
(`gh repo edit <repo> --template`, or `TEMPLATE_REPOSITORY=1` in the bootstrap input).

Install the [Renovate GitHub App](https://github.com/apps/renovate). It has to be done by
somebody with admin rights on the repository and cannot be automated; `renovate.json` is the
configuration.

Keep the default `GITHUB_TOKEN` permission read-only; individual workflows declare only the
additional read access they need (`actions: read` for the two deployment workflows).

## Why framework upgrades are never automerged

Renovate groups the framework packages, holds them for three days after release, labels them
`framework-upgrade` and never automerges them. The framework patch this repository carries is
pinned to an exact version and has to be re-examined with every bump, and review also verifies
migrations, authenticated actions, approval behaviour and organization isolation before staging
receives the change.
`docs/upgrade-playbook.md` is the procedure.
