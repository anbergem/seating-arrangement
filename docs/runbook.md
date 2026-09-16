# Runbook

Operational procedures. Command-oriented, meant to be readable at 2am.

Every command below assumes `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are exported,
and `<app>` is the Worker base name from `wrangler.jsonc` (`example-jobs` until the rename).
Replace `<app>` and the hosts.

**Before you touch anything:** write down what you observed and what time it is. Half of these
procedures are irreversible in one direction or another, and the thing you will wish you had is
the timestamp.

- [Deploy staging](#deploy-staging)
- [Deploy production](#deploy-production)
- [Roll back Worker code](#roll-back-worker-code)
- [What a Worker rollback does and does not undo](#what-a-worker-rollback-does-and-does-not-undo)
- [Inspect a failed deployment](#inspect-a-failed-deployment)
- [Inspect logs](#inspect-logs)
- [Restore D1 with Time Travel](#restore-d1-with-time-travel)
- [Restore from an SQL export](#restore-from-an-sql-export)
- [Recover after a bad migration](#recover-after-a-bad-migration)
- [Verify the most recent backup](#verify-the-most-recent-backup)
- [Perform a test restore](#perform-a-test-restore)
- [Rotate the Better Auth secret](#rotate-the-better-auth-secret)
- [Rotate OAuth credentials](#rotate-oauth-credentials)
- [Revoke or remove a company user](#revoke-or-remove-a-company-user)
- [Handle a compromised account](#handle-a-compromised-account)
- [Recover when Google sign-in is unavailable](#recover-when-google-sign-in-is-unavailable)
- [Where production secrets belong](#where-production-secrets-belong)

---

## Deploy staging

Staging deploys itself from a green CI run on `main`. You do not run a deploy command.

```bash
git switch main && git pull
# merge the pull request, then watch:
gh run list --workflow=ci.yml --limit 3
gh run list --workflow=deploy-staging.yml --limit 3
gh run watch <run-id>
```

To redeploy the current `main` without a new commit:

```bash
gh workflow run deploy-staging.yml --ref main
```

That dispatch performs the same exact-SHA CI lookup, so it refuses if `main` has no successful
CI run. If you genuinely need to deploy from a laptop — the very first deployment, before the
Worker exists — that is `scripts/bootstrap.mjs`'s `deploy` step, or:

```bash
pnpm build:worker
pnpm db:migrate:staging
pnpm deploy:staging
```

## Deploy production

Production is a manual promotion of an artifact a staging run already verified. It never
rebuilds.

```bash
# 1. pick the staging run to promote
gh run list --workflow=deploy-staging.yml --status success --limit 5

# 2. dispatch
gh workflow run deploy-production.yml -f staging_run_id=<id> -f confirm=deploy

# 3. approve it — the production environment requires a reviewer
gh run list --workflow=deploy-production.yml --limit 3
gh run watch <run-id>
```

`confirm` must be the literal string `deploy`. The run validates the staging run and its
deployment manifest, checks out that exact commit, downloads that exact bundle, verifies its
`BUILD_INFO.json`, `HEAD` and patch-marker hash, records a Time Travel bookmark, migrates,
deploys and runs the read-only smoke. Any of those failing stops it before the deploy.

## Roll back Worker code

```bash
# what is deployed, and what was before it
pnpm exec wrangler deployments list --env production
pnpm exec wrangler versions list --env production

# roll back to a specific version
pnpm exec wrangler rollback <version-id> --env production -m "reverting <reason>"

