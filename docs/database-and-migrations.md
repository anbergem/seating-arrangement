# Database and migrations

One SQL database per environment. One migration source. Two owners.

- [Two schema owners](#two-schema-owners)
- [Two runtimes, one migration source](#two-runtimes-one-migration-source)
- [Commands per environment](#commands-per-environment)
- [Writing a migration](#writing-a-migration)
- [Expand and contract](#expand-and-contract)
- [Deploy ordering, and what a rollback does not undo](#deploy-ordering-and-what-a-rollback-does-not-undo)
- [The local migration runner](#the-local-migration-runner)
- [Readiness](#readiness)
- [How the repositories talk to the database](#how-the-repositories-talk-to-the-database)
- [D1 jurisdiction and residency](#d1-jurisdiction-and-residency)
- [The Node + libSQL fallback](#the-node--libsql-fallback)

## Two schema owners

This is the thing to understand before anything else, because it explains most first-run
confusion.

**The framework owns its own tables and migrates them itself, at runtime.** Users, sessions,
accounts, organizations, memberships, invitations, the audit log, settings, agent runs — about
fifty tables. They are created by the framework's own migration runners
(`_better_auth_migrations`, `_org_migrations`, and others) during **the first request that
touches the database**. Not at deploy time. Not from a file in this repository.

**We own five tables**, in `migrations/*.sql`:

| Table | What it holds |
| --- | --- |
| `customers` | The sample customer aggregate |
| `jobs` | The sample job aggregate |
| `operations` | The undo ledger: one row per change, with its inverse |
| `idempotency_keys` | `(org_id, action, key)` → the resource a create produced |
| `accounting_exports` | The durable pending request for the external integration |

`AGENT_NATIVE_SKIP_ENSURE_TABLES` is never set: CI exercises the framework's bootstrap on every
run by booting the Worker against a fresh local D1.

Three consequences you will meet in practice.

**A freshly migrated database has no `organizations` table.** So this fails:

```bash
pnpm db:reset && pnpm db:seed          # ✘ no such table: organizations
```

The seed inserts organization and membership rows, and those tables do not exist until the app
has opened the database. Start the app first:

```bash
pnpm db:reset
pnpm dev                                # applies the framework migrations at boot
# in another terminal:
pnpm db:seed
```

Under `wrangler dev` and on a deployed Worker the framework defers its migrations to the first
request that touches the database, so one `GET /_agent-native/health` is enough.
`scripts/seed.mjs` recognises the error and prints that instruction.

**Hermetic tests that never start a server must create those two tables themselves.**
`tests/integration/framework-tables.ts` does it from the framework's own DDL, and is the only
copy of a framework table definition in the repository. Copying more of them would create a
second, drifting definition of somebody else's schema.

**`server/db/schema.ts` is not the source of truth.** It is the typed Drizzle mirror the
framework and its doctor expect — the doctor's `db-tool-scoping` guard requires every table in
it to have an `owner_email` or an `org_id`. The SQL in `migrations/` is what creates anything.
There is no `drizzle-kit generate` and no `drizzle-kit push` anywhere; the doctor's
`no-drizzle-push` guard fails the build if `push` appears in a build or deploy hook.

## Two runtimes, one migration source

```
migrations/0001_init.sql
migrations/0002_job_accounting.sql
        │
        ├── wrangler d1 migrations apply   →  D1 (local, staging, production)
        └── scripts/migrate-local.mjs      →  file:./data/app.db (the Node dev server)
```

Same files, same order, every environment. `scripts/migrate-local.mjs` deliberately mimics
Wrangler's bookkeeping — a `d1_migrations` table holding the migration's bare file name — so
`/api/ready` can ask the same question of both runtimes with one query. It refuses a
`DATABASE_URL` that does not start with `file:`, because pointing it at a shared database would
apply app DDL where the Wrangler runner is the owner.

## Commands per environment

| Environment | Migrate | Seed |
| --- | --- | --- |
| Node dev server (`pnpm dev`) | `pnpm db:migrate` | `pnpm db:seed` |
| Local D1 (`pnpm dev:worker`, Playwright) | `pnpm db:migrate:worker` | `pnpm db:seed:worker` |
| Both, from scratch | `pnpm db:reset` | — |
| Staging | `pnpm db:migrate:staging` | the deploy workflow, QA org only |
| Production | `pnpm db:migrate:production` | **never** |

`pnpm db:reset` deletes `data/app.db*` and `.wrangler/state`, then migrates both. It touches
nothing outside the repository and `--local` never reaches Cloudflare.

Staging and production migrations need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in
the environment. In practice the workflows run them; running
`pnpm db:migrate:production` by hand is an incident procedure, not a routine.

Inspecting a database:

```bash
# local D1
pnpm exec wrangler d1 execute <app>-local --local \
  --command "SELECT name FROM d1_migrations ORDER BY id"

# staging, read-only
pnpm exec wrangler d1 execute <app>-staging --remote --env staging \
  --command "SELECT status, COUNT(*) FROM jobs GROUP BY status"

pnpm exec wrangler d1 migrations list <app>-production --remote --env production
```

## Writing a migration

```bash
pnpm exec wrangler d1 migrations create <app>-local "job assignee history"
# creates migrations/0003_job_assignee_history.sql
```

Rules:

- **Never edit an applied migration.** Both runners record the file *name*. An edited file is
  silently skipped in every environment that already ran it, so the schema silently diverges.
  Add a new file.
- **Regenerate the manifest.** `src/infrastructure/migrations-manifest.ts` is generated from
  the directory listing by `scripts/gen-migrations-manifest.mjs`, which `pnpm db:migrate` and
  `pnpm build:worker` both run. It is committed, so a plain `pnpm typecheck` or `vitest` run
  does not depend on the build having happened. The generator formats its own output with the
  repository's `oxfmt`, so the committed file passes `pnpm lint` at any number of migrations.
- **Mirror the change in `server/db/schema.ts`.** New tables need `org_id` (or
  `owner_email`), or the doctor fails.
- **Update the fixtures.** `tests/fixtures/scenario.ts` is the executable form of the
  deterministic scenario; a new NOT NULL column needs a value there, and
  `tests/fixtures/scenario-sql.ts` is what `scripts/seed.mjs` reads.
- **Keep the constraints in SQL.** `migrations/0001_init.sql` carries `CHECK` constraints for
  the status enums and the length limits the domain also enforces. Belt and braces: the domain
  is the readable rule, the constraint is the one a bad migration or a manual `wrangler d1
  execute` cannot get around. D1 has `PRAGMA foreign_keys` on.

## Expand and contract

Migrations run **before** the new Worker is deployed, so for a moment the old code is running
against the new schema. Every migration has to be safe in that window.

Safe in one release:

- `CREATE TABLE`
- `ADD COLUMN` that is nullable, or has a default
- `CREATE INDEX`
- A new `CHECK` on a new column

Not safe in one release:

- `DROP COLUMN`, `DROP TABLE`, renaming either
- `ADD COLUMN … NOT NULL` with no default
- Narrowing a `CHECK` on data the old code still writes

Those are two releases:

1. **Expand.** Add the new column, nullable. Deploy code that writes both the old and the new
   shape and reads whichever it finds. Backfill.
2. **Contract.** Once nothing writes the old shape, a later release drops it.

For a rename, the same pattern with a different label: add the new column, write both, backfill,
switch reads, then drop the old one in a later release.

## Deploy ordering, and what a rollback does not undo

The staging and production workflows both do this, in this order:

```
record a D1 Time Travel bookmark   (production only)
pnpm db:migrate:<env>
wrangler deploy --env <env>
smoke
```

**Rolling the Worker back does not roll the database back.** `wrangler rollback --env
production` restores the previous script; the migration that ran is still applied. That is why
migrations must be backwards compatible, and why the bookmark is taken *before* the migration
rather than after: if a migration corrupts data, the Worker rollback is not the fix — the
bookmark is.

The production workflow records the bookmark into the job summary before it migrates, and on
failure appends both recovery commands. `docs/runbook.md` § *Recover after a bad migration* is
the procedure; the short version is that a Time Travel restore is in place and a dump restore is
into a new database, never over a live one.

## The local migration runner

`scripts/migrate-local.mjs` exists because the Node dev server does not use D1. It:

- reads `DATABASE_URL`, refuses anything that is not `file:`;
- applies `migrations/*.sql` in name order through `@libsql/client`;
- records each applied file name in a `d1_migrations` table it creates itself, in the same
  shape Wrangler uses.

It is not a general-purpose migration tool and is not meant to grow into one. If you need
something it cannot do, the answer is usually that the thing belongs in a `.sql` file.

## Readiness

`GET /api/ready` answers "is this deployment's database at the schema version this build
expects?"

```bash
curl -s https://<host>/api/ready
# {"ready":true,"migrations":{"applied":2,"expected":2,"missing":[]}}
```

It counts, in `d1_migrations`, the migrations this build knows about — from
`src/infrastructure/migrations-manifest.ts`, embedded at build time because a Worker has no
filesystem to list files with. It counts *expected* migrations that are recorded, not rows in
the table, so a leftover row for a file that no longer exists cannot make a deployment look
ready. It returns HTTP 503 when it is not, and it is public (a probe that needs a session
cannot distinguish "not deployed yet" from "not signed in"). It exposes migration file names
and nothing else.

The framework's own tables are not its business. Use `GET /_agent-native/health` for that: it
reports `ok`, `ready`, `db` and `database.dialect`.

## How the repositories talk to the database

Not through an ORM. `src/infrastructure/d1/` uses the framework's executor with hand-written
parameterized SQL, because D1 has no interactive transactions and the guarantees this
application needs are expressed as predicates.

- **Every statement is a named constant** in `src/infrastructure/d1/sql.ts`, and every one
  contains `org_id = ?`. `tests/unit/infrastructure/sql-scoping.test.ts` asserts it for every
  exported statement. Optional list filters are grouped in a frozen record per statement
  (`SELECT_JOBS_PARTS`, `SELECT_CUSTOMERS_PARTS`) and checked against a fixed
  `AND <column> <operator> ?` allow-list, so no caller value can reach the SQL text.
- **Placeholders are `?`.** There is no string interpolation of a value anywhere.
- **Multi-statement writes go through `runAtomic`** (`src/infrastructure/d1/atomic.ts`), which
  uses D1's `atomicBatch` when it is available and a `transaction` otherwise. Inside one batch,
  a stale writer affects zero rows in every statement, so nothing is written.
- **The version guard is in the SQL**, on both the operation insert and the resource update,
  guarded on the version the caller read. Both row counts are checked; anything other than one
  row each is `CONFLICT`.
- **The executor is resolved per call, never cached.** `getDbExec()` resolves the D1 binding of
  the request being served. There is one wrinkle worth knowing: the framework returns a lazy
  proxy that advertises **both** `atomicBatch` and `transaction` until its first query has
  chosen a driver, so `resolveExec` issues one `SELECT 1` when both are advertised and re-reads
  the shape before choosing. Without that, a local-file write goes down the `atomicBatch` path
  and throws `This database does not support atomic batches`.

## D1 jurisdiction and residency

Both databases are created with `--jurisdiction eu`:

```bash
pnpm exec wrangler d1 create <app>-production --jurisdiction eu
```

Jurisdiction restricts where the database runs and stores data, for local data-protection
compliance. Two things about it:

- **It cannot be changed after creation.** Moving jurisdiction means a new database, an export
  and an import — with downtime. Decide before you run the bootstrap.
- **It overrides `--location`.** When a jurisdiction is set the location hint is ignored, so do
  not pass both and expect the hint to matter.

`scripts/bootstrap.mjs` passes `--jurisdiction eu`. If you need another one, change that
argument before the first run; the current choices are `eu`, `us` and `fedramp`.

## The Node + libSQL fallback

This is Cloudflare-*first*, not Cloudflare-*only*. The repository layer is thin enough to move:
it talks to `getDbExec()`, which the framework backs with libSQL on Node, and it uses no D1
feature beyond `atomicBatch` — for which `runAtomic` already has a `transaction` branch that
the Node dev server and the integration suite exercise on every run.

So a deployment on Node with libSQL or SQLite needs no repository changes. What it does need:

- `DATABASE_URL` pointing at the libSQL server or file, and the startup check's `local` rules
  loosened for that environment class;
- migrations applied by `scripts/migrate-local.mjs` (file) or `wrangler`-less tooling of your
  choice — the SQL is plain SQLite;
- somewhere to run the Node process, and a different deployment pipeline: nothing in
  `.github/workflows/deploy-*.yml` applies.

The reason to keep the option open is the framework's Worker compatibility patch
(`scripts/patch-worker-bundle.mjs`). If an upgrade ever needs substantially more runtime
surgery than two stub getters, moving to Node is the safer answer than growing the patch —
`docs/upgrade-playbook.md` says so as a rule.
