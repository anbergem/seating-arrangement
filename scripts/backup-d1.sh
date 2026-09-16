#!/usr/bin/env bash
set -euo pipefail
umask 077

D1_DATABASE="${D1_DATABASE:-example-jobs-production}"
WRANGLER_ENV="${WRANGLER_ENV:-production}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_S3_REGION="${BACKUP_S3_REGION:-auto}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-d1/${D1_DATABASE}}"

command -v pnpm >/dev/null
command -v gzip >/dev/null
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  command -v age >/dev/null
fi
if [[ -n "${BACKUP_S3_BUCKET:-}" ]]; then
  : "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required with BACKUP_S3_BUCKET}"
  : "${BACKUP_S3_ACCESS_KEY_ID:?BACKUP_S3_ACCESS_KEY_ID is required with BACKUP_S3_BUCKET}"
  : "${BACKUP_S3_SECRET_ACCESS_KEY:?BACKUP_S3_SECRET_ACCESS_KEY is required with BACKUP_S3_BUCKET}"
  command -v aws >/dev/null
fi

mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%d-%H%M%S)"
git_sha="$(git rev-parse --short HEAD)"
base="${D1_DATABASE}-${timestamp}-${git_sha}.sql"
sql_file="${BACKUP_DIR}/${base}"

pnpm exec wrangler d1 export "$D1_DATABASE" --remote --env "$WRANGLER_ENV" --output "$sql_file" --skip-confirmation
test -s "$sql_file"
grep -Fq "CREATE TABLE" "$sql_file"
grep -Fq "customers" "$sql_file"
gzip -9 "$sql_file"
artifact="${sql_file}.gz"

if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  encrypted="${artifact}.age"
  age -r "$BACKUP_AGE_RECIPIENT" -o "$encrypted" "$artifact"
  rm -- "$artifact"
  artifact="$encrypted"
fi

if [[ -n "${BACKUP_S3_BUCKET:-}" ]]; then
  export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION="$BACKUP_S3_REGION"
  aws s3 cp "$artifact" "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/$(basename "$artifact")" \
    --endpoint-url "$BACKUP_S3_ENDPOINT"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'artifact=%s\n' "$artifact" >> "$GITHUB_OUTPUT"
fi
printf '%s\n' "$artifact"
