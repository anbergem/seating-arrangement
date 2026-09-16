import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MIGRATION_FILES } from "../../../src/infrastructure/migrations-manifest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

// The manifest is generated (`scripts/gen-migrations-manifest.mjs`) and committed, so it can
// go stale when a migration is added without running the generator. `/api/ready` would then
// report a deployment ready against a schema it never got, which is exactly the failure the
// probe exists to catch — so the check runs on every `pnpm check`.
describe("MIGRATION_FILES", () => {
  it("equals the sorted directory listing of migrations/*.sql", () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    expect([...MIGRATION_FILES]).toEqual(onDisk);
  });
});