# verify
node scripts/worker-smoke.mjs --base-url "https://<production host>" --mode production
```

The failed promotion's job summary already contains the previous deployments as JSON — the
first id in that list is the one to restore. `gh run view <run-id>` shows the summary.

Then fix forward: the rollback is a stopgap, and the next promotion will deploy `main` again.
Revert the offending commit on `main` so a routine staging deploy does not silently reintroduce
it.

## What a Worker rollback does and does not undo

**Does:** replace the Worker script with a previous version. Requests immediately run the old
code.

**Does not:**

- **Roll back D1.** A migration that ran is still applied. This is the important one, and it is
  why every migration must be backwards compatible with the version still serving traffic.
- **Roll back data.** Rows written by the bad version are still there. Undo those through the
  application if they are undoable, or through Time Travel if they are not.
- **Roll back Worker secrets.** A rotated secret stays rotated.
- **Roll back the static assets** independently: the assets are part of the version, so they go
  back together with the script — but a browser holding a cached HTML shell may briefly run new
  client code against old server code, or the reverse. A hard reload resolves it.
- **Undo an external effect.** An invoice draft the accounting system accepted is still
  accepted.

So the recovery order for a bad release is: roll the Worker back first to stop the bleeding,
*then* decide about the data.

## Inspect a failed deployment

```bash
gh run list --workflow=deploy-production.yml --limit 5
gh run view <run-id>                    # includes the job summary: bookmark, rollback commands
gh run view <run-id> --log-failed       # only the failing steps
gh run view <run-id> --json conclusion,headSha,createdAt
```

Where each kind of failure points:

| Failing step | Likely cause |
| --- | --- |
| `Validate trusted staging run` | Wrong run id, or that staging run did not succeed on `main` in this repository |
| `Verify promoted bundle` | The artifact does not match the commit, or `PATCHED.json` is missing — never bypass this |
| `pnpm db:migrate:production` | A migration failed. Nothing was deployed. Go to *Recover after a bad migration*. |
| `pnpm deploy:production` | Token permissions, bundle size, or a Cloudflare incident |
| `worker-smoke.mjs … --mode production` | It deployed but does not work. Read which check failed, then roll back. |

The smoke prints one line per check as `[ok]` or `[fail] <check>: <detail>`, so the failing
line names the endpoint.

## Inspect logs

Workers Logs is on (`observability.enabled` in `wrangler.jsonc`, sampling rate 1).

```bash
# live tail
pnpm exec wrangler tail --env production --format pretty

# only failures
pnpm exec wrangler tail --env production --status error

# only our structured action lines
pnpm exec wrangler tail --env production --format json --search '"event":"action"'
```

Every action call writes one JSON line:

```json
{"level":"error","event":"action","action":"complete-job","outcome":"error",
 "errorCode":"CONFLICT","caller":"frontend","orgId":"org_acme","durationMs":12}
```

Deliberately absent: emails, arguments, results, row contents. A log line says *that* something
happened to *which* organization, never *what* the data was. So a log alone cannot tell you who
did something — that is the audit trail's job:

```bash
# in the app, as an owner or admin: the framework's audit reader
# or over HTTP with a session cookie
curl -s -b cookies.txt \
  'https://<host>/_agent-native/actions/list-audit-events?targetType=job&targetId=job_x&limit=50'
```

The dashboard equivalent is **Workers & Pages** → the Worker → **Logs**, where the same lines
are queryable and retained. `docs/observability.md` explains what belongs in which record.

## Restore D1 with Time Travel

Time Travel restores the **same** database in place. Use it when the data is wrong and you know
roughly when it went wrong. Retention and semantics are Cloudflare's:
<https://developers.cloudflare.com/d1/reference/time-travel/>.

```bash
# 1. what is available now
pnpm exec wrangler d1 time-travel info <app>-production --env production --json

# 2. the bookmark for a moment in time
pnpm exec wrangler d1 time-travel info <app>-production --env production \
  --timestamp 2026-09-08T09:15:00.000Z --json

# 3. restore to it
pnpm exec wrangler d1 time-travel restore <app>-production --env production \
  --bookmark <bookmark-id>
```

Before you run step 3:

- **Stop the bleeding first.** If a bad Worker version is still writing, roll it back
  (*Roll back Worker code*) before restoring, or you will restore and immediately re-corrupt.
- **Everything after that bookmark is gone.** Including legitimate work by other people. Take
  an export first if you might need to reconcile it:
  `pnpm exec wrangler d1 export <app>-production --remote --output /tmp/pre-restore.sql`.
- **A failed production promotion already recorded a bookmark** in its job summary — that is
  the pre-migration recovery point, and it is the one you usually want.

Afterwards, confirm the schema is still what the deployed build expects:

```bash
curl -s https://<production host>/api/ready
```

## Restore from an SQL export

Use an export when Time Travel cannot help: the account is gone, or the damage is older than
its retention. **Restore is always into a new database, never over a live one.**

The full ten-step procedure with its verification is in `docs/backups.md` §
*Restoring into a new database*. The shape of it:

```bash
# 1. stop writing; roll the Worker back if the damage is still spreading
# 2. test-restore the dump you intend to use, and only proceed if it passes
bash scripts/restore-d1-check.sh backups/<file>.sql.gz

# 3. create a new database
pnpm exec wrangler d1 create <app>-production-restored --jurisdiction eu

# 4. import
gzip -dc backups/<file>.sql.gz > /tmp/restore.sql
pnpm exec wrangler d1 execute <app>-production-restored --remote --file /tmp/restore.sql

