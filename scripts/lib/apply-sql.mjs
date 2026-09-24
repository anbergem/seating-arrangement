#!/usr/bin/env node
// Applies a `.sql` file to a local SQLite database, in one transaction (T28).
//
// It exists so a synchronous caller can do an asynchronous write: the e2e reset helper
// runs inside Playwright fixtures that are synchronous by construction, and `@libsql/client`
// is promise-based. `wrangler d1 execute --file` filled this role before Cloudflare went.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { createClient } from "@libsql/client";

const { values } = parseArgs({
  options: { db: { type: "string" }, file: { type: "string" } },
});

if (!values.db || !values.file) {
  console.error("usage: apply-sql.mjs --db <sqlite file> --file <sql file>");
  process.exit(1);
}

const statements = readFileSync(values.file, "utf8")
  .split(/;\s*\r?\n/)
  .map((statement) => statement.trim().replace(/;$/, "").trim())
  .filter((statement) => statement !== "" && !statement.startsWith("--"));

const client = createClient({ url: `file:${values.db}` });
try {
  const tx = await client.transaction("write");
  try {
    for (const statement of statements) await tx.execute(statement);
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
} finally {
  client.close();
}
