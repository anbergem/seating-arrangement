import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ORG_ACME_ID, ORG_OTHER_ID } from "../fixtures/scenario";
import { SERVER_STATE_FILE } from "./server-state";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/**
 * The framework's own audit trail (F11) is not part of the application scenario
 * and `buildScenarioResetSql()` therefore leaves it alone. The end-to-end suite
 * asserts on exact audit rows, though, so rows written by the global setup's
 * smoke and by earlier tests have to go as well, or a spec's assertion depends
 * on the order the whole suite ran in. Scoped to the two scenario
 * organizations, like every other reset statement.
 */
const AUDIT_RESET_SQL = `DELETE FROM agent_audit_log WHERE org_id IN ('${ORG_ACME_ID}', '${ORG_OTHER_ID}');`;

interface ScenarioSql {
  scenarioSql: string[];
  resetSql: string[];
}
let cachedScenario: ScenarioSql | undefined;

/** The fixture builders are TypeScript, so one child process renders them once
 * per worker; the statements are deterministic (B12) and never change. */
function scenarioSql(): ScenarioSql {
  if (cachedScenario) return cachedScenario;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/scenario-sql.ts"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const lines = output.trim().split("\n").filter(Boolean);
  cachedScenario = JSON.parse(lines[lines.length - 1] ?? "") as ScenarioSql;
  return cachedScenario;
}

/** Restore deterministic organizations and application rows without touching
 * framework user/session tables. Browser sessions therefore remain real. */
export function resetScenario(): void {
  // `scripts/e2e-server.mjs` deletes this file when it stops. Reading it with
  // no explanation turned a dead server into 25 identical `ENOENT` lines naming
  // a path. Say what absence means, and where the real cause is.
  if (!existsSync(SERVER_STATE_FILE)) {
    throw new Error(
      `e2e state file is gone (${SERVER_STATE_FILE}). scripts/e2e-server.mjs removes it when it stops, so the server behind these tests is no longer running — look for "exited on its own" in the [WebServer] output above, not for a missing file.`,
    );
  }
  const { databaseFile } = JSON.parse(
    readFileSync(SERVER_STATE_FILE, "utf8"),
  ) as { databaseFile?: unknown };
  if (typeof databaseFile !== "string" || !path.isAbsolute(databaseFile)) {
    throw new Error(
      "e2e state file does not contain an absolute database path",
    );
  }
  const scenario = scenarioSql();
  const directory = mkdtempSync(
    path.join(tmpdir(), "seating-arrangement-e2e-"),
  );
  const file = path.join(directory, "scenario.sql");
  try {
    writeFileSync(
      file,
      `${[AUDIT_RESET_SQL, ...scenario.resetSql, ...scenario.scenarioSql].join("\n")}\n`,
    );
    execFileSync(
      process.execPath,
      ["scripts/lib/apply-sql.mjs", "--db", databaseFile, "--file", file],
      { cwd: repoRoot, stdio: "pipe" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