# 5. point env.production.d1_databases[0].database_id at the new id in wrangler.jsonc
# 6. bring the schema forward if the dump is behind migrations/
pnpm db:migrate:production
# 7. deploy against the new binding
pnpm exec wrangler deploy --env production
# 8. verify
node scripts/worker-smoke.mjs --base-url "https://<production host>" --mode production
curl -s https://<production host>/api/ready
# 9. commit the changed wrangler.jsonc
# 10. keep the old database for at least a week; take a fresh backup of the new one
```

Write down what was lost: every row created between the backup timestamp and the incident is
gone unless Time Travel can supply it. That gap is the real cost of the backup interval.

## Recover after a bad migration

A migration that corrupted or destroyed data is the one case where the Worker rollback is not
the fix.

1. **Stop the bleeding.** Roll the Worker back to the previous version, so the new code is not
   writing into the damaged schema.
   ```bash
   pnpm exec wrangler rollback <previous-version-id> --env production -m "bad migration"
   ```
2. **Find the pre-migration bookmark.** The promotion recorded it in its job summary *before*
   it migrated:
   ```bash
   gh run view <promotion-run-id>
   ```
   If it is not there, get the bookmark for a timestamp just before the promotion started.
3. **Decide: restore or fix forward.**
   - **Data was destroyed or corrupted** → Time Travel restore to that bookmark. That also
     reverts the migration itself, because `d1_migrations` is in the database.
   - **The schema is wrong but the data is intact** → fix forward with a new migration. Never
     edit the applied one; both runners record file names, so an edited file is silently
     skipped everywhere it already ran.
4. **Reconcile.** After a restore, `/api/ready` will report the database behind the deployed
   build if you rolled the Worker back to a version that expects fewer migrations — check it,
   and re-apply what is genuinely needed.
5. **Write the postmortem into the migration.** A comment in the replacement migration saying
   what the previous one did wrong is the only place the next person will look.

The reason the bookmark is recorded before the migration rather than after is precisely this
procedure.

## Verify the most recent backup

```bash
# the nightly runs are workflow runs
gh run list --workflow=backup-d1.yml --limit 7

