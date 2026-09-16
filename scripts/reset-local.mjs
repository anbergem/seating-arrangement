#!/usr/bin/env node
// Throws away every local database and rebuilds it from `migrations/` alone (D05).
//
// Both local runtimes are reset: the Node dev server's SQLite file under `data/`, and local
// D1, whose state lives in `.wrangler/state`. Nothing else is deleted, and nothing outside
// this repository is touched — `--local` never reaches Cloudflare.

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const targets = [
  "data/app.db",
  "data/app.db-shm",
  "data/app.db-wal",
  ".wrangler/state",
];

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

// `wrangler d1 migrations apply` reads `wrangler.jsonc`, whose `main` points into `dist/`.
if (existsSync(path.join(repoRoot, "dist"))) {
  runScript("db:migrate:worker");
} else {
  console.log(
    "db:reset: dist/ is absent, skipping local D1 — run `pnpm build:worker && pnpm db:migrate:worker`",
  );
}
