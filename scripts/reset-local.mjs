#!/usr/bin/env node
// Throws away the local database and rebuilds it from `migrations/` alone (D05).
//
// Local development runs PostgreSQL on this machine (or PGlite, in-process) — the framework
// is PostgreSQL-only since 0.177. This drops that database, so it refuses anything else: a
// hosted URL, a SQLite file, a PGlite directory outside this repository's `data/`, and one a
// running server still holds.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  dropLocalDatabase,
  isLocalPostgresUrl,
} from "./lib/local-postgres.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const url = process.env.DATABASE_URL || "pglite:./data/pglite"; // guard:allow-env-credential — checked for shape only, never logged

if (isLocalPostgresUrl(url)) {
  // A PostgreSQL on this machine: drop the database; `db:migrate` below recreates it.
  await dropLocalDatabase(url);
  console.log(`dropped database ${new URL(url).pathname.slice(1)}`);
} else if (url.startsWith("pglite:")) {
  removePgliteDirectory(url.slice("pglite:".length));
} else {
  console.error(
    `db:reset: DATABASE_URL is not a database on this machine (${url.split(":")[0]}:). This deletes data; refusing.`,
  );
  process.exit(1);
}

/**
 * PGlite keeps a database in a directory, which this deletes — so only one inside this
 * repository's `data/`, and never one a running server still holds.
 * @param {string} relative
 */
function removePgliteDirectory(relative) {
  const directory = path.resolve(repoRoot, relative);
  const dataRoot = path.join(repoRoot, "data");
  if (!directory.startsWith(`${dataRoot}${path.sep}`)) {
    console.error(
      `db:reset: ${path.relative(repoRoot, directory)} is not inside data/. Refusing to delete it.`,
    );
    process.exit(1);
  }
  // The framework writes `<directory>.agent-native-pglite.lock` holding the owner's pid.
  const lockPath = `${directory}.agent-native-pglite.lock`;
  if (existsSync(lockPath)) {
    let pid;
    try {
      pid = JSON.parse(readFileSync(lockPath, "utf8")).pid;
    } catch {
      pid = undefined;
    }
    let alive = false;
    try {
      if (Number.isInteger(pid)) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch (error) {
      alive = error?.code === "EPERM";
    }
    if (alive) {
      console.error(
        `db:reset: process ${pid} has the database open. Stop the dev server first.`,
      );
      process.exit(1);
    }
  }
  for (const target of [directory, lockPath]) {
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    console.log(`removed ${path.relative(repoRoot, target)}`);
  }
}

/** @param {string} script a `package.json` script name */
function runScript(script) {
  const result = spawnSync("pnpm", ["run", script], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`db:reset: pnpm run ${script} failed to start`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `db:reset: pnpm run ${script} exited with ${result.status ?? result.signal}`,
    );
    process.exit(1);
  }
}

runScript("db:migrate");
