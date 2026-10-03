#!/usr/bin/env node
// Applies a `.sql` file to a test database on this machine, in one transaction (T28).
//
// It exists so a synchronous caller can do an asynchronous write: the e2e reset helper runs
// inside Playwright fixtures that are synchronous by construction, and the database client is
// promise-based. It goes through the framework's own executor, so the SQL reaches PostgreSQL
// exactly as the application under test does — and only a server on this machine is
// accepted, because the reset SQL deletes rows.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { createDbExec } from "@agent-native/core/db";

import { isLocalPostgresUrl } from "./local-postgres.mjs";

const { values } = parseArgs({
  options: { url: { type: "string" }, file: { type: "string" } },
});

if (!values.url || !values.file) {
  console.error(
    "usage: apply-sql.mjs --url <postgres://localhost/...> --file <sql file>",
  );
  process.exit(1);
}
if (!isLocalPostgresUrl(values.url)) {
  console.error("apply-sql: refusing a database that is not on this machine");
  process.exit(1);
}

const statements = readFileSync(values.file, "utf8")
  .split(/;\s*\r?\n/)
  .map((statement) => statement.trim().replace(/;$/, "").trim())
  .filter((statement) => statement !== "" && !statement.startsWith("--"));

const client = await createDbExec({ url: values.url });
try {
  await client.transaction(async (tx) => {
    for (const statement of statements) await tx.execute(statement);
  });
} finally {
  await client.close?.();
}
// The client's pool can keep the event loop alive after `close()`; a finished apply must not
// hold the caller, which is waiting synchronously.
process.exit(0);
