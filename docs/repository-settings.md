# Repository settings

The GitHub configuration the workflows depend on. `scripts/bootstrap.mjs` creates all of it —
run `node scripts/bootstrap.mjs --plan` and read the plan before applying it
(`docs/bootstrap.md`). This page is the checklist to verify it against, and to work from if you
would rather configure it by hand.

## Branch protection on `main`

Protect `main` with pull requests, block force pushes and block deletions. Require these three
status checks, which are the three jobs of `ci.yml`:

- `CI / verify`
- `CI / worker`
- `CI / e2e`

Requiring branches to be current before merge is optional, and it serialises merges on a small
team; linear history is optional too. `scripts/bootstrap.mjs` therefore sets `strict: false`,
and zero required approvals so a solo maintainer is not locked out of their own repository —
raise the approval count once there is somebody to approve.

## Environments

Three, and the split between them is about credentials and about who has to be awake.

**`staging`** — secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SEED_PASSWORD`;
variable `STAGING_URL`. No required reviewers, because it only ever deploys a commit that
already has a successful same-repository `CI` run on `main`.

**`production`** — secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; variable
`PRODUCTION_URL`; **required reviewers**, so an artifact promotion cannot start without human
approval. No `SEED_PASSWORD`: production is never seeded.

**`production-backup`** — secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and the
optional `BACKUP_AGE_RECIPIENT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`,
`BACKUP_S3_ACCESS_KEY_ID` and `BACKUP_S3_SECRET_ACCESS_KEY`; variables `BACKUP_S3_REGION` and
`BACKUP_S3_PREFIX`. **No required reviewers**, and that is the whole reason it exists: a
required reviewer would make the nightly export sit waiting for approval every night, so the
schedule would never run unattended.

Its Cloudflare token needs only account-scoped **D1 Read**, the minimum documented D1 read
permission, while the deployment token needs Workers Scripts:Edit, D1:Edit and Workers
Routes:Edit. `D1 Read` is account-scoped rather than restricted to one database, so use a
dedicated Cloudflare account where database-level credential isolation is required. This
separation lets scheduled exports run unattended while keeping production deployment approval
intact.

`STAGING_URL` and `PRODUCTION_URL` are the origins the smoke script calls; `wrangler.jsonc`
carries the matching `APP_URL` per environment, and the two must agree.

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
`framework-upgrade` and never automerges them. Generated Worker output and the compatibility
patch have to be exercised together, and review also verifies migrations, authenticated
actions, approval behaviour and organization isolation before staging receives the change.
`docs/upgrade-playbook.md` is the procedure.
