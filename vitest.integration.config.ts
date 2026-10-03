import { defineConfig } from "vitest/config";

// Integration tests run against a real database, not a fixture: one PGlite
// (in-process PostgreSQL) directory at `data/test-integration`, built from
// `migrations/` by `scripts/test-integration.mjs` before Vitest starts.
//
// Separate from `vitest.config.ts` so `pnpm test:unit` stays hermetic and
// fast: nothing in `tests/unit` may need a database, and nothing here runs by
// accident during `pnpm check`.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: "tests/integration/global-setup.ts",
    // Every file shares the one database, so they must not interleave — and
    // PGlite locks its directory to a single process, so there must be exactly
    // one worker for the whole run.
    fileParallelism: false,
    maxWorkers: 1,
    // `globalSetup` sets this too — it needs the value before it can migrate —
    // but stating it here as well means a worker process cannot start with the
    // development database configured, whatever the pool implementation does
    // with the parent's environment.
    env: { DATABASE_URL: "pglite:./data/test-integration" },
  },
});
