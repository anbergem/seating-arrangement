# T21 — Backups and restore

Goal: the D1 export workflow and script, the restore procedure, and `docs/backups.md`.

Depends on: T20. Read: F10; B20 (backup); D23.

## Steps

1. `scripts/backup-d1.sh` (bash, `set -euo pipefail`): inputs via env `D1_DATABASE` (default
   `example-jobs-production`), `WRANGLER_ENV` (default `production`), `BACKUP_DIR` (default
   `backups`), optional `BACKUP_AGE_RECIPIENT`, optional `BACKUP_S3_BUCKET`,
   `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION` (default `auto`), `BACKUP_S3_ACCESS_KEY_ID`,
   `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_PREFIX` (default `d1/<database>`). Steps: export
   with `wrangler d1 export "$D1_DATABASE" --remote --env "$WRANGLER_ENV" --output "$file.sql"`;
   verify the file is non-empty and contains `CREATE TABLE` and the string `customers`; gzip;
   if a recipient is set, `age -r "$BACKUP_AGE_RECIPIENT" -o "$file.sql.gz.age"` and delete the
   plain gzip; if the S3 variables are set, upload with the AWS CLI (`aws s3 cp` with
   `--endpoint-url`); print the final artifact path. File name
   `<database>-<UTC yyyymmdd-HHMMSS>-<git sha short>.sql.gz[.age]`.
2. `.github/workflows/backup-d1.yml`: `schedule: cron "0 3 * * *"` plus `workflow_dispatch`;
   `environment: production-backup` (no required reviewers; account-scoped `D1 Read` token),
   trusted `main` checkout and manual-dispatch guard; install pnpm/node; install `age` (apt) only if
   `BACKUP_AGE_RECIPIENT` is set; run the script; if no S3 bucket is configured upload the
   artifact with `actions/upload-artifact@v4` and `retention-days: 30`.
3. `scripts/restore-d1-check.sh`: takes a backup file, decrypts/decompresses to a temp file
   (`BACKUP_AGE_IDENTITY` names the identity file for `.age` input), creates a **local** scratch
   D1 with an isolated `--persist-to` directory (never removing `.wrangler/state`), then prints row counts for `customers`, `jobs`,
   `operations` and the applied migrations. This is the "test restore" that never touches
   production.
4. `docs/backups.md` sections: strategy (two layers, with links to the D1 Time Travel and D1
   export documentation instead of hard-coded retention numbers), what is and is not covered
   (framework tables included; R2 objects not), configuration (the env variables above,
   recommended separate account or provider for the destination, recommended retention: daily
   30 days, monthly 12 months via destination lifecycle rules), verification (how to run the
   test restore and read its output), restore into a new database procedure (create new D1,
   execute the SQL with `wrangler d1 execute <new> --remote --file`, update the binding id in
   `wrangler.jsonc`, deploy, verify, keep the old database for a week), and the sentence "A
   backup strategy is incomplete until restore has been tested".

## Deliverables

`scripts/backup-d1.sh`, `scripts/restore-d1-check.sh`, `.github/workflows/backup-d1.yml`,
`docs/backups.md`.

## Acceptance

```bash
pnpm check
bash -n scripts/backup-d1.sh && bash -n scripts/restore-d1-check.sh
pnpm lint:workflows
pnpm build:worker && pnpm db:reset && pnpm exec wrangler d1 export example-jobs-local --local --output /tmp/local.sql && bash scripts/restore-d1-check.sh /tmp/local.sql
```
