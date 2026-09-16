/** Seed the hermetic integration database without starting a Node server. */

import { createClient } from "@libsql/client";

import { FRAMEWORK_TABLE_DDL } from "../integration/framework-tables";
import { buildScenarioSql } from "./scenario";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("seed-sql-only requires DATABASE_URL");
}

const client = createClient({ url: databaseUrl });

try {
  for (const sql of FRAMEWORK_TABLE_DDL) {
    await client.execute(sql);
  }
  for (const sql of buildScenarioSql()) {
    await client.execute(sql);
  }
} finally {
  client.close();
}