# with no S3 destination configured the dump is the run's artifact
gh run download <run-id> --name production-d1-<run-id> --dir /tmp/backup
ls -lh /tmp/backup
```

With an S3 destination, list the bucket for the prefix `d1/<app>-production` and check that
last night's object exists and is a plausible size. File names are
`<database>-<UTC yyyymmdd-HHMMSS>-<git sha short>.sql.gz[.age]`, so the name identifies the
deployed commit.

Every backup is already checked at the moment it is written: `scripts/backup-d1.sh` fails the
run unless the export is non-empty and contains `CREATE TABLE` and `customers`. That proves
the file is a database dump. It does not prove the dump restores — which is the next section.

A failed or missing nightly run is an incident: the gap between "backups stopped" and
"somebody noticed" is the window you cannot recover.

## Perform a test restore

Never touches production. It loads the dump into a scratch **local** D1 under its own
`--persist-to` directory inside a temporary directory, deleted on exit, so `.wrangler/state` is
untouched.

```bash
# plain, gzipped or age-encrypted; set BACKUP_AGE_IDENTITY for a .age input
bash scripts/restore-d1-check.sh backups/<app>-production-20260908-030000-abc1234.sql.gz
```

It decompresses, repeats the content checks, imports the SQL and prints a row count for
`customers`, `jobs`, `operations` and `d1_migrations`, teeing everything into a report file
(`RESTORE_REPORT` overrides the name). Read it as:

- **The import must complete without an error.** A failure means the dump is unusable and the
  backup configuration is broken — not that the data is wrong.
- **`customers`, `jobs` and `operations` must be plausible** for the day the backup was taken.
  Zero where you expect rows means the export ran against the wrong database or environment.
- **`d1_migrations` tells you which schema the dump belongs to.** If it is behind
  `migrations/`, a real restore has to apply the newer migrations after importing.

Run it against a real production backup **at least quarterly**, and after any change to the
schema, the export script or the destination. Record the date and the counts somewhere durable.

To rehearse without production data:

```bash
pnpm db:reset
pnpm exec wrangler d1 export <app>-local --local --output /tmp/local.sql
bash scripts/restore-d1-check.sh /tmp/local.sql
```

## Rotate the Better Auth secret

**Rotating `BETTER_AUTH_SECRET` signs every user out.** Every session cookie is signed with it.
Do it deliberately, and tell people first.

```bash
openssl rand -hex 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET --env production
pnpm exec wrangler secret list --env production
```

The secret takes effect on the next request; there is no redeploy needed. Then:

1. Confirm the app still boots and sign-in works: `GET /sign-in`, then actually sign in.
2. `OAUTH_STATE_SECRET` is separate and does **not** need rotating at the same time — that
   separation exists so one rotation does not invalidate the other's in-flight state. If you
   are rotating because of a suspected leak, rotate both.
3. Record the new value in the password manager that owns it. Worker secrets cannot be read
   back, and a restored database with a different `BETTER_AUTH_SECRET` invalidates every
   session.

Never rotate it as a routine. It is a security response, or a planned maintenance action.

## Rotate OAuth credentials

The Google client secret, without downtime, in this order:

1. **Google Cloud console** → **APIs & Services** → **Credentials** → the OAuth client →
   **Add secret**. Google allows two active secrets, which is what makes this zero-downtime.
2. **Set the new one**, which takes effect on the next request:
   ```bash
   pnpm exec wrangler secret put GOOGLE_SIGN_IN_CLIENT_SECRET --env production
   ```
3. **Verify** by signing in with Google in a fresh browser profile. Signed-in users are
   unaffected: the client secret is only used during the authorization-code exchange.
4. **Delete the old secret in Google**, once step 3 passed.

Repeat for staging. Rotating the **client id** is a different matter: it means a new client, so
add all the redirect URIs to the new client first, then set both `GOOGLE_SIGN_IN_CLIENT_ID` and
`GOOGLE_SIGN_IN_CLIENT_SECRET` together.

`OAUTH_STATE_SECRET` can be rotated the same way, with one caveat: any sign-in already in
flight fails and has to be retried, because its state envelope was signed with the old value.

## Revoke or remove a company user

For somebody who has left, in this order:

1. **Remove the membership**, which is what actually revokes access:
   the app's **Team** page → the member → **Remove**, as an owner or admin. Or over HTTP with an
   owner/admin session: `DELETE /_agent-native/org/members/<email>`.

   From that moment every action they attempt returns
   `AUTHORIZATION: Not a member of the active organization` — the role is read fresh from
   `org_members` on **every** call, so this takes effect on their next request, not their next
   sign-in.
2. **Suspend the Google account** in Google Workspace. Membership removal stops them using this
   app; the Workspace suspension stops them signing in anywhere.
3. **Confirm.** As an owner, check the Team page no longer lists them, and check the audit trail
   for anything after the removal:
   ```bash
   curl -s -b cookies.txt \
     'https://<host>/_agent-native/actions/list-audit-events?limit=100' | grep '<email>'
   ```
4. **Leave their history alone.** Their operations and audit rows stay: they are the record of
   what happened, and `performed_by` on an operation is not a login. Do not delete rows to
   "clean up".
5. **Reassign their open work.** Jobs still assigned to them keep the assignment until somebody
   changes it, which is intentional — an assignment silently clearing itself loses information.

To downgrade rather than remove, change their role on the Team page. Capability checks read the
current role, so a demotion also takes effect on the next call — including for undo, which
re-evaluates permission against the caller's current role.

## Handle a compromised account

Assume the attacker has whatever that account could reach. Speed matters more than tidiness.

1. **Remove the membership immediately** (previous section, step 1). This is the single most
   effective action: it takes effect on the next request and does not depend on Google.
2. **Suspend the Google account** and have Google revoke its sessions and tokens
   (Workspace admin → the user → **Sign out** / **Reset sign-in cookies**).
3. **Decide whether to sign everybody out.** If you cannot tell which sessions are the
   attacker's, rotate `BETTER_AUTH_SECRET` — it invalidates every session in that environment,
   including theirs. That is the blunt instrument, and here it is the right one.
4. **Read the audit trail for the blast radius.** This is what it is for:
   ```bash
   curl -s -b cookies.txt \
     'https://<host>/_agent-native/actions/list-audit-events?actorKind=human&limit=200'
   ```
   Filter by that email. Every mutation is there with its target, its surface and its summary,
   including the ones that were denied — a run of `denied` rows is somebody probing.
5. **Reverse what can be reversed.** `/activity` lists the operations with Undo where the
   version rule and the policy allow it. What cannot be reversed:
   - anything `irreversible` — an accounting export that was accepted;
   - anything a newer change has moved past, which will refuse with `CONFLICT`. For those,
     Time Travel to before the incident is the option, and it costs everyone else's work since
     then.
6. **Rotate anything the account could have read.** If they were an owner or admin: the
   Cloudflare API token, the Anthropic key, any vendor credential. Worker secrets cannot be
   read back through the app, but a repository admin can read GitHub environment secrets'
   *names* and a workflow can use their values.
7. **Write the timeline down.** From the audit rows, not from memory.

## Recover when Google sign-in is unavailable

Google being down, the OAuth client being misconfigured, or the consent screen being changed
locks everybody out of production, because production has no password door on purpose.

**Do not "temporarily" enable password sign-up on production.** That opens a self-service door
to the internet, and the thing you are trying to fix is a login problem, not an authorization
problem.

In order of preference:

1. **Confirm it is actually Google.** <https://www.google.com/appsstatus>, and check the app's
   own health:
   ```bash
   curl -s https://<production host>/_agent-native/ping
   curl -s https://<production host>/api/ready
   ```
   If those are fine, the application is serving and only sign-in is affected. Nobody's data is
   at risk; waiting is a legitimate response.
2. **Check whether it is our configuration**, which is much more likely than Google being down.
   A recent change to the OAuth client, the redirect URIs or `APP_URL` is the usual cause, and
   the symptom is `redirect_uri_mismatch`. Compare:
   ```bash
   pnpm exec wrangler secret list --env production          # names only
   # the redirect URI the framework will send, from your own build:
   curl -s https://<production host>/_agent-native/google/auth-url
   ```
   The `redirect_uri` in that URL must be registered on the Google client, exactly.
3. **If an organization's "require Google sign-in" is the blocker** and the OAuth client is
   genuinely unrecoverable, an owner or admin *with a working session* can turn it off from the
   Team page. Without any working session, this is the one operation that needs direct database
   access:
   ```bash
   pnpm exec wrangler d1 execute <app>-production --remote --env production --yes \
     --command "UPDATE organizations SET required_auth_provider = NULL WHERE id = '<orgId>'"
   ```
   That re-allows password sign-in for members who have a password — which in production they
   generally do not, because they were never created that way. So this helps only if you
   deliberately keep a break-glass account.
4. **Keep a break-glass account, and decide about it in advance rather than during an
   incident.** A single owner account whose credentials live in the company password manager,
   created before "require Google" was enabled. It is a standing risk; the alternative is a
   standing lockout risk. Whichever you choose, write the choice down here, in this repository,
   with the reason.

Afterwards: if the cause was a configuration change, add whatever check would have caught it.
The redirect URI is verifiable from a running deployment with one `curl`, which is why step 2
above is a command and not a description.

## Where production secrets belong

| Secret | Where it lives | Who sets it | Readable back? |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | Worker secret, production | `wrangler secret put` | No |
| `OAUTH_STATE_SECRET` | Worker secret, production | `wrangler secret put` | No |
| `GOOGLE_SIGN_IN_CLIENT_ID` / `_SECRET` | Worker secret, production | `wrangler secret put` | No |
| `ANTHROPIC_API_KEY` | Worker secret, production | `wrangler secret put` | No |
| `SEED_PASSWORD` | Worker secret **staging only**; GitHub `staging` environment | `wrangler secret put`, `gh secret set` | No |
| `CLOUDFLARE_API_TOKEN` | GitHub environment secret | `gh secret set --env` | No |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub environment secret | `gh secret set --env` | No |
| `BACKUP_*` | GitHub `production-backup` environment | `gh secret set --env production-backup` | No |
| `STAGING_URL`, `PRODUCTION_URL` | GitHub environment **variables** | `gh variable set --env` | Yes |

Rules:

- **Nothing secret is ever in git.** Only `*.example` files are committed and they carry names,
  never values. `.env`, `.dev.vars` and `.bootstrap.env` are git-ignored, and
  `scripts/check-config-hygiene.mjs` asserts both the ignore rules and that no secret name
  appears in a `wrangler.jsonc` `vars` block.
- **Worker secrets and GitHub secrets are different things.** A Worker secret is what the
  application reads at runtime; a GitHub secret is what a *workflow* needs. A workflow cannot
  read a Worker secret, and should not be able to.
- **Nothing is readable back.** The source of truth for every value above is the password
  manager that issued it, not Cloudflare and not GitHub. `wrangler secret list` and
  `gh secret list` show names and timestamps only.
- **A restored database with a different `BETTER_AUTH_SECRET` invalidates every session.** That
  is the practical reason to keep these values recorded rather than treating them as
  write-only.
- **Delete `.bootstrap.env` after the bootstrap.** It holds four of them in one file.
