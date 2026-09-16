# Backups and restore

A backup strategy is incomplete until restore has been tested.

This page is the strategy and the full procedures. `docs/runbook.md` has the incident-time
short versions — *Verify the most recent backup*, *Perform a test restore*, *Restore D1 with
Time Travel*, *Recover after a bad migration* — and links back here.

## Strategy

Two layers protect the production database, because they fail in different ways.

1. **D1 Time Travel** is Cloudflare's built-in point-in-time recovery. It is always on, needs no
   configuration, and restores the same database in place. Retention and the exact restore
   semantics are Cloudflare's, so read them at the source rather than trusting a number copied
   into this file:
   [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
   `deploy-production.yml` records a bookmark into the job summary before every migration, so
   the recovery point for a bad release is written down at the moment it is needed.
2. **Exported SQL dumps** are this repository's own copies, taken by
   `.github/workflows/backup-d1.yml` (daily at 03:00 UTC, plus manual dispatch) through
   `scripts/backup-d1.sh`. They survive losing the Cloudflare account itself, which Time Travel
   does not. The export format and its limits are documented under
   [D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

Layer 1 answers "we broke the data an hour ago". Layer 2 answers "we lost the account" and
"we need last month's rows". Restore is always into a **new** database, never in place (D23).

## What is covered

Covered: everything in the production D1 database. That is the application's own tables from
`migrations/` (`customers`, `jobs`, `operations`, `idempotency_keys`, `accounting_exports`),
the framework's own tables (users, sessions, organizations, memberships, audit events) that
live in the same database, and the `d1_migrations` bookkeeping table, so a restored copy knows
which migrations it already has. The two schema owners are explained in
`docs/database-and-migrations.md`; for backup purposes they are one database and one dump.

Not covered:

- **R2 objects.** This starter stores no files in R2 (D24). An application that adds R2 needs a
  second backup path; a D1 dump will not contain the objects.
- **Cloudflare Worker secrets.** `BETTER_AUTH_SECRET`, `OAUTH_STATE_SECRET`, the Google client
  credentials and `ANTHROPIC_API_KEY` are set with `wrangler secret put` and are not readable
  back. Keep them in the password manager that issued them; a restored database with a
  different `BETTER_AUTH_SECRET` invalidates every existing session.
- **The Worker script itself.** Deployments are rolled back with
  `wrangler rollback --env production`, and the exact bundle of any release is kept as the
  90-day `worker-bundle-<sha>` artifact of its staging run.
- **GitHub environment secrets and variables.** Configured by hand; see
  `docs/repository-settings.md`.

## Configuration

`scripts/backup-d1.sh` is configured entirely through environment variables. Everything except
the Cloudflare credentials has a working default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `D1_DATABASE` | `example-jobs-production` | Database to export |
| `WRANGLER_ENV` | `production` | Wrangler environment holding that binding |
| `BACKUP_DIR` | `backups` | Where the dump is written before upload |
| `BACKUP_AGE_RECIPIENT` | – | `age` public key; when set the gzip is encrypted and the plaintext deleted |
| `BACKUP_S3_BUCKET` | – | When set, the artifact is uploaded to S3-compatible storage |
| `BACKUP_S3_ENDPOINT` | – | Required with the bucket (for R2: `https://<account>.r2.cloudflarestorage.com`) |
| `BACKUP_S3_REGION` | `auto` | Region; `auto` is correct for R2 |
| `BACKUP_S3_ACCESS_KEY_ID` | – | Required with the bucket |
| `BACKUP_S3_SECRET_ACCESS_KEY` | – | Required with the bucket |
| `BACKUP_S3_PREFIX` | `d1/<database>` | Key prefix inside the bucket |
| `BACKUP_AGE_IDENTITY` | – | Read by `scripts/restore-d1-check.sh` only: the private identity file matching the recipient |

The workflow runs in the `production-backup` GitHub environment, which has no required
reviewers so the schedule can run unattended, and whose Cloudflare token needs only
account-scoped `D1 Read`. With no `BACKUP_S3_BUCKET` configured the dump stays as a GitHub
workflow artifact with 30-day retention, which is enough to start but not a backup destination:
it lives in the same account as the code.

Recommendations for the destination:

- Use a **different provider or at least a different account** from the one running production.
  A backup in the account you might lose is not a backup.
- Set `BACKUP_AGE_RECIPIENT`. The dump contains every customer row and every user record in
  plain SQL. Keep the matching identity file out of this repository and out of the same
  account.
- Express retention as **lifecycle rules on the destination bucket**, not as logic in this
  repository: keep daily backups for 30 days and one backup per month for 12 months. The
  script writes objects and never deletes them, so the bucket's own rules are the only thing
  that expires them.
- File names are `<database>-<UTC yyyymmdd-HHMMSS>-<git sha short>.sql.gz[.age]`, so the
  lifecycle rule can match the prefix and the object name identifies the deployed commit.

## Verification

Every backup is checked at the moment it is written: the export must be non-empty and must
contain `CREATE TABLE` and `customers`, or `scripts/backup-d1.sh` exits non-zero and the
workflow fails. That proves the file is a database dump. It does not prove the dump restores.

`scripts/restore-d1-check.sh` is the test restore. It never touches production: it loads the
backup into a scratch **local** D1 under its own `--persist-to` directory inside a temporary
directory, which is deleted on exit, so `.wrangler/state` is untouched.

```bash
# a plain, gzipped, or age-encrypted dump; set BACKUP_AGE_IDENTITY for .age input
bash scripts/restore-d1-check.sh backups/example-jobs-production-20260907-030000-f16b25d.sql.gz
```

It decompresses (and decrypts), repeats the content checks, imports the SQL, and prints a row
count for `customers`, `jobs`, `operations` and `d1_migrations`, teeing everything into a report
file (`RESTORE_REPORT` overrides its name). Read the output as follows:

- The import must complete without an error. A failure here means the dump is unusable and the
  backup configuration is broken, not that the data is wrong.
- `customers`, `jobs` and `operations` must be plausible for the day the backup was taken. Zero
  where you expect rows means the export ran against the wrong database or environment.
- `d1_migrations` tells you which schema the dump belongs to. If it is behind the migrations in
  `migrations/`, a restore has to apply the newer migrations after importing.

Run it against a real production backup at least once per quarter and after any change to the
schema, the export script or the destination. Record the date and the counts.

To rehearse without production data, export the local database and restore-check that:

```bash
pnpm db:reset
pnpm exec wrangler d1 export example-jobs-local --local --output /tmp/local.sql
bash scripts/restore-d1-check.sh /tmp/local.sql
```

## Restoring into a new database

Never import a dump over a live database. Create a new one, verify it, then move the binding.

1. **Stop writing.** Announce the outage. If the damage is still spreading, deploy a previous
   Worker version first (`pnpm exec wrangler rollback <version-id> --env production`).
2. **Pick the backup** and run `scripts/restore-d1-check.sh` on it. Do not proceed on a dump
   whose test restore fails; take the next one.
3. **Create the new database** and note its id:
   ```bash
   pnpm exec wrangler d1 create example-jobs-production-restored --jurisdiction eu
   ```
4. **Import the dump** (decompress first; the plain `.sql` is what `--file` takes):
   ```bash
   gzip -dc backups/<file>.sql.gz > /tmp/restore.sql
   pnpm exec wrangler d1 execute example-jobs-production-restored --remote --file /tmp/restore.sql
   ```
5. **Bring the schema forward** if `d1_migrations` in the dump is behind `migrations/`. Point
   the production binding at the new id first (step 6), then run
   `pnpm db:migrate:production`.
6. **Update the binding** in `wrangler.jsonc`: replace `env.production.d1_databases[0].database_id`
   with the new id. Keep `database_name` and `binding` as they are — the application only ever
   sees `DB`.
7. **Deploy** the same Worker bundle against the new binding:
   ```bash
   pnpm exec wrangler deploy --env production
   ```
   Use the promotion workflow when the release itself is also being changed; a pure database
   swap can be deployed directly by the maintainer.
8. **Verify** before announcing recovery:
   ```bash
   node scripts/worker-smoke.mjs --base-url "$PRODUCTION_URL" --mode production
   ```
   plus a manual sign-in and one read of a known customer and job. Confirm
   `GET /api/ready` reports `migrations.applied === migrations.expected`.
9. **Commit** the changed `wrangler.jsonc` so the repository and the deployed reality agree.
10. **Keep the old database for at least a week.** Do not delete it while the incident is still
    being understood; it is the only copy of anything written after the backup was taken. Take
    a fresh backup of the restored database immediately, and confirm the next scheduled backup
    run succeeds against the new binding.

Write down what was lost: every row created between the backup timestamp and the incident is
gone unless Time Travel can supply it. That gap is the real cost of the backup interval, and it
is the number to argue about when deciding how often this workflow should run.
