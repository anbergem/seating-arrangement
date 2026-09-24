# Deployment

Two hosted environments, one promoted commit. Nothing is ever rebuilt from a different tree.

- [Environments](#environments)
- [The build](#the-build)
- [Platform configuration](#platform-configuration)
- [Secrets and variables](#secrets-and-variables)
- [CI](#ci)
- [Staging](#staging)
- [Production](#production)
- [Promotion provenance](#promotion-provenance)
- [Smoke tests](#smoke-tests)
- [Restricting access to staging](#restricting-access-to-staging)
- [Moving somewhere else](#moving-somewhere-else)

## Environments

| | local | CI | staging | production |
| --- | --- | --- | --- | --- |
| `APP_ENV` | `local` | `ci` | `staging` | `production` |
| `NODE_ENV` | unset | `production` | `production` | `production` |
| Runtime | Node (`pnpm dev`, or `pnpm build && pnpm start`) | Node | Node on Clever Cloud | Node on Clever Cloud |
| Database | `file:./data/app.db` | a throwaway SQLite file | PostgreSQL add-on `<app>-staging-db` | PostgreSQL add-on `<app>-production-db` |
| `APP_URL` | `http://localhost:3000` | the e2e listener | the staging origin | the production origin |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | `0` | `0` | `0` | `1` |
| `SEED_ENABLED` | `1` | `1` | `1` (QA org only) | **forbidden** |
| `SEED_PASSWORD` | default | default | secret | **forbidden** |
| `AGENT_NATIVE_AUDIT_RETENTION_DAYS` | — | — | `365` | `0` (forever) |
| `AUTO_CREATE_DEFAULT_ORG` | `0` | `0` | `0` | `0` |
| Deployed by | you | nobody | `deploy-staging.yml` on a green CI run | `deploy-production.yml`, manual, reviewed |

Separate applications, separate databases, separate settings, separate GitHub environments.
Nothing is shared and no credential reaches both.

`server/plugins/00-env-check.ts` refuses to start a misconfigured deployment, with one clear
message and never a value:

- **production requires** `BETTER_AUTH_SECRET` (32+ characters), `OAUTH_STATE_SECRET`, an https
  `APP_URL`, `GOOGLE_SIGN_IN_CLIENT_ID`, `GOOGLE_SIGN_IN_CLIENT_SECRET` and
  `ANTHROPIC_API_KEY`;
- **production forbids** `ACCESS_TOKEN` and `ACCESS_TOKENS` whenever they are present at all,
  and `AUTH_DISABLED`, `SEED_ENABLED` and `AGENT_PROD_CODE_EXECUTION` when they are enabled
  (`""`, `0`, `false`, `off`, `no` pass, so `SEED_ENABLED=0` may be stated explicitly);
- **local** refuses `APP_ENV=production`;
- a missing `APP_ENV` resolves to `local`; an `APP_ENV` set to something else entirely is a
  violation, so a typo fails loudly instead of silently selecting the local rules.

`server/plugins/00-database-url.ts` runs just before it, and maps the platform's
`POSTGRESQL_ADDON_URI` onto the `DATABASE_URL` the framework reads. An explicit `DATABASE_URL`
always wins, so local development and the tests are untouched. The mapping exists so the
connection string lives in exactly one place — the add-on — and a credential rotation there is
picked up on the next boot with nothing to edit.

## The build

`pnpm build` runs `agent-native build` with the Node preset and produces `.output/`, which
`pnpm start` serves. That is the whole build.

Clever Cloud builds it again on its own machine from the git push, which is why two of its
settings are not optional:

- `CC_NODE_DEV_DEPENDENCIES=install`. The platform installs production dependencies only,
  which is right for an uploaded build and wrong for one it performs itself: React and the
  build toolchain are `devDependencies`, and without this the build fails on a missing
  `react-dom/client`.
- A dedicated **M** build instance (`clever scale --build-flavor M`). The default builder
  shares the application's own instance and is killed by a thousand-package install. It is
  billed per build minute, not continuously.

Both are set by `scripts/bootstrap.mjs`, and both come from a deploy that failed exactly that
way (`docs/plan/DISCREPANCIES.md`, 2026-09-23).

## Platform configuration

There is no committed platform configuration file. The applications, their databases and their
settings live on Clever Cloud, and `scripts/bootstrap.mjs` is what puts them there:

```
preflight  apps  postgres  app-env  deploy  github-environments  github-secrets  branch-protection
```

`clever create --type node <app> --region par` per environment, a
`postgresql-addon` per environment, `clever service link-addon` to join them, and
`clever env import` to set everything the application reads. `.clever.json`, which the CLI
writes to map an alias to an application id, is git-ignored: it is per-instantiation, like the
database ids before it.

**The PostgreSQL plan is `xxs_sml` and the free `dev` plan is refused.** `dev` allows five
connections; the framework opens a pool of twenty on a long-lived Node server, hardcoded, with
no environment variable and no configuration hook. That is measured, not assumed — the failure
is `too many connections for role` before the first request is served.

**Region.** `par` (Paris) by default. `CLEVER_REGION` accepts the European zones `par`,
`parhds`, `rbx`, `rbxhds`, `grahds`, `wsw`, `ldn` and the others Clever Cloud offers;
`parhds` and `grahds` are the French health-data-certified ones.

## Secrets and variables

Two places, and which one a value belongs in is not a preference.

**Application settings** — what the application reads at runtime, per environment, set by
`bootstrap`'s `app-env` step through `clever env import` reading stdin, so no value ever
reaches a command line or a shell history:

```
APP_ENV  NODE_ENV  APP_URL  AUTO_CREATE_DEFAULT_ORG
AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT  AUTH_REQUIRE_EMAIL_VERIFICATION
SEED_ENABLED  AGENT_NATIVE_AUDIT_RETENTION_DAYS
CC_NODE_BUILD_TOOL  CC_NODE_DEV_DEPENDENCIES  CC_RUN_COMMAND  CC_POST_BUILD_HOOK
BETTER_AUTH_SECRET  OAUTH_STATE_SECRET
GOOGLE_SIGN_IN_CLIENT_ID  GOOGLE_SIGN_IN_CLIENT_SECRET  ANTHROPIC_API_KEY
SEED_PASSWORD (staging only)
```

`BETTER_AUTH_SECRET` and `OAUTH_STATE_SECRET` are generated per environment and never reused
between them — 32 random bytes each, never written to disk. A re-run keeps what is already
there; `--rotate` replaces it, and signs every user of that environment out.

**GitHub environment secrets and variables** — only what a *workflow* needs:

| GitHub environment | Secrets | Variables | Reviewers |
| --- | --- | --- | --- |
| `staging` | `CLEVER_TOKEN`, `CLEVER_SECRET`, `SEED_PASSWORD` | `STAGING_URL`, `CLEVER_APP_NAME` | none — it only deploys a SHA with a successful same-repository CI run on `main` |
| `production` | `CLEVER_TOKEN`, `CLEVER_SECRET` | `PRODUCTION_URL`, `CLEVER_APP_NAME` | **required** |

No `SEED_PASSWORD` on production: production is never seeded.

`CLEVER_TOKEN` and `CLEVER_SECRET` are the CLI's own profile, written by `clever login` and
copied into GitHub by `bootstrap`. Nobody pastes them, and **no Clever Cloud credential goes in
`.bootstrap.env` at all** — which is the one thing this arrangement has over the Cloudflare
token it replaced.

The database connection string is in neither list. CI reaches it with
`node scripts/migrate.mjs --addon <app>-db`, which resolves it through the CLI in-process;
it never appears in a log, a command line or a GitHub variable.

## CI

`.github/workflows/ci.yml`, on every pull request and every push to `main`. Two jobs, and the
server is built **once**:

| Job | Needs | Does |
| --- | --- | --- |
| `verify` | — | `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:integration`, `pnpm build`, uploads `.output/` as `server-build` |
| `e2e` | `verify` | Downloads that artifact, installs Chromium, runs `pnpm test:e2e`, uploads `playwright-report/` on failure |

`scripts/e2e-server.mjs` starts that built server against a SQLite file in a fresh temporary
directory, migrates it, seeds the scenario and runs the smoke from the global setup, so the
browser suite is independent of any developer file and touches no cloud resource.

Concurrency is grouped per ref with cancellation, and `CI / verify` and `CI / e2e` are the
required checks on `main`.

## Staging

`.github/workflows/deploy-staging.yml`, triggered by `workflow_run` on `CI` completing
successfully on `main` (plus `workflow_dispatch`, restricted to `main`). Environment: `staging`.

In order:

1. **Preflight the credentials.** `clever profile` before anything else — the only step that
   needs no repository, and the one that catches a stale credential in seconds rather than
   after three minutes of install and build.
2. **Prove the SHA.** The run requires a completed, successful `ci.yml` run of *this*
   repository on `main` for that exact commit (`scripts/validate-ci-run.mjs`). A manual
   dispatch performs the same exact-SHA lookup.
3. **Write the manifest.** An immutable `deployment-manifest` artifact
   `{ repository, sha, sourceCiRunId }`, 90-day retention. This is what production promotes.
4. `clever link` this checkout to the staging application.
5. **Migrate** with `node scripts/migrate.mjs --addon <app>-db`.
6. **Deploy** with `clever deploy`.
7. **Reset the QA scenario**: `node scripts/seed.mjs --addon <app>-db --reset --base-url
   "$STAGING_URL"`. The seed refuses any base URL or database URL containing "production".
8. **Smoke** in staging mode as the QA owner.
9. Record the commit, the source CI run and the deploy/smoke status in the job summary.

Migrations run **before** the deploy, so a migration that fails fails the deployment rather
than taking a running application down with it — and every migration must therefore be
backwards compatible with the version still serving traffic. See
`docs/database-and-migrations.md` § *Expand and contract*.

## Production

`.github/workflows/deploy-production.yml`, `workflow_dispatch` only, with inputs
`staging_run_id` and `confirm` (which must be the literal `deploy`). The job additionally
requires `github.ref == refs/heads/main`. Environment: `production`, with required reviewers,
so the run waits for a human.

```bash
gh run list --workflow=deploy-staging.yml --status success --limit 5
gh workflow run deploy-production.yml -f staging_run_id=<id> -f confirm=deploy
```

In order:

1. Validate the run id as digits; preflight the Clever Cloud credentials.
2. Read the staging run's metadata; download its `deployment-manifest`; read and validate its
   `sourceCiRunId`.
3. `scripts/validate-staging-run.mjs` — the staging run's workflow path, repository, branch,
   status and conclusion; the manifest's repository and SHA; and that the manifest names the CI
   run that actually verified that SHA.
4. **Check out that SHA**, so the migrations, the lockfile and the tool versions all come from
   the promoted commit.
5. `scripts/verify-promoted-commit.mjs` — `git rev-parse HEAD` and the manifest SHA must agree.
6. Record the database backups that exist before this promotion, and the previous deployments,
   into the job summary.
7. **Migrate**, then **deploy**.
8. The read-only production smoke.
9. On failure, append the backups, the previous deployments and the rollback guidance to the
   job summary.

Inputs never reach shell code unchecked — the run id is validated as digits and every value is
passed through an environment variable. A non-cancelling `deploy-production` concurrency group
serialises promotions, so a second one queues rather than replacing the first.

## Promotion provenance

Worth its own section because it is the subtlest part of the pipeline.

A `workflow_run`-triggered run's own `head_sha` describes the context the workflow *file* was
loaded from, which is not necessarily the commit the triggering CI run verified. Two staging
runs can report the same `head_sha` having deployed different commits. A promotion keyed on it
could check out migrations from one commit and deploy another.

So provenance is a **manifest, not a field**. Staging proves the SHA at the moment it deploys
and writes `{ repository, sha, sourceCiRunId }` as an immutable artifact; production
re-validates all three and then verifies its own checkout against it.
`tests/guards/deployment-validation.test.mjs` unit-tests every refusal: a failed run, an
unrelated workflow, the wrong branch, the wrong repository, an incomplete run, the wrong SHA
and a mismatched manifest.

What is promoted changed with the platform, and the guarantee narrowed honestly. Cloudflare
promoted a *file* — a bundle built once and uploaded — so the old check could hash it. Clever
Cloud builds from the git push, so what is promoted is a *commit*, and what the chain proves is
that the commit production builds is the commit staging deployed and smoked.

**No platform-side git integration.** Deployments come from GitHub Actions only, because a
build triggered inside the platform cannot be tied to the run that verified it — which is the
whole guarantee above.

## Smoke tests

```bash
# after `pnpm build && pnpm start`
node scripts/smoke.mjs --base-url http://localhost:3000 --mode local \
  --qa-email owner@example.invalid --qa-password "$SEED_PASSWORD" --expect-org-id org_acme

# staging, as the QA owner
node scripts/smoke.mjs --base-url "$STAGING_URL" --mode staging \
  --qa-email owner@example.invalid --qa-password "$SEED_PASSWORD" --expect-org-id org_acme

# production — public, read-only checks only
node scripts/smoke.mjs --base-url "$PRODUCTION_URL" --mode production
```

The production mode does not sign in, does not write and does not touch agent chat: a
deployment check must not create rows in a client's database. It verifies `ping`, `health`
with `db: true` and the dialect the mode implies (`sqlite` locally, `postgres` deployed),
`/api/ready` with `applied === expected`, `GET /sign-in`, `GET /` (200 — the static shell;
**never** expect a 302), an unauthenticated action returning 401, and `POST /mcp` returning 401
with a `WWW-Authenticate` challenge.

Staging and local additionally sign in, list events, perform a reversible write (a
`create-seating-table` with an idempotency key, a `label-seat`, a stale-version refusal, an
undo, then `archive-seating-table`) and check that agent chat returns an event stream.
The table of which check runs where is in `docs/testing.md`.

## Restricting access to staging

Optional, and staging only. If staging carries realistic-looking data and you would rather it
were not indexable or reachable, put an authenticating proxy in front of it, or give it a
non-obvious custom domain and leave the assigned `cleverapps.io` name unadvertised.

Two consequences before you add a fence: the staging smoke in the deployment workflow will
start getting the fence's login page instead of the application, so the workflow needs
credentials for it; and a browser session for staging now has two sign-ins.

**Never on production.** The application authenticates its own users with Google and requires
membership; a second identity fence would double the sign-in surface and the number of places a
lockout can happen, without adding a guarantee.

## Moving somewhere else

This is Clever-Cloud-first, not Clever-Cloud-only, and the repository has now done the move
once so the shape of it is known rather than theoretical.

The application layer is portable by construction: nothing under `src/` or `server/` imports a
platform type or calls a platform API, and `runAtomic` is the one seam that ever knew the
difference between runtimes. Moving off Cloudflare needed **one** SQL change in 1,346 lines of
repositories — `INSERT OR IGNORE` became `ON CONFLICT DO NOTHING` — because the framework's
executor rewrites `?` placeholders for PostgreSQL itself.

What a move costs is the deployment half: `scripts/bootstrap.mjs`, the two deploy workflows,
the e2e launcher, and these docs. `docs/plan/tasks/T28-clever-cloud-migration.md` is the worked
example, including what was deleted on the way out and what was measured to justify it.
