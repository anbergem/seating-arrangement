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
    run(process.execPath, ["scripts/migrate.mjs"], { inherit: true }),
    "migrate",
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

  // A write, through the CLI surface, exactly as the UI and the agent would
  // make it: same action, same use case, same audit row.
  const labelled = cli(
    "label-seat",
    {
      tableId: "tbl_head",
      seat: 3,
      label: "Katherine Johnson",
    },
    member,
  );
  expect(labelled.status === 0, `label-seat failed: ${labelled.stderr}`);
  expect(
    typeof labelled.parsed === "object" && labelled.parsed !== null,
    "label-seat printed no result object",
  );
  // `seats` is an array of objects, which the framework's `console.log(result)`
  // renders as `[Object]` at its default inspect depth, so the seat labels
  // themselves are not observable from this surface. The version bump and the
  // audit row below are: both prove the write landed, and
  // `tests/integration/seating-repositories.test.ts` is where the stored seat
  // array is asserted against the database.
  expect(
    labelled.parsed?.resource?.version === 4,
    `label-seat did not bump the version to 4: ${labelled.parsed?.resource?.version}`,
  );
  expect(
    typeof labelled.parsed?.operationId === "string",
    "label-seat did not return an operationId",
  );

  const activity = cli("list-recent-activity", { limit: 10 }, member);
  expect(
    activity.status === 0,
    `list-recent-activity failed: ${activity.stderr}`,
  );
  expect(
    Array.isArray(activity.parsed) &&
      activity.parsed.some(
        (item) =>
          item?.action === "label-seat" &&
          item?.resourceId === "tbl_head" &&
          item?.resourceType === "seating_table",
      ),
    "activity omitted the CLI label-seat operation",
  );

  // The floor plan's own rule, refused by the database rather than the caller.
  expectFailure(
    cli(
      "move-seating-table",
      { tableId: "tbl_side", gridX: 1, gridY: 0 },
      member,
    ),
    "Tables may not overlap",
    "overlapping move-seating-table",
  );

  // Organization isolation: a foreign id is NOT_FOUND, never AUTHORIZATION.
  expectFailure(
    cli("get-event", { eventId: "evt_gala" }, outsider),
    "Event not found",
    "outsider get-event",
  );
  expectFailure(
    cli("get-event", { eventId: "evt_other" }, member),
    "Event not found",
    "member get-event for another organization",
  );

  // Authorization: archiving an event is admin-only.
  expectFailure(
    cli("archive-event", { eventId: "evt_gala" }, member),
    "Role member may not events:archive",
    "member archive-event",
  );
  const archived = cli("archive-event", { eventId: "evt_gala" }, admin);
  expect(
    archived.status === 0,
    `admin archive-event failed: ${archived.stderr}`,
  );
  expect(
    archived.parsed?.resource?.status === "archived",
    "admin archive-event did not return archived",
  );

  // Undo puts it back, and is itself an operation.
  const undone = cli(
    "undo-operation",
    { operationId: archived.parsed.operationId },
    admin,
  );
  expect(undone.status === 0, `undo-operation failed: ${undone.stderr}`);
  expect(
    undone.parsed?.resource?.status === "active" &&
      undone.parsed?.resourceType === "event",
    "undo-operation did not restore the event",
  );

  // Idempotency: the same key returns the first event rather than a second one.
  const first = cli(
    "create-event",
    {
      name: "Retry Dinner",
      startsAt: "2026-12-01T18:00:00.000Z",
      idempotencyKey: "cli-parity-1",
    },
    member,
  );
  expect(first.status === 0, `create-event failed: ${first.stderr}`);
  const replayed = cli(
    "create-event",
    {
      name: "Retry Dinner",
      startsAt: "2026-12-01T18:00:00.000Z",
      idempotencyKey: "cli-parity-1",
    },
    member,
  );
  expect(
    replayed.status === 0,
    `replayed create-event failed: ${replayed.stderr}`,
  );
  expect(
    replayed.parsed?.resource?.id === first.parsed?.resource?.id &&
      replayed.parsed?.operationId === first.parsed?.operationId,
    "create-event replay did not return the original result",
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
