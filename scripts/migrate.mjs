#!/usr/bin/env node
// Applies `migrations/*.sql` to whatever `DATABASE_URL` points at (decisions D05, D06; T28).
//
// One migration source, one runner, two dialects. It goes through the framework's own
// executor rather than a driver of its own, which is what makes that possible: the
// executor resolves SQLite or PostgreSQL from the URL and, on PostgreSQL, rewrites `?`
// placeholders to `$n` through a real parser. The bookkeeping table is still named
// `d1_migrations` and still holds the bare migration file name, because `/api/ready`
// asks that one question of every runtime — renaming it would be a migration of its own
// for no gain beyond tidiness.
//
// Wrangler's own runner is gone with Cloudflare, so this is no longer "the local one".

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createDbExec } from "@agent-native/core/db";

import { addonDatabaseUrl } from "./lib/addon-url.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const migrationsDir = path.join(repoRoot, "migrations");

// Clever Cloud injects the connection string under its own name; `server/plugins/
// 00-database-url.ts` does the same mapping for the running application. A script is not
// the application, so it repeats the two lines rather than importing a Nitro plugin.
// `--addon <name>` is how CI reaches a deployed database: the connection string is fetched
// through the Clever Cloud CLI in-process and never touches a log or a command line.
const { values: options } = parseArgs({
  options: { addon: { type: "string" } },
});
const url = options.addon
  ? addonDatabaseUrl(options.addon)
  : process.env.DATABASE_URL || // guard:allow-env-credential — connection string, never logged
    process.env.POSTGRESQL_ADDON_URI || // guard:allow-env-credential — platform-injected, never logged
    "file:./data/app.db";

const isFile = url.startsWith("file:");
if (!isFile && !/^postgres(ql)?:\/\//.test(url)) {
  console.error(
    `db:migrate: DATABASE_URL must be a "file:" or "postgres://" URL. Got a ${url.split(":")[0]}: URL.`,
  );
  process.exit(1);
}

/**
 * `file:./data/app.db` (the framework's own default spelling) is not a valid file URL, so
 * only the `file://` form goes through `fileURLToPath`.
 * @param {string} databaseUrl
 * @returns {string} absolute path to the database file
 */
function databaseFilePath(databaseUrl) {
  const raw = databaseUrl.startsWith("file://")
    ? fileURLToPath(databaseUrl)
    : databaseUrl.slice("file:".length);
  return path.resolve(repoRoot, raw);
}

/**
 * Split a migration file into executable statements. Statements are separated by a `;` at
 * the end of a line; statements that are empty or contain only `--` comments are dropped.
 * @param {string} sql
 * @returns {string[]}
 */
function splitStatements(sql) {
  return sql
    .split(/;\s*\r?\n/)
    .map((statement) => statement.trim().replace(/;$/, "").trim())
    .filter((statement) => {
      if (statement === "") return false;
      return statement
        .split(/\r?\n/)
        .some((line) => line.trim() !== "" && !line.trim().startsWith("--"));
    });
}

if (isFile) mkdirSync(path.dirname(databaseFilePath(url)), { recursive: true });

const client = await createDbExec({ url });

try {
  // No AUTOINCREMENT and no surrogate key: the file name is the identity, and the column
  // types here are the intersection both dialects accept unchanged. `IF NOT EXISTS` means
  // a database created by the older SQLite-only runner keeps its extra `id` column, which
  // nothing reads.
  await client.execute(
    "CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );

  const applied = new Set(
    (await client.execute("SELECT name FROM d1_migrations")).rows.map(
      (row) => `${row.name}`,
    ),
  );

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const name of files) {
    if (applied.has(name)) continue;
    const statements = splitStatements(
      readFileSync(path.join(migrationsDir, name), "utf8"),
    );
    // One transaction per file: a migration either lands whole or not at all, and a failed
    // file is never recorded, so re-running the script retries it. Both dialects give the
    // executor a `transaction`; D1's batch-only shape, which did not, is gone.
    if (!client.transaction) {
      console.error(
        "db:migrate: this database exposes no interactive transaction; refusing to apply a migration that could land half way.",
      );
      process.exit(1);
    }
    try {
      await client.transaction(async (tx) => {
        for (const statement of statements) await tx.execute(statement);
        await tx.execute({
          sql: "INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)",
          args: [name, new Date().toISOString()],
        });
      });
    } catch (error) {
      throw new Error(`db:migrate: ${name} failed: ${error}`, { cause: error });
    }
    console.log(`applied ${name}`);
    count += 1;
  }

  if (count === 0) console.log("up to date");
} finally {
  await client.close?.();
}
