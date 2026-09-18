# Bootstrap: from template to a running application

This is the checklist for turning a fresh copy of this template into a deployed application
with a staging and a production environment. It covers the seventeen setup steps the
specification asks for, and it says for each one whether `scripts/bootstrap.mjs` does it or
you do.

Most of it is automated. The script performs every step that is a machine operation — D1
databases, Wrangler ids, Worker secrets, GitHub environments, secrets, variables, branch
protection — from one git-ignored input file. What is left for you is the handful of things
that need a browser, a payment method or a human decision.

Two rules the script follows, so you can trust it:

- **It never creates anything without `--yes`.** The default is `--plan`, which makes only
  read-only calls and prints what it would do. Run the plan first, read it, then apply it.
- **No secret ever reaches your shell history, your terminal or a log.** Values come from the
  input file or the process environment and are handed to `wrangler` and `gh` on standard
  input or through the child environment. Every line the script prints is filtered, so a value
  shows as `<redacted>`.

Where a step is automated the table below names the script step, which you can run on its own
with `--only <step>`.

| # | Spec step | Who does it |
| --- | --- | --- |
| 1 | Rename the application | You: `scripts/rename-app.mjs` (step 5 below) |
| 2 | Update package metadata | You: same script, plus the `description` field |
| 3 | Configure the Cloudflare account | You: Paid plan and API token (steps 1–2) |
| 4 | Create staging D1 in the EU jurisdiction | Script: `d1` |
| 5 | Create production D1 in the EU jurisdiction | Script: `d1` |
| 6 | Configure Worker bindings | Script: `d1` (writes `database_id` and `APP_URL`) |
| 7 | Configure staging/production secrets | Script: `worker-secrets` |
| 8 | Configure the Better Auth secret | Script: `worker-secrets` (generated per environment) |
| 9 | Configure Google OAuth | You create the client (step 3); the script stores it |
| 10 | Configure GitHub environments | Script: `github-environments` |
| 11 | Configure staging and production URLs | Script: `d1` and `github-secrets` |
| 12 | Configure the backup destination | You create the bucket; the script stores the keys |
| 13 | Run migrations | You: `pnpm db:migrate:staging`; production runs in the workflow |
| 14 | Run the local seed | You: `pnpm db:seed` (step 6) |
| 15 | Run the whole CI suite | You: `pnpm check` and friends (step 7) |
| 16 | First staging deployment | Script: `deploy`; every later one comes from CI |
| 17 | First production deployment | You: dispatch the workflow (step 15) |

Deployments come from GitHub Actions only: this repository does not use Cloudflare's
"Connect to GitHub" / Workers Builds integration, because production must deploy the exact
artifact that a staging run already verified (D21), and a build triggered inside Cloudflare
cannot be tied to that artifact.

---

## Prerequisites

### 1. Enable the Workers Paid plan

The Worker bundle is about 4 MB compressed. The Workers Free plan allows 3 MB, the Paid plan
10 MB (D04), so the starter requires Paid — 5 USD per month at the time of writing.

Cloudflare dashboard → **Workers & Pages** → **Plans** → Workers Paid.

Note the account id while you are there: **Workers & Pages** → the right-hand sidebar, under
**Account details** → **Account ID**. It is `CLOUDFLARE_ACCOUNT_ID`.

### 2. Create a Cloudflare API token

Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token** → use the
**Edit Cloudflare Workers** template, then add one more permission:

- **Account** → **D1** → **Edit**

The template already grants Workers Scripts:Edit and Workers Routes:Edit. Scope the token to
the one account you just noted. Copy the value once — Cloudflare will not show it again. It is
`CLOUDFLARE_API_TOKEN`.

### 3. Create the Google OAuth client

You need the public origins of your two environments before this step, because the redirect
URIs contain them. Pick them now (for example `https://staging.example.com` and
`https://app.example.com`) and use the same values in the input file.

Google Cloud console → **APIs & Services**:

1. **OAuth consent screen** → User type **Internal** if the company uses Google Workspace,
   which is the intended configuration: only accounts in that Workspace can sign in, and no
   Google verification review is needed. Add no scopes beyond the defaults; the app asks for
   identity only.
2. **Credentials** → **Create credentials** → **OAuth client ID** → Application type
   **Web application**.
3. Under **Authorized redirect URIs**, add one per environment:

   ```
   https://<staging host>/_agent-native/google/callback
   https://<production host>/_agent-native/google/callback
   ```

   That path is the framework's own Google callback route. It is worth being exact here: a
   mismatch is rejected by Google with `redirect_uri_mismatch` and no other symptom. You can
   confirm the path against your own build at any time by starting the app locally with the
   client id set and reading the `redirect_uri` out of the URL the framework generates:

   ```bash
   curl -s http://localhost:8080/_agent-native/google/auth-url
   ```

   For local development add `http://localhost:8080/_agent-native/google/callback` as well —
   though local sign-in normally uses the seeded password accounts instead
   (`docs/authentication-and-authorization.md`).
