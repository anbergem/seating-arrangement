# T24 — Bootstrap script, checklist and rename script

Goal: a cross-platform Node bootstrap script that performs every automatable step of spec
section 43 from one git-ignored input file, the post-template checklist as `docs/bootstrap.md`
(script usage plus the remaining manual steps with exact commands), and a rename script.
Decision (maintainer, 2026-09-08, D28): Node, not PowerShell — Node is already required and the
repository's scripts are `.mjs`; the script drives `wrangler` and `gh` as subprocesses.

Depends on: T23. Read: F6, F10; B13, B14, B19, B20; D04, D11, D15, D18, D21, D22, D28.

## Steps

0. `scripts/bootstrap.mjs` (ESM, Node 22, no new dependencies) with `--plan` (default: print
   what would be done and exit 0), `--yes` (perform), `--only <step,...>`, `--env-file <path>`
   (default `.bootstrap.env`), `--allow-unprotected-production`. Inputs come only from the env
   file or the process environment, never from command-line arguments (shell history):
   `APP_NAME` (kebab; must equal the Worker base `name` in `wrangler.jsonc`), `GITHUB_REPO`
   (`owner/name`), `STAGING_URL`, `PRODUCTION_URL`, `CLOUDFLARE_ACCOUNT_ID`,
   `CLOUDFLARE_API_TOKEN` (passed to `wrangler` through the child environment and stored as the
   GitHub secret), `GOOGLE_SIGN_IN_CLIENT_ID`, `GOOGLE_SIGN_IN_CLIENT_SECRET`,
   `ANTHROPIC_API_KEY`, `SEED_PASSWORD`, optional `PRODUCTION_REVIEWERS` (comma-separated
   GitHub logins), optional `TEMPLATE_REPOSITORY=1`, optional backup values
   (`BACKUP_AGE_RECIPIENT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID`,
   `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_REGION`, `BACKUP_S3_PREFIX`). Commit
   `.bootstrap.env.example` with names only; add `.bootstrap.env` to `.gitignore` and to the
   ignored-file assertions in `scripts/check-config-hygiene.mjs`. Steps, each idempotent and
   each reporting `created` / `already present` / `skipped`:
   1. Preflight: `wrangler --version`, `wrangler whoami` (with the token), `gh auth status`,
      `gh repo view <GITHUB_REPO>`; refuse to continue when `wrangler.jsonc` top-level `name`
      differs from `APP_NAME`, and when `pnpm check` has not been run in this tree (check for
      `dist/BUILD_INFO.json` only when a first deployment is needed).
   2. D1: for `staging` and `production`, `wrangler d1 create <APP_NAME>-<env> --jurisdiction eu`
      unless `wrangler d1 list --json` already lists it. `d1 create` has no `--json` on 4.129.0,
      so after creating, re-run `wrangler d1 list --json` and read the `uuid` of the matching
      entry; refuse rather than guess if it is not reported. Write the `database_id` into
      `env.<env>.d1_databases[0].database_id` in `wrangler.jsonc` by editing the text in place
      (keep comments and formatting; re-parse with the same JSONC reader
      `check-config-hygiene.mjs` uses — extracted to `scripts/lib/jsonc.mjs` so both files
      share it) and set `env.<env>.vars.APP_URL` from `STAGING_URL` / `PRODUCTION_URL`. Do not
      use `wrangler d1 create --update-config`: it rewrites the file in a shape we do not
      control.
   3. First deployment when needed: `wrangler secret put` requires the Worker to exist; when
      `wrangler deployments list --env <env>` reports none, run `pnpm build:worker` once and
      `wrangler deploy --env <env>`. The plan output says this explicitly.
   4. Worker secrets: generate `BETTER_AUTH_SECRET` and `OAUTH_STATE_SECRET` with
      `crypto.randomBytes(32).toString("hex")` per environment (never reused across
      environments, never written to disk), then `wrangler secret put <NAME> --env <env>` with
      the value on stdin for `BETTER_AUTH_SECRET`, `OAUTH_STATE_SECRET`,
      `GOOGLE_SIGN_IN_CLIENT_ID`, `GOOGLE_SIGN_IN_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, and
      `SEED_PASSWORD` on staging only. Existing secrets are listed with
      `wrangler secret list --env <env>` and reported `already present` unless `--rotate` is
      given (rotating the signing secrets logs every user out; say so).
   5. GitHub environments with
      `gh api --method PUT repos/<repo>/environments/<name> --input -`, the JSON body on stdin:
      `staging` (no reviewers), `production` (reviewers from `PRODUCTION_REVIEWERS` resolved to
      ids via `gh api --method GET users/<login>`; refuse to create it without at least one
      reviewer unless `--allow-unprotected-production`), `production-backup` (no reviewers).
      An environment that already exists is reported `already present` and left exactly as it
      is, so a reviewer list curated by hand is never overwritten.
   6. GitHub secrets and variables: `gh secret set <NAME> --env <env> --repo <repo>` reading the
      value from stdin for `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (all three
      environments), `SEED_PASSWORD` (staging), and the backup secrets (production-backup, when
      provided); `gh variable set --env` for `STAGING_URL`, `PRODUCTION_URL` and the optional
      backup variables.
   7. Branch protection on `main`
      (`gh api --method PUT repos/<repo>/branches/main/protection --input -`, the JSON body on
      stdin rather than a temporary file: one channel for every body, nothing to clean up on a
      refusal path, and the guard test can assert the exact bytes): required status checks
      `CI / verify`, `CI / worker`, `CI / e2e`, pull requests required, no force pushes, no
      deletions; and `gh repo edit <repo> --template` when `TEMPLATE_REPOSITORY=1`.
   8. Print the manual checklist that cannot be automated: enable the Workers Paid plan; create
      the Cloudflare API token (template "Edit Cloudflare Workers" plus D1 Edit) before running
      the script; create the Google OAuth client with an internal consent screen and the
      verified redirect URIs; install the Renovate GitHub App; sign in once with Google and run
      `scripts/bootstrap-org.mjs`; enable "require Google sign-in" in the Team page.
   Every subprocess is spawned with an argument array (never a shell string); secret values are
   passed only through stdin or the child environment and never logged; `--plan` performs only
   read-only calls and prints each mutating command with secret values shown as `<redacted>`.
   Tests: `tests/guards/bootstrap.test.mjs` runs the script with a temporary `PATH` containing
   stub `wrangler` and `gh` executables that append their argv and stdin to a log file and
   return canned JSON; assert the plan output, idempotency (a second `--yes` run reports
   `already present` everywhere), the exact argument arrays, the refusal cases, and that no
   secret value appears in stdout or stderr.
