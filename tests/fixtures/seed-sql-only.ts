/** Seed the hermetic integration database without starting a server. */

import { createDbExec } from "@agent-native/core/db";

import { FRAMEWORK_TABLE_DDL } from "../integration/framework-tables";
import { buildScenarioSql } from "./scenario";

const databaseUrl = process.env.DATABASE_URL; // guard:allow-env-credential — test harness database, never logged
if (!databaseUrl) {
  throw new Error("seed-sql-only requires DATABASE_URL");
}

// The framework's own executor, so the seed reaches PGlite exactly the way the
// application under test does.
const client = await createDbExec({ url: databaseUrl });

try {
  for (const sql of FRAMEWORK_TABLE_DDL) {
    await client.execute(sql);
  }
  for (const sql of buildScenarioSql()) {
    await client.execute(sql);
  }
} finally {
  await client.close?.();
}

// PGlite keeps the event loop alive after `close()`, so a finished seed would
// otherwise hang — and keep its directory lock, which the next step of the
// harness needs. Exiting releases the lock through the framework's exit hook.
process.exit(0);
