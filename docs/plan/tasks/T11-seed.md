# T11 — Seed scenario and seed script

Goal: the deterministic scenario as SQL builders plus a script that seeds the Node SQLite file,
local D1 and remote staging D1, and registers the seed users over HTTP.

Depends on: T07. Read: F6 (tables, endpoints), F10; B12, B13; D16.

## Steps

1. Extend `tests/fixtures/scenario.ts`: named builders `createCompanyWithMembers()`,
   `createForeignOrganization()`, `createCustomers()`, `createScheduledJob()`,
   `createInProgressJob()`, `createCompletedJob()`, `createArchivedJob()`,
   `createForeignOrganizationJob()` each returning typed rows; `buildScenario()` composes them;
   `buildScenarioSql(): string[]` renders INSERT statements with literal values (escape single
   quotes by doubling; JSON columns as JSON text); `buildScenarioResetSql(): string[]` per B12.
   `organizations` and `org_members` rows must include every NOT NULL column found in
   `node_modules/@agent-native/core/dist/org/migrations.js` (record the column list in a comment).
   Keep `seedInMemory` in sync with `buildScenario()` (derive it from the same builders).
   Also make the in-memory repositories return lists in the same order as the D1 adapters
   (customers `name, id`; jobs `scheduled_at, id`; operations `performed_at DESC, id DESC`) so
   unit and integration tests agree (T08 found them unordered).
2. `scripts/seed.mjs`: arguments `--target node|d1-local|d1-remote`, `--env <wrangler env>`
   (required for `d1-remote`), `--base-url` (default `http://localhost:8080` for node,
   `http://127.0.0.1:8787` for d1-local, required for d1-remote), `--reset`, `--skip-users`.
   Refuses `--env production` and any base URL containing `production`. Order: (1) if `--reset`,
   execute reset SQL; (2) execute scenario SQL — `node`: `@libsql/client` on `DATABASE_URL`;
   `d1-local`: write a temp `.sql` file and run `wrangler d1 execute example-jobs-local --local --file <tmp>`;
   `d1-remote`: same with `--remote --env <env>` and database name `example-jobs-<env>`;
   (3) unless `--skip-users`, for each user: `POST <base>/_agent-native/auth/register`; on
   HTTP 200 continue; on 4xx whose body mentions the account existing, `POST .../login` must
   return 200; otherwise fail. Password from `SEED_PASSWORD` (default from B12). Print one line
   per step. Users are registered after SQL so `org/me` resolves the membership immediately.
   Idempotent: `INSERT OR IGNORE` for all scenario rows.
3. `package.json`: `db:seed`, `db:seed:worker` per B15.
4. Verify: `pnpm db:reset && pnpm dev` (background) `&& pnpm db:seed`; then login as
   `member1@example.invalid` and `GET /_agent-native/org/me` returns `orgId: "org_acme"`,
   `role: "member"`; `list-jobs` returns three non-archived jobs; login as
   `outsider@example.invalid` → `org/me.orgId === "org_other"`, `list-jobs` returns one job.
   Then the same against the Worker: `pnpm build:worker && pnpm db:reset && pnpm dev:worker:serve`
   (background) `&& pnpm db:seed:worker`.

## Deliverables

`tests/fixtures/scenario.ts`, `scripts/seed.mjs`, `package.json`.

## Acceptance

```bash
pnpm check
pnpm db:reset && (pnpm dev > /tmp/dev.log 2>&1 &) && sleep 20 && pnpm db:seed && pnpm db:seed   # second run is a no-op
```
plus the step 4 transcript.
