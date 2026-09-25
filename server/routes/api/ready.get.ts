import { getDbExec } from "@agent-native/core/db";
import { defineEventHandler, setResponseStatus } from "h3";

import { MIGRATION_FILES } from "../../../src/infrastructure/migrations-manifest";

/**
 * Readiness probe (blueprint B19): is this deployment's database at the schema version this
 * build expects?
 *
 * The runner records the bare file name: `scripts/migrate.mjs` inserts `"0001_init.sql"`
 * into `d1_migrations`, whichever dialect it is applying to. The table keeps its
 * Wrangler-era name because renaming it would be a migration of its own for no gain
 * (T28). So the recorded names compare directly against `MIGRATION_FILES`, which
 * `scripts/gen-migrations-manifest.mjs` embeds at build time. Embedded rather than read from
 * `migrations/` at runtime because the question is what *this build* expects, not what files
 * happen to sit next to the running process.
 *
 * `applied` counts expected migrations that the database has recorded, not rows in the
 * table: a leftover row for a file that no longer exists in the repository must not make a
 * deployment look ready. Only app-owned migrations are considered — the framework owns its
 * own tables and migrates them itself at first database touch (D06).
 *
 * Public (`publicPaths` in `server/plugins/auth.ts`): a probe that needs a session cannot
 * tell "not deployed yet" from "not signed in".
 */
export default defineEventHandler(async (event) => {
  let recorded: ReadonlySet<string>;
  try {
    const result = await getDbExec().execute("SELECT name FROM d1_migrations");
    recorded = new Set(result.rows.map((row) => String(row.name)));
  } catch {
    // No bookkeeping table yet: nothing has ever been applied to this database.
    recorded = new Set<string>();
  }

  const missing = MIGRATION_FILES.filter((name) => !recorded.has(name));
  const expected = MIGRATION_FILES.length;
  const applied = expected - missing.length;
  const ready = missing.length === 0;

  if (!ready) setResponseStatus(event, 503);

  return { ready, migrations: { applied, expected, missing } };
});