1. `scripts/rename-app.mjs --name <kebab> --display "<Display Name>"`: replaces
   `example-jobs` with the kebab name and `Example Jobs` with the display name. It **walks the
   repository** rather than a hand-written list — the list this step first carried omitted seven
   load-bearing files, including `agent/AGENTS.md`, which is the runtime agent's system prompt
   (see `DISCREPANCIES.md`, 2026-09-08). It rewrites only files that actually contain one of the
   two strings, in `.ts`, `.tsx`, `.mjs`, `.sh`, `.md`, `.json`, `.jsonc`, `.yml`, `.yaml` and
   `*.example`, and prints every one. Excluded: `docs/plan/` (the plan is a historical record
   whose decision records state the sample's name; T26 deletes it), `pnpm-lock.yaml`,
   `tests/e2e/.auth/`, every generated or vendored tree, and `scripts/rename-app.mjs` itself,
   whose own constants are what it searches for. `package.json`'s `name` is set as a field,
   because it holds `agent-native-cloudflare-starter` and no string replacement would reach it.
   `--dry-run` lists without writing. Refuses names that are not `^[a-z][a-z0-9-]{2,40}$`, and a
   display name that is empty, over 60 characters, or contains a quote, a backslash or a
   newline. Finally it runs the repository's own `oxfmt --write` over the files it rewrote: a
   name of a different length changes where oxfmt breaks a line, so without this `pnpm check`
   fails on a file the script wrote (see `DISCREPANCIES.md`, 2026-09-08 — the same collision
   T06 hit with the generated migrations manifest). `.oxfmtrc.json`'s `ignorePatterns` are read
   rather than hard-coded, so a file oxfmt does not own is never handed to it.
2. `scripts/bootstrap-org.mjs --env <env> --name "<Org>" --owner <email>`: inserts the
   organization and its owner membership through `wrangler d1 execute <APP_NAME>-<env> --remote
   --env <env> --yes --command`, with every NOT NULL column from F6 and
   `node_modules/@agent-native/core/dist/org/migrations.js` (epoch-millisecond timestamps).
   Refuses to run without `--env`. Idempotent, which needs the organization **id derived from
   its name** (`org_` plus a slug, overridable with `--id`) rather than generated:
   `organizations` has no unique constraint but its primary key, so `INSERT OR IGNORE` with a
   fresh id would create a second organization on every run. The member id stays generated,
   guarded by `UNIQUE(org_id, email)`. `--command` values are validated to a shape that cannot
   carry SQL syntax (no `;`, no control characters) and single quotes are doubled, because
   `d1 execute` binds no parameters. `--dry-run` prints the exact argv and SQL without
   executing, so the statements can be verified against a local D1. `--help` prints usage and
   exits 0 without touching anything. Nullable columns are deliberately left NULL: `a2a_secret`
   (no A2A surface, D24) and `active-org-id` (unnecessary with one membership, F6), both of
   which the framework's own `POST /_agent-native/org` would set.
3. `docs/bootstrap.md`: the numbered steps 1–17 from the spec, stating for each whether
   `scripts/bootstrap.mjs` performs it or it is manual, with the exact command or click path
   and the expected result. Order: prerequisites (Paid plan, API token, Google OAuth client with
   the redirect URIs verified in `node_modules/@agent-native/core/docs/content/authentication.mdx`
   and the framework's route source, Renovate app), then `cp .bootstrap.env.example
   .bootstrap.env` and fill it in, `node scripts/bootstrap.mjs --plan`, `node scripts/bootstrap.mjs
   --yes`, then `pnpm db:migrate:staging`, merge to `main` (staging deploys through the
   workflow), first Google sign-in, `scripts/bootstrap-org.mjs`, "require Google sign-in", the
   production dispatch, and a final checklist of things to delete (sample data, the `nb-NO`
   review marker) or keep. No Cloudflare "Connect to GitHub"/Workers Builds integration:
   deployments come from GitHub Actions only; say why in one sentence. The redirect URI is
   `<APP_URL>/_agent-native/google/callback`, not the Better Auth path F7 first recorded —
   verified at runtime, see `DISCREPANCIES.md` (2026-09-08); the document also gives the `curl`
   that re-verifies it against the reader's own build.
4. Every command in the document must be copy-pasteable and use `<placeholders>` only where a
   value is customer-specific.

## Deliverables

`scripts/bootstrap.mjs`, `.bootstrap.env.example`, `.gitignore`, `scripts/check-config-hygiene.mjs`,
`tests/guards/bootstrap.test.mjs`, `scripts/rename-app.mjs`, `scripts/bootstrap-org.mjs`,
`docs/bootstrap.md`.

## Acceptance

```bash
pnpm check                                                            # includes tests/guards/bootstrap.test.mjs
node scripts/bootstrap.mjs --plan --env-file .bootstrap.env.example   # read-only; exits 0; prints the plan with <redacted> values or a clear "fill in" error listing missing keys
node scripts/bootstrap-org.mjs --help
git stash -u && node scripts/rename-app.mjs --name acme-ops --display "Acme Ops" && git diff --stat && git checkout -- . && git stash pop
```
(the rename diff must touch only files that contained `example-jobs` or `Example Jobs`, the
script must have printed every one of them, and `pnpm check` must still pass on the renamed
tree before reverting).