4. Copy the client id and client secret. They are `GOOGLE_SIGN_IN_CLIENT_ID` and
   `GOOGLE_SIGN_IN_CLIENT_SECRET`.

### 4. Install the Renovate GitHub App

Dependency updates arrive as pull requests from Renovate, not Dependabot (D22), and the app
has to be installed by somebody with admin rights on the repository:
<https://github.com/apps/renovate> → **Configure** → select the repository. `renovate.json` in
this repository is the configuration; nothing else is needed.

You also need the [GitHub CLI](https://cli.github.com/) authenticated once:

```bash
gh auth login
gh auth status
```

---

## Rename and check locally

### 5. Rename the application

The sample ships as `seating-arrangement` / "Seating Arrangement" (D18). Replace both:

```bash
node scripts/rename-app.mjs --name acme-ops --display "Acme Ops"
```

It prints every file it changed. `--dry-run` lists them without writing. It deliberately
leaves `docs/plan/**` alone: that directory is the implementation plan, a historical record
whose text states that the sample was called `seating-arrangement`.

Then finish the package metadata by hand — the script sets `name`, but `description` is prose:

```jsonc
// package.json
"name": "acme-ops",
"displayName": "Acme Ops",
"description": "Field service scheduling for Acme.",
```

Review the diff, then continue.

### 6. Install, migrate, seed and run

```bash
pnpm install
cp .env.example .env
# put a 32-character-or-longer value in BETTER_AUTH_SECRET:
#   openssl rand -hex 32
pnpm db:reset
pnpm dev
```

`.dev.vars` is optional here, and worth understanding before you reach step 7. It is where
Wrangler reads secrets for the Worker (`pnpm dev:worker`), but when it is absent Wrangler falls
back to `.env`, so a fresh clone with only `.env` runs the Worker fine. Copy
`.dev.vars.example` to `.dev.vars` when you want the Worker to use *different* values from the
Node dev server — a separate `ANTHROPIC_API_KEY` or `SEED_PASSWORD`, say. `pnpm verify:worker`
and `pnpm test:e2e:full` need neither file: each injects its own throwaway `BETTER_AUTH_SECRET`
and runs on its own temporary state.

What does matter before step 7 is that the two local runtimes have **separate databases, and
separate seeds**. `pnpm dev` serves `data/app.db` and is seeded by `pnpm db:seed`;
`pnpm dev:worker` serves the local D1 under `.wrangler/` and is seeded by
`pnpm db:seed:worker`. Seeding one does nothing for the other, and the symptom is confusing: a
sign-in page that rejects every password usually means the database behind it is empty rather
than the password wrong. `README.md` has the one-line query that tells those apart.

Leave `pnpm dev` running and, in a second terminal:

```bash
pnpm db:seed
```

The seed has to run against a database the app has already opened: the framework creates its
own tables (users, organizations, audit log) during the first request that touches the
database, and the seed inserts organization rows into them (F8). `pnpm dev` does that at boot,
so a started dev server is enough. Sign in at <http://localhost:8080> as
`owner@example.invalid` with the `SEED_PASSWORD` from `.env`.

### 7. Run the whole suite once

Everything CI runs, in the order CI runs it:

```bash
pnpm check              # lint, typecheck, framework doctor, boundaries, config, unit, guards, i18n
pnpm test:integration   # the repositories and the CLI surface against a real SQLite file
pnpm verify:worker      # builds the Worker and smokes it on its own temporary D1
pnpm test:e2e:full      # builds the Worker and runs the browser suite against it
```

All four must pass before you deploy anything. `pnpm test:e2e:full` needs Chromium once:
`pnpm exec playwright install --with-deps chromium`. The last two build and boot the real
Worker on their own temporary D1, so they depend on neither `.env` nor `.dev.vars`.

### 8. Push the repository

Create the repository under the account that will own the application — normally the
customer's GitHub organization, not yours (`docs/template-workflow.md`) — and push `main`.
The bootstrap script needs the repository to exist, and CI has to have run at least once on
`main` before staging will deploy anything.

---

## Run the bootstrap script

### 9. Fill in the input file

```bash
cp .bootstrap.env.example .bootstrap.env
```

Open `.bootstrap.env` and fill in every key. The file is git-ignored; the committed example
carries names only. Every key is documented in the example itself. The required ones:

| Key | Where it comes from |
| --- | --- |
| `APP_NAME` | The kebab name from step 5. Must equal the top-level `name` in `wrangler.jsonc`. |
| `GITHUB_REPO` | `owner/name` of the repository from step 8. |
| `STAGING_URL`, `PRODUCTION_URL` | The two https origins from step 3, no trailing slash. |
| `CLOUDFLARE_ACCOUNT_ID` | Step 1. |
| `CLOUDFLARE_API_TOKEN` | Step 2. |
| `GOOGLE_SIGN_IN_CLIENT_ID`, `GOOGLE_SIGN_IN_CLIENT_SECRET` | Step 3. |
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com/> → API keys. The embedded agent uses it (D15). |
| `SEED_PASSWORD` | Invent one, 16 characters or more. Staging QA accounts only. |

Optional but recommended:

- `PRODUCTION_REVIEWERS` — comma-separated GitHub logins who may approve a production
  promotion. Without at least one, the script refuses to create the `production` environment
  unless you pass `--allow-unprotected-production`.
- `TEMPLATE_REPOSITORY=1` — only if this copy is itself meant to be a template.
- The `BACKUP_*` keys — see step 16.

### 10. Read the plan

```bash
node scripts/bootstrap.mjs --plan
```

This makes read-only calls only: `wrangler --version`, `wrangler whoami`, `wrangler d1 list`,
`wrangler deployments list`, `wrangler secret list`, `gh auth status`, `gh repo view`, and GET
requests for the GitHub environments and the branch protection. It prints one line per thing
it would do, with the exact command underneath and every secret shown as `<redacted>`.

Read it. In particular:

- It will create two D1 databases in the **EU** jurisdiction. Jurisdiction cannot be changed
  later; if you need another one, edit the `--jurisdiction` argument in
  `scripts/bootstrap.mjs` first.
- It will run `pnpm build:worker` and `wrangler deploy` once per environment, because
  `wrangler secret put` requires the Worker to exist. That first deployment is the only one
  that ever happens from a laptop; every later one comes from GitHub Actions.
- It will rewrite `wrangler.jsonc` in place, filling in `env.staging` and `env.production`
  `database_id` and `vars.APP_URL`. Comments and formatting are preserved.

If a key is missing the script says which and exits 0 without calling anything. If `APP_NAME`
disagrees with `wrangler.jsonc`, or `PRODUCTION_REVIEWERS` is empty, or a URL is not an https
origin, it refuses and explains.

### 11. Apply it

```bash
node scripts/bootstrap.mjs --yes
```

Every step reports `created`, `already present` or `skipped`, so a re-run after a failure is
safe and tells you what it did not have to repeat. Run a single step with, for example,
`--only worker-secrets`.

Then commit the file it changed — the deployment workflows read `wrangler.jsonc` from git, so
an id that exists only on your laptop deploys nothing:

```bash
git add wrangler.jsonc
git commit -m "chore: staging and production D1 ids and URLs"
```

What the run leaves behind:

- Two D1 databases, EU jurisdiction, named `<APP_NAME>-staging` and `<APP_NAME>-production`.
- One Worker per environment, deployed once.
- Worker secrets per environment: `BETTER_AUTH_SECRET` and `OAUTH_STATE_SECRET`, generated
  separately for each environment from 32 random bytes and never written to any file; the two
  Google credentials; `ANTHROPIC_API_KEY`; and `SEED_PASSWORD` on staging only, because
  production is never seeded.
- Three GitHub environments: `staging` (no reviewers), `production` (required reviewers),
  `production-backup` (no reviewers, so the nightly export runs unattended — see
  `docs/repository-settings.md` for why the split exists).
- GitHub secrets and variables per environment, exactly the set the workflows read.
- Branch protection on `main`: pull requests required, the `CI / verify`, `CI / worker` and
  `CI / e2e` checks required, no force pushes, no deletions.

An existing GitHub environment is reported `already present` and left exactly as it is, so a
reviewer list you curated by hand is never overwritten. To replace secrets that already exist,
pass `--rotate` — and note that rotating `BETTER_AUTH_SECRET` or `OAUTH_STATE_SECRET` signs
every user of that environment out.

Delete `.bootstrap.env` when you are done.

---

## First deployment

### 12. Migrate staging

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... pnpm db:migrate:staging
```

This applies `migrations/*.sql` to the staging D1. The framework's own tables are not in there
and are not your job: it creates them itself on the first request that touches the database
(D06).

Confirm:

```bash
curl -s https://<staging host>/api/ready
# {"ready":true,"migrations":{"applied":2,"expected":2,"missing":[]}}
```

### 13. Let CI deploy staging

From here on staging deploys itself. Merge to `main`; `CI` runs; when it succeeds
`deploy-staging.yml` builds the Worker, uploads the promotion artifact, migrates, deploys,
resets the QA scenario and runs the staging smoke.

```bash
gh run list --workflow=deploy-staging.yml --limit 5
```

### 14. Create the organization

Membership is invite-only and `AUTO_CREATE_DEFAULT_ORG=0` in every environment (D11). The app
also denies the framework's authenticated organization-creation route, its domain-join route and
the write that would enable domain auto-join, so the first person to sign in has an account and
no organization, and every action fails with `No active organization`. Somebody has to write the
first membership row.

1. Open `https://<staging host>` and sign in with Google as the person who will own the
   organization. This also proves the OAuth client and the redirect URI are right.
2. Create the organization and that person's owner membership:

   ```bash
   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
     node scripts/bootstrap-org.mjs --env staging \
       --name "Acme Services" --owner owner@acme.example
   ```

   `--dry-run` prints the exact command and SQL first. The script refuses to run without
   `--env`, and re-running it with the same name inserts nothing.
3. Reload the app. The Team page now shows the organization, and the owner can invite the
   rest of the team from there.

Repeat both for production after step 15.

### 15. Require Google sign-in

With the organization in place, close the password door for it: **Team** → **Organization** →
**Organization sign-in** → turn on **Require Google sign-in**, and confirm the dialog.

This revokes every current session in that organization and rejects every future non-Google
sign-in for its members. Only do it once Google sign-in has actually worked (step 14.1).

Production additionally sets `AUTH_REQUIRE_EMAIL_VERIFICATION=1` with no email provider
configured, which is what makes the framework refuse password sign-up there at all (D11). The
two mechanisms are complementary: the Worker var closes sign-up, the organization setting
closes sign-in.

### 16. Configure the backup destination

The nightly export works without this — it keeps the dump as a GitHub artifact for 30 days —
but an artifact in the same account as the code is not a backup destination. Create an
S3-compatible bucket in a **different account or provider**, then add the keys to
`.bootstrap.env` and re-run just that step:

```bash
node scripts/bootstrap.mjs --plan --only github-secrets
node scripts/bootstrap.mjs --yes  --only github-secrets
```

Set `BACKUP_AGE_RECIPIENT` too: the dump is every application row and every user record in plain
SQL. `docs/backups.md` covers the strategy, the retention rules and the tested restore.

### 17. Deploy production

Production is a manual promotion of the exact artifact a staging run already verified. It
never rebuilds.

1. Create the production organization the same way as step 14, once production has served its
   first request:

   ```bash
   node scripts/bootstrap-org.mjs --env production --name "Acme Services" --owner owner@acme.example
   ```

   (Production has no seed and no QA accounts. Sign in with Google first, then run this.)
2. Find the staging run to promote:

   ```bash
   gh run list --workflow=deploy-staging.yml --status success --limit 5
   ```
3. Dispatch the promotion with that run id:

   ```bash
   gh workflow run deploy-production.yml -f staging_run_id=<id> -f confirm=deploy
   ```
4. Approve it. The `production` environment requires a reviewer, so the run waits for one of
   the logins from `PRODUCTION_REVIEWERS`.

The run validates the staging run and its deployment manifest, checks out that exact commit,
downloads that exact bundle, records a D1 Time Travel bookmark, migrates, deploys and runs the
read-only production smoke. `docs/deployment.md` explains each of those checks and
`docs/runbook.md` is what to do when one of them fails.

---

## Finally: what to delete and what to keep

Delete:

- **`.bootstrap.env`.** It holds four secrets in one file and has done its job.
- **The seating domain**, when you are ready to build your own: `src/domain/event.ts`,
  `src/domain/seating-table.ts`, their use cases, actions, migrations, UI routes and tests. Keep the
  shapes — `docs/adding-a-feature.md` is written around them.
- **The seeded QA users on staging**, if you would rather not have password accounts there at
  all: unset `SEED_ENABLED` and `SEED_PASSWORD` in `wrangler.jsonc` and the staging
  environment, and drop the seed and smoke steps from `deploy-staging.yml`. You lose the
  staging smoke's authenticated half.
- **`docs/plan/`**, once you have read what you need from it. It is the implementation plan
  for the template, not documentation for your application.

Keep:

- **`AGENTS.md`, `ARCHITECTURE.md` and `docs/`.** They are what makes a coding agent produce
  the same shape of code you would. Edit them as the application changes.
- **`agent/AGENTS.md`.** That one is the deployed agent's system prompt. It must describe your
  actions, not the sample's.
- **The `nb-NO` review marker.** `app/i18n/nb-NO.ts` is wired behind a `@ts-expect-error` that
  becomes a compile error the moment the framework adds Norwegian to its locale list
  (D19, `docs/internationalization.md`). Delete the catalog if you do not need Norwegian;
  do not delete the marker while you keep the catalog.
- **`renovate.json` and `docs/upgrade-playbook.md`.** The framework moves fast; the playbook is
  what stops an upgrade from being a surprise.
