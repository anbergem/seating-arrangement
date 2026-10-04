#!/usr/bin/env node
// Built Node server for Playwright (T28). Its database is a throwaway PostgreSQL database,
// created for this run on a server on this machine and dropped when the run ends. The
// framework's production builds refuse PGlite, and the browser suite tests that build.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  dropLocalDatabase,
  ensureLocalDatabase,
} from "./lib/local-postgres.mjs";
import { assertPortAvailable, terminateProcessGroup } from "./lib/process.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// guard:allow-env-credential — E2E_PORT selects a local test listener, never a credential.
const port = Number(process.env.E2E_PORT ?? "8787");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("E2E_PORT must be an integer from 1 to 65535");
}
const baseUrl = `http://127.0.0.1:${port}`;
// The server to create the run's database on: Homebrew's PostgreSQL locally, the CI job's
// service container in CI. Only a server on this machine is accepted (local-postgres.mjs).
const postgresServer = new URL(
  process.env.E2E_POSTGRES_URL ?? "postgres://localhost:5432/postgres", // guard:allow-env-credential — local test server, never logged
);
postgresServer.pathname = `/seating-arrangement-e2e-${process.pid}`;
const databaseUrl = postgresServer.toString();
const databaseName = postgresServer.pathname.slice(1);
// Playwright passes this path explicitly (`--state-file`) so the reset helper can reach
// this server's private database without a test-only environment variable.
const stateFileIndex = process.argv.indexOf("--state-file");
const stateFile =
  stateFileIndex < 0 ? undefined : process.argv[stateFileIndex + 1];
// The membership mode this run exercises (D32). An argument rather than an inherited
// variable, like the state file: the launcher decides exactly what the server sees.
const membershipModeIndex = process.argv.indexOf("--membership-mode");
const membershipMode =
  membershipModeIndex < 0 ? undefined : process.argv[membershipModeIndex + 1];
const required = [path.join(repoRoot, ".output", "server", "index.mjs")];

/**
 * The parent environment minus anything that looks like a credential, plus exactly the
 * settings this server needs. A developer's real `ANTHROPIC_API_KEY` or `SEED_PASSWORD`
 * has no business reaching a throwaway test database.
 */
function serverEnvironment() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(?:API|ACCESS|AUTH|OAUTH|TOKEN|SECRET|KEY)$/i.test(key),
    ),
  );
  return {
    ...environment,
    PORT: `${port}`,
    DATABASE_URL: databaseUrl,
    APP_ENV: "local",
    NODE_ENV: "production",
    APP_URL: baseUrl,
    AUTO_CREATE_DEFAULT_ORG: "0",
    AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT: "1",
    AUTH_REQUIRE_EMAIL_VERIFICATION: "0",
    SEED_ENABLED: "1",
    BETTER_AUTH_SECRET: "e2e-only-secret-32-characters-long",
    ...(membershipMode ? { MEMBERSHIP_MODE: membershipMode } : {}),
  };
}

function run(args) {
  const result = spawnSync("pnpm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: serverEnvironment(),
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(" ")} failed (${result.status ?? result.error?.message})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

async function waitFor(pathname, child) {
  let last = "unreachable";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`server exited ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}${pathname}`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server did not answer ${pathname}: ${last}`);
}

function scenarioSql() {
  const output = run([
    "exec",
    "node",
    "--import",
    "tsx",
    "tests/fixtures/scenario-sql.ts",
  ]);
  const lines = output.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? "");
}

const missing = required.filter((file) => !existsSync(file));
if (missing.length > 0) {
  throw new Error(
    `e2e-server requires a build; missing ${missing.map((file) => path.relative(repoRoot, file)).join(", ")}. Run \`pnpm build\`.`,
  );
}
if (!stateFile || !path.isAbsolute(stateFile))
  throw new Error("e2e-server requires --state-file <absolute path>");

let server;
let stopped = false;

