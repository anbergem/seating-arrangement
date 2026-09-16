# T07 — Infrastructure: repositories, atomic writes, container

Goal: the D1/SQLite adapters for every port, the atomic write helper, ids, clock, logging, and the
dependency container used by actions.

Depends on: T06. Read: F6 (role lookup), F8; B7, B11, B16 (logging); D07.

## Steps

1. `src/infrastructure/d1/sql.ts`: every statement as an exported `const` string. Required
   statements (names normative): `SELECT_CUSTOMER_BY_ID`, `SELECT_CUSTOMERS`,
   `INSERT_CUSTOMER`, `UPDATE_CUSTOMER_VERSIONED`, `SELECT_JOB_BY_ID`, `SELECT_JOBS`,
   `INSERT_JOB_IF_ACTIVE_CUSTOMER`, `UPDATE_JOB_VERSIONED`, `INSERT_OPERATION_IF_VERSION`
   (guard on jobs), `INSERT_OPERATION_IF_CUSTOMER_VERSION` (guard on customers),
   `INSERT_OPERATION_IF_RESOURCE_EXISTS` (for creates), `MARK_OPERATION_UNDONE`,
   `SELECT_OPERATION_BY_ID`, `SELECT_RECENT_OPERATIONS`, `SELECT_OPERATIONS_FOR_RESOURCE`,
   `INSERT_IDEMPOTENCY_KEY`, `SELECT_IDEMPOTENCY_KEY`, `SELECT_MEMBER_ROLE`. Every constant
   except `SELECT_MEMBER_ROLE` contains `org_id = ?`; `SELECT_MEMBER_ROLE` contains `org_id = ?`
   too. `SELECT_JOBS` supports optional filters by building the WHERE clause in code from a
   fixed set of fragments (status, customer_id, scheduled_at >= ?, scheduled_at < ?) — the
   fragments are also exported constants and also contain no user-controlled SQL.
2. `src/infrastructure/d1/atomic.ts` per B11 (`runAtomic`).
3. `src/infrastructure/d1/mappers.ts`: row → `Customer`, `Job`, `Operation` (parse `payload`
   and `inverse` JSON; invalid JSON → `null` plus a logged warning).
4. Repositories `customers-repository.ts`, `jobs-repository.ts`, `operations-repository.ts`,
   `idempotency-store.ts`, `membership-reader.ts` implementing the B7 ports with the B11 batch
   shapes. Constructor takes a `DbExecLike` (`{ execute, atomicBatch?, transaction? }`) so tests
   can inject the framework executor; production uses `getDbExec()` lazily on first use.
5. `src/infrastructure/system-clock.ts`, `random-ids.ts` (`crypto.randomUUID()`),
   `logging.ts` (B16 log line; `console.log(JSON.stringify(...))`; email never included),
   `env.ts` (`readAppEnv(): "local"|"ci"|"staging"|"production"` with the doctor opt-out marker),
   `container.ts` (`getDependencies(): Dependencies` memoised; on Workers the executor is
   request-scoped by the framework, so memoise the repository objects but call `getDbExec()`
   inside each method rather than caching the executor).
6. `tests/unit/infrastructure/sql-scoping.test.ts`: import `sql.ts`, iterate every exported
   string, assert it contains `org_id = ?` (allow `org_id IN` for none; there is none).
7. `vitest.integration.config.ts`: `test.include: ["tests/integration/**/*.test.ts"]`,
   `globalSetup: "tests/integration/global-setup.ts"` which sets
   `process.env.DATABASE_URL = "file:./data/test-integration.db"`, deletes that file, and runs
   `scripts/migrate-local.mjs` (spawn). `package.json`: `test:integration`:
   `node scripts/test-integration.mjs`, where the script (for now) runs
   `vitest --run --config vitest.integration.config.ts`; T13 extends it.
8. `tests/integration/repositories.test.ts` against the real executor
   (`getDbExec()` from `@agent-native/core/db` with the env above): insert two orgs' rows via the
   repositories; `getById` across orgs returns null; `commit` with a stale version throws
   CONFLICT and leaves no operation row; `create` job for an archived customer throws NOT_FOUND
   and leaves no rows; idempotency key insert + `find`; membership reader returns the role
   case-insensitively (insert an `org_members` row directly with SQL, creating the table with the
   framework's DDL from F6 if it does not exist in the test database).

## Deliverables

`src/infrastructure/**`, `vitest.integration.config.ts`, `scripts/test-integration.mjs`,
`tests/integration/{global-setup.ts,repositories.test.ts}`,
`tests/unit/infrastructure/sql-scoping.test.ts`, `package.json`.

## Acceptance

```bash
pnpm check
pnpm test:integration
node scripts/check-boundaries.mjs
```
