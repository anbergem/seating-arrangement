#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <backup.sql|backup.sql.gz|backup.sql.gz.age>" >&2
  exit 2
fi

backup="$1"
test -f "$backup"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/example-jobs-restore.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
sql_file="$scratch/restore.sql"
persist="$scratch/wrangler-state"
report="${RESTORE_REPORT:-restore-report-$(date -u +%Y%m%d-%H%M%S).log}"
umask 077

case "$backup" in
  *.sql.gz.age)
    decrypted="$scratch/backup.sql.gz"
    : "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY must name the age identity file}"
    age --decrypt -i "$BACKUP_AGE_IDENTITY" -o "$decrypted" "$backup"
    gzip -dc -- "$decrypted" > "$sql_file"
    ;;
  *.sql.gz) gzip -dc -- "$backup" > "$sql_file" ;;
  *.sql) cp -- "$backup" "$sql_file" ;;
  *) echo "unsupported backup suffix: $backup" >&2; exit 2 ;;
esac

test -s "$sql_file"
grep -Fq "CREATE TABLE" "$sql_file"
grep -Fq "customers" "$sql_file"

{
  echo "Restore verification using isolated state: $persist"
  pnpm exec wrangler d1 execute example-jobs-local --local --persist-to "$persist" --file "$sql_file" --yes
  for table in customers jobs operations d1_migrations; do
    echo "Count: $table"
    pnpm exec wrangler d1 execute example-jobs-local --local --persist-to "$persist" \
      --command "SELECT COUNT(*) AS row_count FROM $table" --yes
  done
} 2>&1 | tee "$report"

echo "Restore report: $report"
