import { defineConfig } from "vitest/config";

// Integration tests run against a real database file, not a fixture: one
// SQLite file at `data/test-integration.db`, built from `migrations/` by
// `tests/integration/global-setup.ts` before any test file loads.
//
// Separate from `vitest.config.ts` so `pnpm test:unit` stays hermetic and
// fast: nothing in `tests/unit` may need a database, and nothing here runs by
// accident during `pnpm check`.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: "tests/integration/global-setup.ts",
    // Every file shares the one database file, so they must not interleave.
    fileParallelism: false,
    // `globalSetup` sets this too — it needs the value before it can migrate —
    // but stating it here as well means a worker process cannot start with the
    // development database configured, whatever the pool implementation does
    // with the parent's environment.
    env: { DATABASE_URL: "file:./data/test-integration.db" },
  },
});
