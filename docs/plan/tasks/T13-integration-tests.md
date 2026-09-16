# T13 — Integration tests through the CLI surface

Goal: prove action-layer parity without a model: the same use case invoked through the framework
CLI runner behaves like the HTTP surface, against a fresh Node SQLite database.

Depends on: T10, T11. Read: F6 (CLI identity), F13; B18 (integration row).

## Steps

1. Extend `scripts/test-integration.mjs` as the **sole database lifecycle owner**: set
   `DATABASE_URL=file:./data/test-integration.db`, delete the database and its WAL sidecars, run
   `scripts/migrate-local.mjs`, create the framework's `organizations` and `org_members` tables
   with F6 DDL shared in `tests/integration/framework-tables.ts`, then run
   `pnpm exec tsx tests/fixtures/seed-sql-only.ts` to apply `buildScenarioSql()` through
   `@libsql/client`. `global-setup.ts` must only verify the prepared database; it must not delete
   or seed it. Run Vitest, then rebuild the same database before CLI checks because the real
   repository tests intentionally mutate scenario rows.
2. Run CLI checks with `child_process.spawnSync("pnpm", ["action", ...], { env })` and fail on
   mismatch. The 0.176.5 runner writes `console.log(result)` and application logs may precede it;
   parse the final printed inspected value rather than assuming stdout is JSON.
3. CLI checks (env `AGENT_USER_EMAIL`, `AGENT_ORG_ID`, `DATABASE_URL` as above):
   `member1@example.invalid`/`org_acme` `complete-job '{"jobId":"job_in_progress"}'` → parsed result
   `resource.status === "completed"`, `resource.version === 3`; then `list-recent-activity` shows
   the new `complete-job` operation with `performedVia: "cli"`; `undo-operation` with that id →
   `resource.status === "in_progress"`; `outsider@example.invalid`/`org_other` `get-job '{"jobId":"job_scheduled"}'`
   → non-zero exit and stderr containing `Job not found` (the 0.176.5 runner prints only
   `err.message`, not `errorCode`); `member1`/`org_acme`
   `archive-customer '{"customerId":"cus_b"}'` → stderr containing the authorization message;
   `admin@example.invalid`/`org_acme` same call → success; member
   `send-job-to-accounting '{"jobId":"job_completed"}'` → the authorization message; the admin's first
   and repeated export return the same external reference and operation id.
4. `tests/integration/use-cases-d1.test.ts`: run the B9 concurrency scenario against the real
   repositories (two actors, real versions), plus the D27 regression that a member cannot redo an
   admin-only customer archive.

## Deliverables

`scripts/test-integration.mjs`, `tests/fixtures/seed-sql-only.ts`,
`tests/integration/use-cases-d1.test.ts`.

## Acceptance

```bash
pnpm check
pnpm test:integration
```
