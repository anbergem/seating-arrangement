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
- [Where the data lives](#where-the-data-lives)
- [Moving somewhere else](#moving-somewhere-else)

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
| `events` | The occasion a seating plan belongs to |
| `seating_tables` | One table on an event's floor plan, with its seats as a JSON column |
| `seating_cells` | One row per grid cell a table covers. Its primary key `(org_id, event_id, x, y)` **is** the rule that two tables may not overlap |
| `operations` | The undo ledger: one row per change, with its inverse |
| `idempotency_keys` | `(org_id, action, key)` → the resource a create produced |

`seating_cells` is derived state, and the only derived state in the schema. It is written in
the same atomic batch as the table row it describes, never separately and never by a
background job, because the moment the two could disagree the constraint would stop meaning
what it says.

`AGENT_NATIVE_SKIP_ENSURE_TABLES` is never set: CI exercises the framework's bootstrap on every
run by booting the built server against a fresh, empty SQLite file.

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

On a deployed environment the framework defers its migrations to the first request that
touches the database, so one `GET /_agent-native/health` is enough.
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
        │
        └── scripts/migrate.mjs   →  whatever DATABASE_URL names
                                     file:./data/app.db  or  postgresql://…
```

Same files, same order, every environment, one runner. It goes through the framework's own
executor rather than a driver of its own, which is what makes one runner possible: the executor
resolves SQLite or PostgreSQL from the URL, and on PostgreSQL rewrites `?` placeholders to
`$n` through a real parser. The bookkeeping table is still called `d1_migrations` and still
holds the bare file name, so `/api/ready` asks one question of every runtime; renaming it would
be a migration of its own for no gain.

The 86 lines of SQL in `migrations/` applied to a real PostgreSQL instance unmodified. That is
not luck — `TEXT`, `INTEGER`, ISO-string timestamps, `length()` checks and composite foreign
keys are the intersection both dialects accept.

## Commands per environment

| Environment | Migrate | Seed |
| --- | --- | --- |
| Local (`pnpm dev`, or `pnpm start`) | `pnpm db:migrate` | `pnpm db:seed` |
| From scratch | `pnpm db:reset` | **still required** — see below |
| Staging | the deploy workflow | the deploy workflow, QA org only |
| Production | the promotion workflow | **never** |

`pnpm db:reset` deletes `data/app.db*` and migrates again. It refuses to run when
`DATABASE_URL` is not a local file, because it deletes.

**A reset leaves you signed out of an empty application, and it does not say so.** The user
accounts live in the database it just deleted, so the next `pnpm dev` serves a working app with
no organizations, no events and no way in: signing in as `owner@example.invalid` answers
"incorrect password" for a password that is correct, because the account no longer exists.
Nothing in the output warns you — the server starts cleanly and every route returns 200. Always
finish the sequence with `pnpm dev` and then `pnpm db:seed`, and treat `pnpm db:reset` on its own
as an unfinished command. Rewriting a migration is the usual reason to reach for it, so this is
easy to do in the middle of a schema change and not notice until the app is open.

A deployed database is reached with `--addon`, which resolves the connection string through the
Clever Cloud CLI in-process so it never appears in a log or a command line:

```bash
node scripts/migrate.mjs --addon <app>-staging-db
```

That is what the workflows run. Doing it by hand against production is an incident procedure,
not a routine.

Inspecting a database:

```bash
clever addon list                    # find the add-on
# then use any PostgreSQL client with the connection string from the console,
# or for the local file:
sqlite3 data/app.db "SELECT name FROM d1_migrations ORDER BY name"
```

## Writing a migration

Create the file by hand, named `NNNN_snake_case.sql` after the highest existing number:

```bash
$EDITOR migrations/0002_event_venue.sql
```

Rules:

- **Never edit an applied migration.** Both runners record the file *name*. An edited file is
  silently skipped in every environment that already ran it, so the schema silently diverges.
  Add a new file.
- **Regenerate the manifest.** `src/infrastructure/migrations-manifest.ts` is generated from
  the directory listing by `scripts/gen-migrations-manifest.mjs`, which `pnpm db:migrate`
  runs. It is committed, so a plain `pnpm typecheck` or `vitest` run
  does not depend on the build having happened. The generator formats its own output with the
  repository's `oxfmt`, so the committed file passes `pnpm lint` at any number of migrations.
- **Mirror the change in `server/db/schema.ts`.** New tables need `org_id` (or
  `owner_email`), or the doctor fails.
- **Update the fixtures.** `tests/fixtures/scenario.ts` is the executable form of the
  deterministic scenario; a new NOT NULL column needs a value there, and
  `tests/fixtures/scenario-sql.ts` is what `scripts/seed.mjs` reads.
- **Keep the constraints in SQL.** `migrations/0001_init.sql` carries `CHECK` constraints for
  the status enums and the length limits the domain also enforces. Belt and braces: the domain
  is the readable rule, the constraint is the one a bad migration or a hand-typed `UPDATE`
  cannot get around. PostgreSQL enforces foreign keys always; the SQLite runner turns
  `PRAGMA foreign_keys` on.

## Expand and contract

Migrations run **before** the new code is deployed, so for a moment the old code is running
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
record the database backups that exist   (production only)
node scripts/migrate.mjs --addon <app>-db
clever deploy
smoke
```

Migrating first is deliberate: a migration that fails fails the **deployment**, and the
application still serving traffic is untouched. The alternative — migrating at boot — turns a
bad migration into an outage.

**Rolling the code back does not roll the database back.** Re-promoting the previous commit
restores the previous code; the migration that ran is still applied. That is why migrations
must be backwards compatible, and why the backup list is recorded *before* the migration rather
than after: if a migration corrupts data, a code rollback is not the fix — the backup is.

The production workflow records what backups exist into the workflow job summary before it migrates, and
on failure appends the recovery guidance. `docs/runbook.md` § *Recover after a bad migration*
is the procedure; the short version is that a restore is through the console, with the
application stopped, and never over live traffic.

## The migration runner

`scripts/migrate.mjs`:

- resolves `DATABASE_URL`, `POSTGRESQL_ADDON_URI` or `--addon <name>`, in that order;
- applies `migrations/*.sql` in name order through the framework's executor, one transaction
  per file, so a failed file is never recorded and re-running retries it;
- records each applied file name in a `d1_migrations` table it creates itself.

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
`src/infrastructure/migrations-manifest.ts`, which is generated from the directory listing and
committed, so the answer does not depend on what happens to be on disk at runtime. It counts *expected* migrations that are recorded, not rows in
the table, so a leftover row for a file that no longer exists cannot make a deployment look
ready. It returns HTTP 503 when it is not, and it is public (a probe that needs a session
cannot distinguish "not deployed yet" from "not signed in"). It exposes migration file names
and nothing else.

The framework's own tables are not its business. Use `GET /_agent-native/health` for that: it
reports `ok`, `ready`, `db` and `database.dialect`.

## How the repositories talk to the database

Not through an ORM. `src/infrastructure/sql/` uses the framework's executor with hand-written
parameterized SQL, because the guarantees this application needs are expressed as predicates
rather than as object graphs.

- **Every statement is a named constant** in `src/infrastructure/sql/sql.ts`, and every one
  contains `org_id = ?`. `tests/unit/infrastructure/sql-scoping.test.ts` asserts it for every
  exported statement. Optional list filters are grouped in a frozen record per statement
  (`SELECT_JOBS_PARTS`, `SELECT_CUSTOMERS_PARTS`) and checked against a fixed
  `AND <column> <operator> ?` allow-list, so no caller value can reach the SQL text.
- **Placeholders are `?`.** There is no string interpolation of a value anywhere.
- **Multi-statement writes go through `runAtomic`** (`src/infrastructure/sql/atomic.ts`), which
  uses a `transaction` where one exists and a batch otherwise. A stale writer affects zero rows
  in every statement, so nothing is written.
- **The version guard is in the SQL**, on both the operation insert and the resource update,
  guarded on the version the caller read. Both row counts are checked; anything other than one
  row each is `CONFLICT`.
- **The executor is resolved per call, never cached.** `getDbExec()` resolves the executor for
  the request being served. There is one wrinkle worth knowing: the framework returns a lazy
  proxy that advertises **both** `atomicBatch` and `transaction` until its first query has
  chosen a driver, so `resolveExec` issues one `SELECT 1` when both are advertised and re-reads
  the shape before choosing. Without that, a local-file write goes down the `atomicBatch` path
  and throws `This database does not support atomic batches`.

## Where the data lives

Both databases are created in the Clever Cloud zone `CLEVER_REGION` names, `par` (Paris) by
default. The European zones are `par`, `parhds`, `rbx`, `rbxhds`, `grahds`, `wsw` and `ldn`;
`parhds` and `grahds` are the French health-data-certified ones.

Two things about that choice:

- **Decide before the first run.** Moving a database between zones means a new add-on, a dump
  and a load — with downtime.
- **Keep the application and its database in the same zone.** They talk on every request. A
  database on another continent from its application is the single most expensive mistake
  available here: measured on the arrangement this replaced, one health check went from 6ms to
  260ms that way, and every page that asks several questions pays it several times
  (`docs/plan/DISCREPANCIES.md`, 2026-09-16).

One honest caveat about residency: the embedded agent calls Anthropic, which is American. Where
the database sits does not change that. `@ai-sdk/mistral` is already a dependency if a European
model provider matters more than the default — it is an `AGENT_ENGINE` change and a key, not a
project.

## Moving somewhere else

The repository layer is portable by construction, and this repository has now proved it rather
than claimed it: moving off Cloudflare D1 to PostgreSQL needed **one** change in 1,346 lines of
repositories, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`. Nothing under `src/` or `server/`
imports a platform type or calls a platform API.

Two things do that work. The framework's executor rewrites `?` placeholders for PostgreSQL, so
the statements are dialect-neutral as written. And `runAtomic` is a seam: repositories build a
list of statements and never learn which runtime applied them, so a runtime with `transaction`
and one with only a batch API are both fine.

What a move costs is the deployment half — `scripts/bootstrap.mjs`, the deploy workflows, the
e2e launcher and the docs. `docs/plan/tasks/T28-clever-cloud-migration.md` is the worked
example.
