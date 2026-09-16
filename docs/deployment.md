# Deployment

Two hosted environments, one build, one promotion. Nothing is ever built for production.

- [Environments](#environments)
- [The Worker build](#the-worker-build)
- [Wrangler configuration](#wrangler-configuration)
- [Secrets and variables](#secrets-and-variables)
- [CI](#ci)
- [Staging](#staging)
- [Production](#production)
- [Promotion provenance](#promotion-provenance)
- [Smoke tests](#smoke-tests)
- [Cloudflare Access on staging](#cloudflare-access-on-staging)
- [The Node + libSQL fallback](#the-node--libsql-fallback)

## Environments

| | local | CI / local Worker | staging | production |
| --- | --- | --- | --- | --- |
| `APP_ENV` | `local` | `ci` | `staging` | `production` |
| `NODE_ENV` | unset | `production` (Worker var) | `production` | `production` |
| Runtime | Node (`pnpm dev`) or workerd (`pnpm dev:worker`) | workerd | Worker | Worker |
| Database | `file:./data/app.db` / local D1 | local D1 | D1 `<app>-staging`, EU | D1 `<app>-production`, EU |
| `APP_URL` | `http://localhost:8080` / `http://127.0.0.1:8787` | `http://127.0.0.1:8787` | the staging origin | the production origin |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | `0` | `0` | `0` | `1` |
| `SEED_ENABLED` | `1` | `1` | `1` (QA org only) | **forbidden** |
| `SEED_PASSWORD` | default | default | secret | **forbidden** |
| `AGENT_NATIVE_AUDIT_RETENTION_DAYS` | — | — | `365` | `0` (forever) |
| `AUTO_CREATE_DEFAULT_ORG` | `0` | `0` | `0` | `0` |
| Deployed by | you | nobody | `deploy-staging.yml` on a green CI run | `deploy-production.yml`, manual, reviewed |

Separate Workers, separate databases, separate secrets, separate GitHub environments. Nothing
is shared and no credential reaches both.

`server/plugins/00-env-check.ts` refuses to start a misconfigured deployment, with one clear
message and never a value:

- **production requires** `BETTER_AUTH_SECRET` (32+ characters), `OAUTH_STATE_SECRET`, an https
  `APP_URL`, `GOOGLE_SIGN_IN_CLIENT_ID`, `GOOGLE_SIGN_IN_CLIENT_SECRET` and
  `ANTHROPIC_API_KEY`;
- **production forbids** `DATABASE_URL`, `ACCESS_TOKEN` and `ACCESS_TOKENS` whenever they are
  present at all, and `AUTH_DISABLED`, `SEED_ENABLED` and `AGENT_PROD_CODE_EXECUTION` when they
  are enabled (`""`, `0`, `false`, `off`, `no` pass, so `SEED_ENABLED=0` may be stated
  explicitly);
- **local** refuses `APP_ENV=production` and any `DATABASE_URL` that does not start with
  `file:`;
- a missing `APP_ENV` resolves to `local`; an `APP_ENV` that is set to something else entirely
  is a violation, so a typo fails loudly instead of silently selecting the local rules.

On Workers, Nitro plugins are lazy, so this runs inside the first request rather than at boot —
the first request fails with the same message.

## The Worker build

`pnpm build:worker` runs `scripts/build-worker.mjs`, which does four things in order:

1. `NITRO_PRESET=cloudflare_pages NODE_ENV=production agent-native build` → `dist/`.
2. `node scripts/patch-worker-bundle.mjs` — two regex replacements in
   `dist/_worker.js/index.js`, each of which must match **exactly once**, then writes
   `dist/_worker.js/PATCHED.json`.
3. `node scripts/check-bundle-size.mjs` — gzips every `.js` under `dist/_worker.js/`, sums, and
   fails above 8 MiB.
4. Writes `dist/BUILD_INFO.json` `{ sha, builtAt, coreVersion }`.

Three things in there deserve explanation.

**Why the `cloudflare_pages` preset for a Worker.** At core 0.176.5 the `cloudflare_module`
preset's output does not boot on workerd — it calls `setInterval` at module scope and then
`createRequire(undefined)`. The `cloudflare_pages` preset produces a single-file bundle that
does boot. So the build uses that preset and the output is deployed as a **Worker with static
assets** through our own `wrangler.jsonc`, not as a Pages project. The framework-generated
`wrangler.json` is not used.

**Why the patch.** The bundle's Node built-in stubs make `fs.existsSync` and `os.homedir` safe
only for *named* imports; the default-export proxy throws for every property. The agent-chat
plugin init hits the first and the MCP client config reader hits the second, which takes down
agent chat, the audit actions and the `/mcp` endpoint. The patch rewrites the two proxy getters
so a small safe table wins before the throwing fallback. It asserts one match per pattern and
exits non-zero otherwise — a different count means the framework changed the stub shape, which
is the signal to revisit the patch during an upgrade rather than ship a guess. The marker is
bound to the bundle's SHA-256, so a stale marker cannot exempt a rebuilt bundle.
`docs/upgrade-playbook.md` is the procedure; the upstream report is in
`docs/plan/upstream-issues/`.

**Why the size guard.** Cloudflare measures the compressed Worker size: 3 MiB on Free, 10 MiB on
Paid. The bare framework template is already about 4 MB compressed, which is why the starter
requires the Paid plan. The 8 MiB ceiling keeps 2 MiB of margin, so a dependency that doubles
in size fails a pull request instead of a deploy.

## Wrangler configuration

`wrangler.jsonc` is ours, hand-maintained, and committed. The one thing to remember about it:
**`vars` and `d1_databases` are not inherited by environments.** Every environment repeats them
in full. `name`, `main`, `assets`, `compatibility_*` and `observability` are inherited, but
`name` is set per environment anyway so the Workers are distinguishable.

```jsonc
{
  "name": "<app>",
  "main": "dist/_worker.js/index.js",
  "compatibility_date": "2026-09-05",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "dist", "binding": "ASSETS" },
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "vars": { /* the local defaults */ },
  "d1_databases": [{ "binding": "DB", "database_name": "<app>-local", "database_id": "…", "migrations_dir": "migrations" }],
  "env": {
    "staging":    { "name": "<app>-staging",    "vars": { … }, "d1_databases": [ … ] },
    "production": { "name": "<app>-production", "vars": { … }, "d1_databases": [ … ] }
  }
}
```

- `nodejs_compat` is required by the framework's bundle.
- `NODE_ENV: "production"` must be present as a Worker **var**; the framework reads it at
  runtime.
- The local `database_id` can be any placeholder: `--local` keys the database by
  `database_name`.
- `observability.enabled` is what turns on Workers Logs.
- The staging and production `database_id` values are filled in by `scripts/bootstrap.mjs`,
  which edits the file as text and preserves the comments. **Commit the result** — the
  workflows read `wrangler.jsonc` from git, so an id that exists only on a laptop deploys
  nothing.

`scripts/check-config-hygiene.mjs`, part of `pnpm check`, parses this file and fails if a secret
name appears in any `vars` block, if a telemetry key appears anywhere, or if the deploy-time
placeholder is left outside the two environment blocks.

## Secrets and variables

Three places, and which one a value belongs in is not a preference.

**Worker secrets** — the application reads these at runtime. Set per environment, never
readable back:

```bash
pnpm exec wrangler secret put BETTER_AUTH_SECRET --env production
pnpm exec wrangler secret put OAUTH_STATE_SECRET --env production
pnpm exec wrangler secret put GOOGLE_SIGN_IN_CLIENT_ID --env production
pnpm exec wrangler secret put GOOGLE_SIGN_IN_CLIENT_SECRET --env production
pnpm exec wrangler secret put ANTHROPIC_API_KEY --env production
pnpm exec wrangler secret put SEED_PASSWORD --env staging          # staging only
pnpm exec wrangler secret list --env production
```

`BETTER_AUTH_SECRET` and `OAUTH_STATE_SECRET` are generated per environment and are never
reused between them — `scripts/bootstrap.mjs` generates 32 random bytes each and never writes
them to disk. Rotating either signs every user of that environment out.

**Worker vars** — non-secret configuration, in `wrangler.jsonc` per environment, in git.

**GitHub environment secrets and variables** — only what a *workflow* needs. A Worker secret is
not readable by a workflow, and should not be.

| GitHub environment | Secrets | Variables | Reviewers |
| --- | --- | --- | --- |
| `staging` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SEED_PASSWORD` | `STAGING_URL` | none — it only deploys a SHA with a successful same-repository CI run on `main` |
| `production` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `PRODUCTION_URL` | **required** |
| `production-backup` | `CLOUDFLARE_API_TOKEN` (D1 Read only), `CLOUDFLARE_ACCOUNT_ID`, the optional `BACKUP_*` secrets | `BACKUP_S3_REGION`, `BACKUP_S3_PREFIX` | none |

No `SEED_PASSWORD` on production: production is never seeded.

The deployment token needs Workers Scripts:Edit, D1:Edit and Workers Routes:Edit. The backup
token needs only account-scoped **D1 Read** — which is why it lives in its own environment:
the nightly export runs unattended on a schedule, and an environment with a required reviewer
would make it sit waiting for approval every night. That permission is account-scoped rather
than per database, so use a dedicated Cloudflare account where database-level credential
isolation matters. `docs/repository-settings.md` lists all of it as a checklist.

`STAGING_URL` and `PRODUCTION_URL` are the origins the smoke script calls; `wrangler.jsonc`
carries the matching `APP_URL` per environment. They have to agree.

## CI

`.github/workflows/ci.yml`, on every pull request and every push to `main`. Three jobs, and the
Worker is built **once**:

| Job | Needs | Does |
| --- | --- | --- |
| `verify` | — | `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:integration` |
| `worker` | `verify` | `pnpm verify:worker` (build + boot + smoke on its own temporary D1), then uploads `dist/` as the `worker-bundle` artifact with `include-hidden-files: true` |
| `e2e` | `worker` | Downloads that artifact into `dist/`, installs Chromium, runs `pnpm test:e2e`, uploads `playwright-report/` on failure |

`include-hidden-files` is not incidental: `dist/.assetsignore` keeps the Worker script out of
the asset manifest, so the bundle is only complete with it.

No `.dev.vars` is written in CI. `scripts/e2e-server.mjs` generates its own Wrangler
configuration in a temporary directory and sets
`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`, so the browser suite is independent of any
developer file.

Concurrency is grouped per ref with cancellation, timeouts are 20 minutes for `verify` and 30
for the others, and `CI / verify`, `CI / worker` and `CI / e2e` are the required checks on
`main`.

## Staging

`.github/workflows/deploy-staging.yml`, triggered by `workflow_run` on `CI` completing
successfully on `main` (plus `workflow_dispatch`, restricted to `main`). Environment: `staging`.

In order:

1. **Prove the SHA.** The run requires a completed, successful `ci.yml` run of *this*
   repository on `main` for that exact commit (`scripts/validate-ci-run.mjs`). A manual
   dispatch performs the same exact-SHA lookup.
2. **Write the manifest.** An immutable `deployment-manifest` artifact
   `{ repository, sha, sourceCiRunId }` (`scripts/write-deployment-manifest.mjs`).
3. `pnpm install --frozen-lockfile`, `pnpm build:worker`.
4. **Upload** `worker-bundle-<sha>` and `deployment-manifest`, 90-day retention. This bundle is
   what production will promote.
5. `pnpm db:migrate:staging`.
6. `pnpm deploy:staging`.
7. **Reset the QA scenario**: `node scripts/seed.mjs --target d1-remote --env staging --reset
   --base-url "$STAGING_URL"`. The seed script refuses `--env production` and any base URL
   containing "production" outright.
8. **Smoke** in staging mode as the QA owner.
9. Record the commit, the source CI run, the artifact name and the deploy/smoke status in the
   job summary.

Migrations run before the deploy, so every migration must be backwards compatible with the
Worker version still serving traffic. See `docs/database-and-migrations.md` § *Expand and
contract*.

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

1. Validate the run id as digits, and read the staging run's metadata.
2. Download that run's `deployment-manifest`; read and validate its `sourceCiRunId`.
3. `scripts/validate-staging-run.mjs` — the staging run's workflow path, repository, branch,
   status and conclusion; the manifest's repository and SHA; and that the manifest names the CI
   run that actually verified that SHA.
4. **Check out that SHA**, so the migrations, the lockfile, the Wrangler configuration and the
   tool versions all come from the promoted commit.
5. Download `worker-bundle-<sha>` from that run.
6. `scripts/verify-promotion-artifact.mjs` — `dist/BUILD_INFO.json.sha`, `git rev-parse HEAD`
   and the manifest SHA must all agree, and `dist/_worker.js/PATCHED.json` must match the
   SHA-256 of the downloaded `index.js`. A missing marker is a hard failure, so an unpatched
   bundle cannot reach production.
7. Record `wrangler d1 time-travel info <app>-production --env production --json` and
   `wrangler deployments list --env production --json` into the job summary.
8. `pnpm db:migrate:production`.
9. `pnpm deploy:production`.
10. The read-only production smoke.
11. On failure, append the bookmark, the previous deployments and both rollback commands to the
    job summary.

Nothing is rebuilt. Inputs never reach shell code unchecked — the run id is validated as digits
and every value is passed through an environment variable. A non-cancelling
`deploy-production` concurrency group serialises promotions, so a second one queues rather than
replacing the first.

## Promotion provenance

Worth its own section because it is the subtlest part of the pipeline.

A `workflow_run`-triggered run's own `head_sha` describes the context the workflow *file* was
loaded from, which is not necessarily the commit the triggering CI run verified. Two staging
runs can report the same `head_sha` having deployed different commits. A promotion keyed on it
could check out configuration and migrations from one commit and deploy a bundle built from
another.

So provenance is a **manifest, not a field**. Staging proves the SHA at the moment it deploys
and writes `{ repository, sha, sourceCiRunId }` as an immutable artifact; production
re-validates all three and then verifies the bundle's own `BUILD_INFO.json`, the checked-out
`HEAD` and the patch marker's hash against it. `tests/guards/deployment-validation.test.mjs`
unit-tests every refusal: a failed run, an unrelated workflow, the wrong branch, the wrong
repository, an incomplete run, the wrong SHA, a mismatched manifest and a tampered bundle hash.

**No Cloudflare "Connect to GitHub" / Workers Builds integration.** Deployments come from
GitHub Actions only, because a build triggered inside Cloudflare cannot be tied to the artifact
a staging run verified — which is the whole guarantee above.

## Smoke tests

```bash
# after `pnpm dev:worker`
node scripts/worker-smoke.mjs --base-url http://127.0.0.1:8787 --mode local \
  --qa-email owner@example.invalid --qa-password "$SEED_PASSWORD" --expect-org-id org_acme

# staging, as the QA owner
node scripts/worker-smoke.mjs --base-url "$STAGING_URL" --mode staging \
  --qa-email owner@example.invalid --qa-password "$SEED_PASSWORD" --expect-org-id org_acme

# production — public, read-only checks only
node scripts/worker-smoke.mjs --base-url "$PRODUCTION_URL" --mode production
```

The production mode does not sign in, does not write and does not touch agent chat: a
deployment check must not create rows in a customer's database. It verifies `ping`, `health`
with `db: true` and `dialect: "d1"`, `/api/ready` with `applied === expected`, `GET /sign-in`,
`GET /` (200 — the static shell; **never** expect a 302), an unauthenticated action returning
401, and `POST /mcp` returning 401 with a `WWW-Authenticate` challenge.

Staging and local additionally sign in, list jobs, perform a reversible write (a `create-job`
with an idempotency key, then `archive-job`) and check that agent chat returns an event stream.
The table of which check runs where is in `docs/testing.md`.

## Cloudflare Access on staging

Optional, and staging only. Putting Cloudflare Access in front of staging means only people in
your Access policy can reach it at all, before the application's own sign-in — useful when
staging carries realistic-looking data and you would rather it were not indexable or reachable.

Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application**
→ Self-hosted → the staging hostname → a policy allowing your team's email domain or identity
provider group.

Two consequences before you turn it on: the staging smoke in the deployment workflow will start
getting Access's login page instead of the app, so the workflow needs an Access **service
token** (`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers) added to the smoke request;
and a browser session for staging now has two sign-ins.

**Never on production.** The application authenticates its own users with Google and requires
membership; a second identity fence would double the sign-in surface and the number of places a
lockout can happen, without adding a guarantee.

## The Node + libSQL fallback

This is Cloudflare-first, not Cloudflare-only. The repository layer talks to the framework's
executor and uses no D1 feature beyond `atomicBatch`, for which `runAtomic` already has a
`transaction` branch that the Node dev server and the integration suite exercise on every run.
So a Node deployment with libSQL needs no repository changes.

What it does need: a `DATABASE_URL`, migrations applied by `scripts/migrate-local.mjs` or your
own tooling over the same plain SQLite files, somewhere to run the process, and a different
deployment pipeline — nothing in `.github/workflows/deploy-*.yml` applies.

The reason to keep the option open is the compatibility patch. If a framework upgrade ever
needs substantially more runtime surgery than two stub getters, moving to Node is the safer
answer than growing the patch. `docs/upgrade-playbook.md` states that as a rule, and
`docs/database-and-migrations.md` has the database side.
