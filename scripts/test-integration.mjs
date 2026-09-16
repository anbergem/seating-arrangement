#!/usr/bin/env node
// Runs the hermetic integration and CLI parity checks (blueprint B18).
// This script alone owns the test database lifecycle. Vitest only checks that
// the prepared database exists, so it cannot erase CLI fixtures mid-run.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const databaseUrl = "file:./data/test-integration.db";
const databaseFile = path.join(repoRoot, "data", "test-integration.db");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl, ...options.env },
  });
  if (options.inherit) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  if (result.error)
    throw new Error(`Could not start ${command}: ${result.error.message}`);
  return result;
}

function assertSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(
      `${label} exited with ${result.status ?? result.signal}\n${result.stderr ?? ""}`,
    );
  }
}

function initialiseDatabase() {
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(`${databaseFile}${suffix}`, { force: true });
  assertSuccess(
    run(process.execPath, ["scripts/migrate-local.mjs"], { inherit: true }),
    "migrate-local",
  );
  assertSuccess(
    run(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/seed-sql-only.ts"],
      {
        inherit: true,
      },
    ),
    "seed-sql-only",
  );
}

/**
 * The framework calls console.log(result), rather than JSON.stringify(result),
 * and application logs can precede that output. Extract balanced object
 * literals and accept the last parseable object: the action result printed by
 * the verified @agent-native/core scripts runner. The child is our local app;
 * the parser still uses an empty VM and rejects non-object values.
 */
function printedValues(stdout) {
  const values = [];
  for (let start = 0; start < stdout.length; start += 1) {
    const opener = stdout[start];
    // Node's inspect output starts its top-level value at column zero. Do not
    // treat nested `resource: { ... }` values as a later action result.
    if (
      (opener !== "{" && opener !== "[") ||
      (start !== 0 && stdout[start - 1] !== "\n")
    ) {
      continue;
    }
    const closers = [];
    let quote = null;
    let escaped = false;
    for (let end = start; end < stdout.length; end += 1) {
      const char = stdout[end];
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") closers.push("}");
      else if (char === "[") closers.push("]");
      else if (char !== closers.at(-1)) continue;
      else closers.pop();
      if (closers.length !== 0) continue;
      try {
        const value = vm.runInNewContext(
          `(${stdout.slice(start, end + 1)})`,
          Object.create(null),
          { timeout: 100 },
        );
        if (value && typeof value === "object") values.push(value);
      } catch {
        // A log fragment or an incomplete nested object; keep scanning.
      }
      break;
    }
  }
  return values;
}

function cli(action, args, identity) {
  const result = run("pnpm", ["action", action, JSON.stringify(args)], {
    env: {
      AGENT_USER_EMAIL: identity.email,
      AGENT_ORG_ID: identity.orgId,
      AGENT_NATIVE_NO_OPEN: "1",
    },
  });
  const stdout = result.stdout ?? "";
  return {
    ...result,
    stdout,
    stderr: result.stderr ?? "",
    parsed: printedValues(stdout).at(-1),
  };
}

function expect(condition, message) {
  if (!condition) throw new Error(`CLI parity: ${message}`);
}

function expectFailure(result, message, label) {
  expect(result.status !== 0, `${label} unexpectedly succeeded`);
  expect(
    result.stderr.includes(message),
    `${label} stderr did not include ${message}: ${result.stderr}`,
  );
}

function runCliParity() {
  const member = { email: "member1@example.invalid", orgId: "org_acme" };
  const admin = { email: "admin@example.invalid", orgId: "org_acme" };
  const outsider = { email: "outsider@example.invalid", orgId: "org_other" };

  const completed = cli("complete-job", { jobId: "job_in_progress" }, member);
  expect(completed.status === 0, `complete-job failed: ${completed.stderr}`);
  expect(
    completed.parsed !== undefined,
    "complete-job printed no result object",
  );
  expect(
    completed.parsed.resource?.status === "completed",
    "complete-job did not return a completed resource",
  );
  expect(
    completed.parsed.resource?.version === 3,
    "complete-job did not return version 3",
  );
  expect(
    typeof completed.parsed.operationId === "string",
    "complete-job did not return an operationId",
  );

  const history = cli("list-recent-activity", {}, member);
  expect(
    history.status === 0,
    `list-recent-activity failed: ${history.stderr}`,
  );
  expect(
    Array.isArray(history.parsed),
    "activity did not print an array result",
  );
  expect(
    history.parsed.find(
      (item) =>
        item?.id === completed.parsed.operationId &&
        item?.action === "complete-job" &&
        item?.performedVia === "cli",
    ) !== undefined,
    "activity omitted the CLI complete-job operation",
  );

  const undone = cli(
    "undo-operation",
    { operationId: completed.parsed.operationId },
    member,
  );
  expect(undone.status === 0, `undo-operation failed: ${undone.stderr}`);
  expect(
    undone.parsed?.resource?.status === "in_progress",
    "undo-operation did not restore in_progress",
  );

  expectFailure(
    cli("get-job", { jobId: "job_scheduled" }, outsider),
    "Job not found",
    "outsider get-job",
  );
  expectFailure(
    cli(
      "get-job",
      { jobId: "job_scheduled" },
      { email: member.email, orgId: "org_other" },
    ),
    "Not a member of the active organization",
    "member claiming org_other",
  );
  expectFailure(
    cli("archive-customer", { customerId: "cus_b" }, member),
    "Role member may not customers:archive",
    "member archive-customer",
  );
  const archived = cli("archive-customer", { customerId: "cus_b" }, admin);
  expect(
    archived.status === 0,
    `admin archive-customer failed: ${archived.stderr}`,
  );
  expect(
    archived.parsed?.resource?.status === "archived",
    "admin archive-customer did not return archived",
  );

  expectFailure(
    cli("send-job-to-accounting", { jobId: "job_completed" }, member),
    "Role member may not jobs:export",
    "member send-job-to-accounting",
  );
  const exported = cli(
    "send-job-to-accounting",
    { jobId: "job_completed" },
    admin,
  );
  expect(
    exported.status === 0,
    `admin send-job-to-accounting failed: ${exported.stderr}`,
  );
  expect(
    typeof exported.parsed?.externalReference === "string",
    "admin send-job-to-accounting did not return an external reference",
  );
  expect(
    exported.parsed?.resource?.accountingReference ===
      exported.parsed.externalReference &&
      typeof exported.parsed.resource?.accountingSentAt === "string",
    "admin send-job-to-accounting did not persist its accounting reference",
  );
  const replayed = cli(
    "send-job-to-accounting",
    { jobId: "job_completed" },
    admin,
  );
  expect(
    replayed.status === 0,
    `replayed send-job-to-accounting failed: ${replayed.stderr}`,
  );
  expect(
    replayed.parsed?.externalReference === exported.parsed.externalReference &&
      replayed.parsed?.operationId === exported.parsed.operationId &&
      replayed.parsed?.resource?.version ===
        exported.parsed.resource?.version &&
      replayed.parsed?.resource?.accountingReference ===
        exported.parsed.externalReference,
    "send-job-to-accounting replay did not return the original result",
  );
}

try {
  initialiseDatabase();
  assertSuccess(
    run(
      "pnpm",
      ["exec", "vitest", "--run", "--config", "vitest.integration.config.ts"],
      { inherit: true },
    ),
    "vitest integration",
  );
  // Tests intentionally mutate scenario rows; restore exact CLI starting state.
  initialiseDatabase();
  runCliParity();
  console.log("integration and CLI parity checks passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