async function cleanup() {
  try {
    await dropLocalDatabase(databaseUrl);
  } catch (error) {
    console.error(
      `e2e-server: dropping ${databaseName} failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  // The state file names paths that no longer exist once the server stops, and its absence
  // is how the global setup knows this server is not ready yet.
  rmSync(stateFile, { force: true });
}

/** Playwright stops the web server with a signal. Terminating the process group has to
 * happen even when the signal arrives during migration or seeding, or an orphan keeps the
 * selected port and the run hangs. */
async function stop() {
  if (stopped) return;
  stopped = true;
  await teardown();
  process.exit(0);
}

/** Removing the temporary state must happen even when terminating the process group
 * fails, so the failure is reported and cleanup still runs. */
async function teardown() {
  try {
    if (server) await terminateProcessGroup(server);
  } catch (error) {
    console.error(
      `e2e-server: stopping the server failed: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    await cleanup();
  }
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

try {
  // A leftover file from an earlier run must never look like this server.
  rmSync(stateFile, { force: true });
  await assertPortAvailable(port);
  // A database left by a crashed run with a recycled pid must not look like this one.
  await dropLocalDatabase(databaseUrl);
  await ensureLocalDatabase(databaseUrl);
  run(["exec", "node", "scripts/migrate.mjs"]);

  /**
   * Start the server and wait until it answers. Extracted so the supervisor below can call
   * it again: a dev-grade server occasionally exits on its own mid-run, and a run that dies
   * for that reason has nothing wrong with it that a restart does not fix.
   */
  async function startServer() {
    server = spawn("pnpm", ["start"], {
      cwd: repoRoot,
      // Piped, never inherited. Playwright's web-server teardown waits for this process's
      // own stdout and stderr to close; a descendant holding the inherited handles keeps
      // them open and hangs the whole run even after Playwright has killed this process.
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: serverEnvironment(),
    });
    server.stdout.pipe(process.stdout);
    server.stderr.pipe(process.stderr);
    await waitFor("/_agent-native/ping", server);
    await waitFor("/_agent-native/health", server);
  }

  await startServer();

  const directory = mkdtempSync(
    path.join(tmpdir(), "seating-arrangement-e2e-seed-"),
  );
  try {
    const sqlFile = path.join(directory, "scenario.sql");
    writeFileSync(sqlFile, `${scenarioSql().scenarioSql.join("\n")}\n`);
    run([
      "exec",
      "node",
      "scripts/lib/apply-sql.mjs",
      "--url",
      databaseUrl,
      "--file",
      sqlFile,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // Written last: Playwright's readiness probe is `ping`, which answers long before the
  // scenario exists, so this file is what tells the global setup and the reset fixture that
  // the database is seeded (T11: seed only after the app has touched the database).
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ databaseUrl }));
  // The server is expected to outlive the tests and to end by our own signal. When it ends
  // by itself the run used to die in the worst possible way: this process exited, `finally`
  // deleted the state file, and every remaining test failed inside `resetScenario` with
  // ENOENT on a path — saying nothing about a dead server (DISCREPANCIES.md, 2026-09-15).
  // The database file survives, so a restart resumes against the same data and Playwright's
  // CI retry gives the tests that were in flight another go.
  const MAX_RESTARTS = 3;
  let restarts = 0;
  for (;;) {
    const exit = await new Promise((resolve, reject) => {
      server.once("exit", (code, signal) => resolve({ code, signal }));
      server.once("error", reject);
    });
    if (stopped) break;
    restarts += 1;
    if (restarts > MAX_RESTARTS) {
      throw new Error(
        `the server exited on its own ${restarts} times (last: code ${exit.code}, ${exit.signal}); giving up`,
      );
    }
    console.error(
      `e2e-server: the server exited on its own (code ${exit.code}, ${exit.signal}) — restarting ${restarts}/${MAX_RESTARTS}, ${databaseName} is unaffected`,
    );
    await startServer();
  }
} catch (error) {
  console.error(
    `e2e-server: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
} finally {
  await teardown();
}
