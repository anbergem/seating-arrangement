/**
 * Checks the database the integration suite runs against (blueprint B18).
 *
 * `scripts/test-integration.mjs` is the sole owner of deleting, migrating and
 * seeding `data/test-integration.db`. Keeping that work out of Vitest avoids a
 * destructive second setup when the wrapper has already prepared CLI fixtures.
 *
 * `DATABASE_URL` is set here rather than in a test file because the framework
 * resolves it once, when its executor first initialises, and that happens on
 * the first `getDbExec().execute()` in the worker process — long after the
 * first `import` of `@agent-native/core/db`, but not something a test should
 * have to sequence by hand.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const TEST_DATABASE_URL = "file:./data/test-integration.db";

const databaseFile = path.join(repoRoot, "data", "test-integration.db");

export default function setup(): void {
  // guard:allow-env-mutation — test harness, before any worker starts; the framework resolves DATABASE_URL once, at first use
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  if (!existsSync(databaseFile)) {
    throw new Error(
      "integration setup: test database is absent; run pnpm test:integration",
    );
  }
}
