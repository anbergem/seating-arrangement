import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("restore check imports into scratch state and reports actual table counts", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const temporary = mkdtempSync(path.join(tmpdir(), "restore-check-test-"));
  try {
    const backup = path.join(temporary, "fixture.sql");
    const report = path.join(temporary, "report.log");
    writeFileSync(
      backup,
      [
        "CREATE TABLE customers (id TEXT PRIMARY KEY);",
        "CREATE TABLE jobs (id TEXT PRIMARY KEY);",
        "CREATE TABLE operations (id TEXT PRIMARY KEY);",
        "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);",
        "INSERT INTO customers VALUES ('customer-1');",
        "INSERT INTO jobs VALUES ('job-1');",
        "INSERT INTO operations VALUES ('operation-1');",
        "INSERT INTO d1_migrations VALUES (1, '0001_init.sql');",
      ].join("\n"),
    );
    const output = execFileSync(
      "bash",
      ["scripts/restore-d1-check.sh", backup],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, RESTORE_REPORT: report },
      },
    );
    for (const table of ["customers", "jobs", "operations", "d1_migrations"])
      assert.match(output, new RegExp(`Count: ${table}`));
    const restoredOnes = output.match(/row_count[^\n]*1/g) ?? [];
    assert.equal(restoredOnes.length, 4);
    assert.match(readFileSync(report, "utf8"), /Count: customers/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
