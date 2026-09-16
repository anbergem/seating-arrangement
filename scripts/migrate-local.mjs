#!/usr/bin/env node
// Applies `migrations/*.sql` to the local SQLite file used by `pnpm dev` (decisions D05, D06).
//
// One migration source, two runners: `wrangler d1 migrations apply` owns D1, this script owns
// the Node dev server's file. It deliberately mimics Wrangler's bookkeeping — a table named
// `d1_migrations` holding the migration file name — so `/api/ready` can ask the same question
// of both runtimes with one query.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const migrationsDir = path.join(repoRoot, "migrations");

const url = process.env.DATABASE_URL ?? "file:./data/app.db";
if (!url.startsWith("file:")) {
  // Postgres and remote libsql are out of scope: this runner exists for the local SQLite
  // file only, and pointing it at a shared database would apply app DDL somewhere the
  // Wrangler runner owns.
  console.error(
    `db:migrate: DATABASE_URL must start with "file:" (got "${url}"). Local SQLite only.`,
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

const databasePath = databaseFilePath(url);
mkdirSync(path.dirname(databasePath), { recursive: true });

const client = createClient({ url: `file:${databasePath}` });

try {
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
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
    // file is never recorded, so re-running the script retries it.
    const tx = await client.transaction("write");
    try {
      for (const statement of statements) await tx.execute(statement);
      await tx.execute({
        sql: "INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)",
        args: [name, new Date().toISOString()],
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw new Error(`db:migrate: ${name} failed: ${error}`, { cause: error });
    }
    console.log(`applied ${name}`);
    count += 1;
  }

  if (count === 0) console.log("up to date");
} finally {
  client.close();
}
