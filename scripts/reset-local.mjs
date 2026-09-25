#!/usr/bin/env node
// Throws away the local database and rebuilds it from `migrations/` alone (D05).
//
// One runtime now, not two: the Node server's SQLite file under `data/`. Local D1 and its
// `.wrangler/state` went with Cloudflare (T28). Nothing outside this repository is touched,
// and a remote `DATABASE_URL` is refused outright — this deletes files.

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const url = process.env.DATABASE_URL; // guard:allow-env-credential — checked for shape only, never logged
if (url && !url.startsWith("file:")) {
  console.error(
    `db:reset: DATABASE_URL is not a local file (${url.split(":")[0]}:). This deletes data; refusing.`,
  );
  process.exit(1);
}

const targets = ["data/app.db", "data/app.db-shm", "data/app.db-wal"];

for (const target of targets) {
  const absolute = path.join(repoRoot, target);
  if (!existsSync(absolute)) continue;
  rmSync(absolute, { recursive: true, force: true });
  console.log(`removed ${target}`);
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
