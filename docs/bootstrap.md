# Bootstrap: from template to a running application

This is the checklist for turning a fresh copy of this template into a deployed application
with a staging and a production environment. It covers the seventeen setup steps the
specification asks for, and it says for each one whether `scripts/bootstrap.mjs` does it or
you do.

Most of it is automated. The script performs every step that is a machine operation —
applications, databases, the link between them, every application setting, GitHub
environments, secrets, variables, branch protection — from one git-ignored input file. What is
left for you is the handful of things that need a browser, a payment method or a human
decision.

Two rules the script follows, so you can trust it:

- **It never creates anything without `--yes`.** The default is `--plan`, which makes only
  read-only calls and prints what it would do. Run the plan first, read it, then apply it.
- **No secret ever reaches your shell history, your terminal or a log.** Values come from the
  input file or the process environment and are handed to `clever` and `gh` on standard
  input. Every line the script prints is filtered, so a value
  shows as `<redacted>`.

Where a step is automated the table below names the script step, which you can run on its own
with `--only <step>`.

| # | Spec step | Who does it |
| --- | --- | --- |
| 1 | Rename the application | You: `scripts/rename-app.mjs` (step 5 below) |
| 2 | Update package metadata | You: same script, plus the `description` field |
| 3 | Configure the Clever Cloud account | You: account, payment method, `clever login` (steps 1–2) |
| 4 | Create the staging application and database | Script: `apps`, `postgres` |
| 5 | Create the production application and database | Script: `apps`, `postgres` |
| 6 | Link each database to its application | Script: `postgres` |
| 7 | Configure staging/production settings | Script: `app-env` |
| 8 | Configure the Better Auth secret | Script: `app-env` (generated per environment) |
| 9 | Configure Google OAuth | You create the client (step 3); the script stores it |
| 10 | Configure GitHub environments | Script: `github-environments` |
| 11 | Configure staging and production URLs | Script: read back from the platform |
| 12 | Configure backups | Nothing to do: the database plan includes them |
| 13 | Run migrations | The deploy workflow, before every deploy |
| 14 | Run the local seed | You: `pnpm db:seed` (step 6) |
| 15 | Run the whole CI suite | You: `pnpm check` and friends (step 7) |
| 16 | First staging deployment | Script: `deploy`; every later one comes from CI |
| 17 | First production deployment | You: dispatch the workflow (step 15) |

Deployments come from GitHub Actions only: this repository does not use a platform-side git
integration, because production must deploy the exact commit that a staging run already
verified (D21), and a build triggered inside the platform cannot be tied to that run.

---

## Prerequisites

### 1. Create a Clever Cloud account

<https://console.clever-cloud.com/> — and add a payment method, because the PostgreSQL plan
this starter uses is not free.

**The free `dev` plan cannot run this application.** It allows five connections; the framework
opens a pool of twenty on a long-lived Node server, hardcoded, with no environment variable and
no configuration hook. The failure is `too many connections for role` before the first request
is served. `xxs_sml` is the smallest plan that works — 5.25 EUR per month per environment at
the time of writing, with daily backups and seven-day retention.

### 2. Log the CLI in, once

```bash
npx clever-tools login
```

It opens a browser, you approve, and the CLI stores a profile in `~/.config/clever-cloud/`.
That is the only Clever Cloud credential involved: the bootstrap script reads it for its own
calls and copies it into the two GitHub secrets CI deploys with, so **nothing goes in
`.bootstrap.env`** and no token is ever pasted anywhere.

### 3. Create the Google OAuth client

This step needs the public origins of your two environments, and you do not have them yet:
Clever Cloud assigns a `cleverapps.io` domain when it creates each application, and the
bootstrap script reads it back. So **do the bootstrap run first** (steps 9–11), then come back
here with the two URLs it printed — or, if you already own a domain and have pointed it at the
applications, set `STAGING_URL` and `PRODUCTION_URL` in the input file and use those.

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

