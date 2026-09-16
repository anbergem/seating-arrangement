# T27 — External integration port and `send-job-to-accounting`

Goal: one integration-backed command, end to end, proving the pattern an integration-heavy
application copies: port, mock adapter, durable request and retry reconciliation with an idempotency key, irreversible
classification, approval gate for the agent.

Depends on: T10. Read: B4 (`markSentToAccounting`), B6 (`jobs:export`), B7 (port), B8 row,
B10 (migration 0002), B11 (`UPDATE_JOB_VERSIONED`), B22; D26; F5 (`needsApproval`).

## Steps

1. Domain: add `accountingReference` and `accountingSentAt` to `Job` and to `createJob`
   (both `null`), and `markSentToAccounting` per B4. Update `restoreJobStatus` so it never
   touches the accounting fields. Tests in `tests/unit/domain/job.test.ts`.
2. Migration `migrations/0002_job_accounting.sql` per B10; update `server/db/schema.ts`,
   regenerate the manifest (`pnpm db:migrate` runs the generator), update every jobs SQL
   constant and mapper in `src/infrastructure/d1` for the two columns, and the in-memory
   fixture and scenario builders (`null` for every seeded job).
3. Port and mock per B22: the port already exists at `src/application/ports/external-accounting.ts`
   (T05); add `src/infrastructure/mock/mock-accounting.ts` and replace the container's placeholder
   adapter (T07 wired one that throws `ExternalSystemError("The accounting system is not configured")`)
   and the trivial in-memory fixture mock with it (fresh mock per test).
4. Authorization: add `jobs:export` to admin and owner (B6) and extend the matrix test.
5. Use case and action per B22 as revised by D27: add the durable `accounting_exports`
   port/adapter/schema and immutable pending request before any vendor call. Reconciliation
   must succeed after an intervening archive without overwriting it. Unit tests `tests/unit/application/send-job-to-accounting.test.ts`:
   success (reference `ACC-<id>`, version + 1, operation `irreversible` with `inverse: null`,
   payload); member → AUTHORIZATION; job not completed → INVARIANT; already sent → replay the completed request with no duplicate effect;
   other org → NOT_FOUND; adapter failure → EXTERNAL, a durable pending request and no falsely completed operation;
   CONFLICT on the local commit followed by a retry returns the same reference with
   `alreadyExisted: true` (drive it by mutating the in-memory job between steps using a
   `beforeCommit` hook on the in-memory repository — add that hook to the fixture); undo of this
   operation is refused with INVARIANT `This operation cannot be undone`.
6. `list-recent-activity` shows the operation as not undoable; `agent/AGENTS.md` lists the
   action as irreversible and approval-gated (T03 already reserved the line).
7. Integration check in `scripts/test-integration.mjs`: as `admin@example.invalid`/`org_acme`,
   `pnpm action send-job-to-accounting '{"jobId":"job_completed"}'` returns
   `externalReference: "ACC-job_completed"`; a second call returns the recorded result with no second effect.
8. Verify on the Node dev server that the framework pauses the agent on this action when a
   provider key is available (optional); at minimum verify with curl that the HTTP call as admin
   succeeds and as member returns 403.

## Deliverables

`src/domain/job.ts`, `migrations/0002_job_accounting.sql`, `server/db/schema.ts`,
`src/infrastructure/migrations-manifest.ts`, `src/infrastructure/d1/*`,
`src/application/ports/external-accounting.ts`, `src/infrastructure/mock/mock-accounting.ts`,
`src/application/{ports,authorization}.ts`, `src/infrastructure/container.ts`,
`src/application/use-cases/send-job-to-accounting.ts`, `actions/send-job-to-accounting.ts`,
`tests/fixtures/{in-memory,scenario}.ts`, tests listed above, `scripts/test-integration.mjs`,
`agent/AGENTS.md`.

## Acceptance

```bash
pnpm check
pnpm test:integration
pnpm db:reset    # applies 0001 and 0002 to the local SQLite file
```

Additional acceptance (D27): exercise response loss after acceptance, concurrent requests,
restart/retry from persisted intent, archive-before-commit, and preserved newer fields.
