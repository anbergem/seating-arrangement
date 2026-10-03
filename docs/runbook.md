# Runbook

Operational procedures. Command-oriented, meant to be readable at 2am.

Every command below assumes `clever login` has been run on this machine, and `<app>` is the
application name from `server/plugins/config.ts` (`seating-arrangement` until the rename). The
applications are `<app>-staging` and `<app>-production`; their databases are
`<app>-staging-db` and `<app>-production-db`. Replace `<app>` and the hosts.

**Before you touch anything:** write down what you observed and what time it is. Half of these
procedures are irreversible in one direction or another, and the thing you will wish you had is
the timestamp.

- [Deploy staging](#deploy-staging)
- [Deploy production](#deploy-production)
- [Roll back the deployed code](#roll-back-the-deployed-code)
- [What a rollback does and does not undo](#what-a-rollback-does-and-does-not-undo)
- [Inspect a failed deployment](#inspect-a-failed-deployment)
- [Inspect logs](#inspect-logs)
- [Restore the database](#restore-the-database)
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
application has ever run — that is `scripts/bootstrap.mjs`'s `deploy` step, or:

```bash
clever link <app>-staging --alias staging
node scripts/migrate.mjs --addon <app>-staging-db
clever deploy --alias staging
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
deployment manifest, checks out that exact commit, verifies with
`scripts/verify-promoted-commit.mjs` that the checkout really is the commit the manifest names,
records the database backups that already exist, migrates, deploys and runs the read-only
smoke. Any of those failing stops it before the deploy.

## Roll back the deployed code

A deployment is a commit, so a rollback is a promotion of the previous one.

```bash
# what has been deployed, newest last
clever activity --alias production

# the staging runs, to find the previous good one
gh run list --workflow=deploy-staging.yml --status success --limit 10

# promote the previous good commit
gh workflow run deploy-production.yml -f staging_run_id=<previous-id> -f confirm=deploy

# verify
node scripts/smoke.mjs --base-url "https://<production host>" --mode production
```

The failed promotion's job summary already contains the previous deployments — `gh run view
<run-id>` shows it.

If the promotion pipeline itself is what is broken and you need the previous code serving
*now*, deploy it directly:

```bash
git checkout <previous-good-sha>
clever link <app>-production --alias production
clever deploy --alias production --same-commit-policy restart
```

That bypasses every provenance check, so treat it as a fire alarm rather than a procedure, and
follow it with a real promotion once the pipeline works again.

Then fix forward: the rollback is a stopgap, and the next promotion will deploy `main` again.
Revert the offending commit on `main` so a routine staging deploy does not silently reintroduce
it.

## What a rollback does and does not undo

**Does:** replace the running code with the previous commit's build. Requests run the old code
as soon as the new instance is serving.

**Does not:**

- **Roll back the database.** A migration that ran is still applied. This is the important one,
  and it is why every migration must be backwards compatible with the version still serving
  traffic.
- **Roll back data.** Rows written by the bad version are still there. Undo those through the
  application if they are undoable, or through a database restore if they are not.
- **Roll back application settings.** A rotated secret stays rotated.
- **Roll back the static assets** independently: they are part of the build, so they go back
  together with the server — but a browser holding a cached HTML shell may briefly run new
  client code against old server code, or the reverse. A hard reload resolves it.
- **Undo an external effect.** Anything a vendor system already accepted is still
  accepted.

So the recovery order for a bad release is: get the previous code serving first to stop the
bleeding, *then* decide about the data.

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
| `Preflight — the Clever Cloud credentials work` | `CLEVER_TOKEN` / `CLEVER_SECRET` are stale. Re-set them: `node scripts/bootstrap.mjs --yes --only github-secrets` |
| `Validate trusted staging run` | Wrong run id, or that staging run did not succeed on `main` in this repository |
| `Verify the promoted commit` | The checkout is not the commit staging deployed — never bypass this |
| `Apply migrations` | A migration failed. **Nothing was deployed**, because migrations run first. Go to *Recover after a bad migration*. |
| `Deploy` | Build failure on the platform, a plan limit, or a Clever Cloud incident. `clever logs --alias production` has the build output. |
| `smoke.mjs … --mode production` | It deployed but does not work. Read which check failed, then roll back. |

The smoke prints one line per check as `[ok]` or `[fail] <check>: <detail>`, so the failing
line names the endpoint.

## Inspect logs

```bash
# live tail
clever logs --alias production

# a window in the past
clever logs --alias production --since 1h

# only our structured action lines
clever logs --alias production | grep '"event":"action"'
```

Every action call writes one JSON line:

```json
{"level":"error","event":"action","action":"move-seating-table","outcome":"error",
 "errorCode":"CONFLICT","caller":"frontend","orgId":"org_acme","durationMs":12}
```

Deliberately absent: emails, arguments, results, row contents. A log line says *that* something
happened to *which* organization, never *what* the data was. So a log alone cannot tell you who
did something — that is the audit trail's job:

```bash
# in the app, as an owner or admin: the framework's audit reader
# or over HTTP with a session cookie
curl -s -b cookies.txt \
  'https://<host>/_agent-native/actions/list-audit-events?targetType=seating_table&targetId=tbl_x&limit=50'
```

The console equivalent is the application's **Logs** tab. `docs/observability.md` explains what
belongs in which record.

## Restore the database

The `xxs_sml` plan takes a daily backup with seven-day retention and supports point-in-time
recovery. Restoring overwrites a customer's data, so it is a console operation on purpose
rather than a one-liner.

```bash
# what exists
clever addon list                                   # find the add-on id
clever database backups <addon-id>

# take a copy of one before you do anything destructive
clever database backups download <addon-id> <backup-id>
```

Before you restore:

- **Stop writing.** `clever stop --alias production`. A restore that races live traffic
  produces a database nobody can reason about.
- **Everything after the restore point is gone**, including legitimate work by other people.
  Download a current backup first if you might need to reconcile it.
- **A failed production promotion already recorded the backup list** in its job summary, taken
  *before* it migrated. That is the pre-migration recovery point, and usually the one you want.

Then restore through the Clever Cloud console — the add-on's **Backups** tab for a daily
backup, or point-in-time recovery for a specific moment. Afterwards:

```bash
clever restart --alias production
curl -s https://<production host>/api/ready
node scripts/smoke.mjs --base-url "https://<production host>" --mode production
```

Write down what was lost: every row created between the restore point and the incident is gone.
That gap is the real cost of the backup interval, and it is the number to quote when somebody
asks whether daily is often enough.

## Recover after a bad migration

Migrations run **before** the deploy, so the common case is the good one: the migration failed,
nothing was deployed, and the application is still serving the previous code against the
previous schema. Read the failure, fix the migration, open a pull request.

The hard case is a migration that *succeeded* and corrupted or destroyed data.

1. **Stop the bleeding.** Get the previous code serving (*Roll back the deployed code*), so the
   new code is not writing into the damaged schema.
2. **Find the pre-migration backup.** The promotion recorded the backup list in its job summary
   *before* it migrated:
   ```bash
   gh run view <promotion-run-id>
   ```
3. **Decide: restore or fix forward.**
   - **Data was destroyed or corrupted** → restore to that point (*Restore the database*). That
     also reverts the migration itself, because `d1_migrations` is in the database.
   - **The schema is wrong but the data is intact** → fix forward with a new migration. Never
     edit the applied one; the runner records file names, so an edited file is silently skipped
     everywhere it already ran.
4. **Reconcile.** After a restore, check `/api/ready` against the deployed build and re-apply
   whatever is genuinely needed.
5. **Write the postmortem into the migration.** A comment in the replacement migration saying
   what the previous one did wrong is the only place the next person will look.

The reason the backup list is recorded before the migration rather than after is precisely this
procedure.

## Verify the most recent backup

```bash
clever addon list
clever database backups <production-addon-id>
```

Check that last night's entry exists and is a plausible size. The plan takes one daily and
keeps seven; an empty list, or a list whose newest entry is days old, is an incident — the gap
between "backups stopped" and "somebody noticed" is the window you cannot recover.

Unlike the arrangement this replaced, nothing in this repository writes the backups, so there
is no export script to have quietly failed. The trade is that you are trusting the platform:
checking the list is how you stop trusting it blindly.

## Perform a test restore

A backup nobody has restored is a hypothesis. Test against **staging**, which carries only the
synthetic scenario, never against production.

```bash
clever database backups <staging-addon-id>
# restore the most recent one through the console, then:
curl -s https://<staging host>/api/ready
node scripts/smoke.mjs --base-url "https://<staging host>" --mode staging \
  --qa-email owner@example.invalid --qa-password "$SEED_PASSWORD" --expect-org-id org_acme
```

A green smoke after a restore is the evidence. `/api/ready` additionally tells you which schema
the backup belongs to: if it reports fewer applied migrations than expected, a real restore has
to apply the newer ones afterwards.

Do this when the application first goes live, at least quarterly after that, and after any
change to the schema you would not want to re-run by hand. Record the date and what you saw
somewhere durable.

## Rotate the Better Auth secret

**Rotating `BETTER_AUTH_SECRET` signs every user out.** Every session cookie is signed with it.
Do it deliberately, and tell people first.

```bash
node scripts/bootstrap.mjs --yes --only app-env --rotate
```

That regenerates `BETTER_AUTH_SECRET` and `OAUTH_STATE_SECRET` for **both** environments from
32 random bytes each, without either value passing through a command line. To rotate one
environment only, set it directly and restart:

```bash
printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" \
  | clever env import-vars BETTER_AUTH_SECRET --alias production
clever restart --alias production
```

Then:

1. Confirm the app still boots and sign-in works: `GET /sign-in`, then actually sign in.
2. `OAUTH_STATE_SECRET` is separate and does **not** need rotating at the same time — that
   separation exists so one rotation does not invalidate the other's in-flight state. If you
   are rotating because of a suspected leak, rotate both.
3. Record the new value in the password manager that owns it. Application settings *can* be
   read back with `clever env --alias production`, which is a convenience and not a reason to
   skip recording them — a restored database paired with a different `BETTER_AUTH_SECRET`
   invalidates every session, and you want to know which value went with which backup.

Never rotate it as a routine. It is a security response, or a planned maintenance action.

## Rotate OAuth credentials

The Google client secret, without downtime, in this order:

1. **Google Cloud console** → **APIs & Services** → **Credentials** → the OAuth client →
   **Add secret**. Google allows two active secrets, which is what makes this zero-downtime.
2. **Set the new one**, which takes effect on the next request:
   ```bash
   printf 'GOOGLE_SIGN_IN_CLIENT_SECRET=%s\n' "<new secret>" \
     | clever env import-vars GOOGLE_SIGN_IN_CLIENT_SECRET --alias production
   clever restart --alias production
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
5. **Hand over their open work.** Events they created keep their `created_by` until somebody
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
   - anything `irreversible` — an external effect a vendor already accepted;
   - anything a newer change has moved past, which will refuse with `CONFLICT`. For those,
     restoring the database to before the incident is the option — `docs/backups.md` has the
     procedure — and it costs everyone else's work since then.
6. **Rotate anything the account could have read.** If they were an owner or admin: the
   Clever Cloud credentials, the Anthropic key, any vendor credential. Note that application
   settings *are* readable with `clever env`, so anyone with access to the Clever Cloud account
   has had them — `clever tokens` revokes a CLI token, and `clever login` issues a fresh one.
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
   clever env --alias production | grep GOOGLE_SIGN_IN_CLIENT_ID
   # the redirect URI the framework will send, from your own build:
   curl -s https://<production host>/_agent-native/google/auth-url
   ```
   The `redirect_uri` in that URL must be registered on the Google client, exactly.
3. **If an organization's "require Google sign-in" is the blocker** and the OAuth client is
   genuinely unrecoverable, an owner or admin *with a working session* can turn it off from the
   Team page. Without any working session, this is the one operation that needs direct database
   access:
   ```bash
   # the connection string is in the console, or:
   clever addon env <production-addon-id>
   psql "<connection string>" \
     -c "UPDATE organizations SET required_auth_provider = NULL WHERE id = '<orgId>'"
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
| `BETTER_AUTH_SECRET` | Application setting, production | `bootstrap --only app-env` | Yes, with account access |
| `OAUTH_STATE_SECRET` | Application setting, production | `bootstrap --only app-env` | Yes, with account access |
| `GOOGLE_SIGN_IN_CLIENT_ID` / `_SECRET` | Application setting, production | `bootstrap --only app-env` | Yes, with account access |
| `ANTHROPIC_API_KEY` | Application setting, production | `bootstrap --only app-env` | Yes, with account access |
| `SEED_PASSWORD` | Application setting **staging only**; GitHub `staging` environment | `bootstrap`, `gh secret set` | On the platform yes, on GitHub no |
| `CLEVER_TOKEN` / `CLEVER_SECRET` | GitHub environment secrets | `bootstrap --only github-secrets`, from the CLI profile | No |
| The database connection string | The add-on, injected as `POSTGRESQL_ADDON_URI` | The platform, when the add-on is linked | Yes, with account access |
| `STAGING_URL`, `PRODUCTION_URL`, `CLEVER_APP_NAME` | GitHub environment **variables** | `gh variable set --env` | Yes |

Rules:

- **Nothing secret is ever in git.** Only `*.example` files are committed and they carry names,
  never values. `.env` and `.bootstrap.env` are git-ignored, and
  `scripts/check-config-hygiene.mjs` asserts the ignore rules.
- **No Clever Cloud credential is in `.bootstrap.env` at all.** `clever login` writes a profile
  in `~/.config/clever-cloud/`, and bootstrap reads it from there — for its own calls and to
  set the two GitHub secrets. Nobody pastes a platform token anywhere.
- **Application settings and GitHub secrets are different things.** An application setting is
  what the application reads at runtime; a GitHub secret is what a *workflow* needs. A workflow
  cannot read an application setting except by asking the platform for it, which is exactly
  what `--addon` does for the one value that needs it.
- **Application settings are readable back**, which is a real difference from the arrangement
  this replaced. `clever env --alias production` prints values. Anyone with access to the
  Clever Cloud account has every secret the application holds; the password manager is still
  the source of truth, and the account is now part of the blast radius.
- **A restored database with a different `BETTER_AUTH_SECRET` invalidates every session.** That
  is the practical reason to keep these values recorded rather than treating them as
  write-only.
- **Delete `.bootstrap.env` after the bootstrap.** It holds three of them in one file.