One database, one seed: both `pnpm dev` and `pnpm start` read `DATABASE_URL`, which defaults to
`data/app.db`. A sign-in page that rejects every password usually means that database is empty
rather than the password wrong.

`pnpm test:e2e` needs no `.env` at all: it starts the built server on its own temporary
database with its own throwaway `BETTER_AUTH_SECRET`.

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
pnpm test:e2e:full      # builds the server and runs the browser suite against it
```

All three must pass before you deploy anything. `pnpm test:e2e:full` needs Chromium once:
`pnpm exec playwright install --with-deps chromium`. It builds and boots the real server on its
own temporary database, so it depends on no local file.

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
| `APP_NAME` | The kebab name from step 5. Must equal `app.id` in `server/plugins/config.ts`. |
| `GITHUB_REPO` | `owner/name` of the repository from step 8. |
| `GOOGLE_SIGN_IN_CLIENT_ID`, `GOOGLE_SIGN_IN_CLIENT_SECRET` | Step 3 — which you may not have done yet; see the note there. |
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com/> → API keys. The embedded agent uses it (D15). |
| `SEED_PASSWORD` | Invent one, 16 characters or more. Staging QA accounts only. |

Optional but recommended:

- `PRODUCTION_REVIEWERS` — comma-separated GitHub logins who may approve a production
  promotion. Without at least one, the script refuses to create the `production` environment
  unless you pass `--allow-unprotected-production`.
- `TEMPLATE_REPOSITORY=1` — only if this copy is itself meant to be a template.
- `CLEVER_REGION` — default `par` (Paris). European alternatives: `parhds`, `rbx`, `rbxhds`,
  `grahds`, `wsw`, `ldn`.
- `POSTGRES_PLAN` — default `xxs_sml`. Larger: `xs_sml`, `s_sml`, `m_sml`. `dev` is refused.
- `STAGING_URL`, `PRODUCTION_URL` — only for a custom domain you already own. Left empty, the
  script reads back the domain the platform assigned.

### 10. Read the plan

```bash
node scripts/bootstrap.mjs --plan
```

This makes read-only calls only: `clever version`, `clever profile`, `clever applications`,
`clever addon list`, `gh auth status`, `gh repo view`, and GET requests for the GitHub
environments and the branch protection. It prints one line per thing it would do, with the
exact command underneath and every secret shown as `<redacted>`.

Read it. In particular:

- It will create **two applications and two PostgreSQL add-ons** in the region
  `CLEVER_REGION` names, defaulting to Paris, on the plan `POSTGRES_PLAN` names, defaulting to
  `xxs_sml`. That plan is not free. `dev` is refused, and the refusal explains why.
- It will give each application a **dedicated M build instance**. The default builder shares
  the application's own instance and is killed installing a thousand packages. It is billed per
  build minute, not continuously.
- It will **deploy once per environment**, because the seed and the smoke both need a running
  application. That first deployment is the only one that ever happens from a laptop; every
  later one comes from GitHub Actions.
- It changes **nothing in this repository**. The applications, their databases and their
  settings all live on the platform; there is no configuration file to commit afterwards.

If a key is missing the script says which and exits 0 without calling anything. If `APP_NAME`
disagrees with `server/plugins/config.ts`, or the CLI is not logged in, or
`PRODUCTION_REVIEWERS` is empty, it refuses and explains.

### 11. Apply it

```bash
node scripts/bootstrap.mjs --yes
```

Every step reports `created`, `already present` or `skipped`, so a re-run after a failure is
safe and tells you what it did not have to repeat. Run a single step with, for example,
`--only app-env`.

Nothing in the repository changed, so there is nothing to commit.

What the run leaves behind:

- Two Node applications, `<APP_NAME>-staging` and `<APP_NAME>-production`, each with a
  dedicated M build instance and a domain the platform assigned.
- Two PostgreSQL add-ons, `<APP_NAME>-staging-db` and `<APP_NAME>-production-db`, each linked
  to its application so `POSTGRESQL_ADDON_URI` is injected. The connection string is recorded
  nowhere else.
- Every application setting per environment, including `BETTER_AUTH_SECRET` and
  `OAUTH_STATE_SECRET` generated separately for each from 32 random bytes and never written to
  any file; the two Google credentials; `ANTHROPIC_API_KEY`; and `SEED_PASSWORD` on staging
  only, because production is never seeded.
- Two GitHub environments: `staging` (no reviewers) and `production` (required reviewers).
- GitHub secrets and variables per environment, exactly the set the workflows read —
  `CLEVER_TOKEN` and `CLEVER_SECRET` from the CLI profile, and `CLEVER_APP_NAME` so a workflow
  can link a checkout to the right application.
- Branch protection on `main`: pull requests required, the `CI / verify` and `CI / e2e` checks
  required, no force pushes, no deletions.

An existing GitHub environment is reported `already present` and left exactly as it is, so a
reviewer list you curated by hand is never overwritten. To replace the generated signing
secrets, pass `--rotate` — and note that doing so signs every user of that environment out.

**Write down the two URLs it printed.** They are what the Google OAuth client's redirect URIs
need (step 3), and what `APP_URL` was set to.

Delete `.bootstrap.env` when you are done.

---

## First deployment

### 12. Migrate staging

```bash
node scripts/migrate.mjs --addon <APP_NAME>-staging-db
```

This applies `migrations/*.sql` to the staging database. `--addon` resolves the connection
string through the Clever Cloud CLI in-process, so it never appears in a log or a command line.
Every later migration runs inside the deploy workflow, before the deploy — this one is by hand
only because nothing has deployed yet. The framework's own tables are not in there
and are not your job: it creates them itself on the first request that touches the database
(D06).

Confirm:

```bash
curl -s https://<staging host>/api/ready
# {"ready":true,"migrations":{"applied":2,"expected":2,"missing":[]}}
```

### 13. Let CI deploy staging

From here on staging deploys itself. Merge to `main`; `CI` runs; when it succeeds
`deploy-staging.yml` writes the promotion manifest, migrates, deploys, resets the QA scenario
and runs the staging smoke.

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
   node scripts/bootstrap-org.mjs --env staging \
     --name "Acme Services" --owner owner@acme.example
   ```

   It reaches the database through the add-on, with bound parameters, and prints the SQL but
   never the connection string. `--dry-run` prints the statements first. The script refuses to run without
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
two mechanisms are complementary: the application setting closes sign-up, the organization
setting closes sign-in.

### 16. Check the backups exist

Nothing to configure: the `xxs_sml` plan takes a daily backup with seven-day retention. Confirm
it rather than assume it:

```bash
clever addon list                               # find the production add-on's id
clever database backups <addon-id>
```

If that list is empty the morning after the first deploy, something is wrong with the plan
rather than with this repository. `docs/backups.md` covers what is and is not covered, and how
to test a restore against staging before you need one for real.

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
verifies it is the one staging proved, records the database backups that exist, migrates,
deploys and runs the read-only production smoke. `docs/deployment.md` explains each of those checks and
`docs/runbook.md` is what to do when one of them fails.

---

## Finally: what to delete and what to keep

Delete:

- **`.bootstrap.env`.** It holds three secrets in one file and has done its job.
- **The seating domain**, when you are ready to build your own: `src/domain/event.ts`,
  `src/domain/seating-table.ts`, their use cases, actions, migrations, UI routes and tests. Keep the
  shapes — `docs/adding-a-feature.md` is written around them.
- **The seeded QA users on staging**, if you would rather not have password accounts there at
  all: remove `SEED_ENABLED` and `SEED_PASSWORD` from the staging application's settings and
  from `scripts/bootstrap.mjs`, and drop the seed and smoke steps from `deploy-staging.yml`. You lose the
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
