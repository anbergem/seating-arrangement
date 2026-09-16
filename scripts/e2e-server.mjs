#!/usr/bin/env node
// Built Worker server for Playwright. Its D1 directory is freshly created in
// tmp and is never a caller-selected deletion target.

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
  assertPortAvailable,
  terminateProcessGroup,
} from "./verify-worker.mjs";

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
const temporary = mkdtempSync(path.join(tmpdir(), "example-jobs-e2e-"));
const persistTo = path.join(temporary, "wrangler-state");
const configFile = path.join(temporary, "wrangler.json");
// Playwright passes this path explicitly (`--state-file`) so the reset helper
// can reach this server's private D1 directory without a test-only environment
// variable.
const stateFileIndex = process.argv.indexOf("--state-file");
const stateFile =
  stateFileIndex < 0 ? undefined : process.argv[stateFileIndex + 1];
const required = [
  path.join(repoRoot, "dist", "index.html"),
  path.join(repoRoot, "dist", "_worker.js", "index.js"),
];

function safeEnvironment() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(?:API|ACCESS|AUTH|OAUTH|TOKEN|SECRET|KEY)$/i.test(key),
    ),
  );
  // The generated config lives in our private temp directory. This also
  // prevents Wrangler's fallback .env lookup if that directory has no
  // .dev.vars file.
  environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  return environment;
}

function run(args) {
  const result = spawnSync("pnpm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: safeEnvironment(),
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(" ")} failed (${result.status ?? result.error?.message})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

async function waitFor(pathname, worker) {
  let last = "unreachable";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (worker.exitCode !== null)
      throw new Error(`wrangler exited ${worker.exitCode}`);
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
  throw new Error(`Worker did not answer ${pathname}: ${last}`);
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
    `e2e-server requires a built Worker; missing ${missing.map((file) => path.relative(repoRoot, file)).join(", ")}`,
  );
}
if (!stateFile || !path.isAbsolute(stateFile))
  throw new Error("e2e-server requires --state-file <absolute path>");

let worker;
let stopped = false;

function cleanup() {
  rmSync(temporary, { recursive: true, force: true });
  // The state file names paths that no longer exist once the server stops, and
  // its absence is how the global setup knows this server is not ready yet.
  rmSync(stateFile, { force: true });
}

/** Playwright stops the web server with a signal. Terminating the Wrangler
 * process group has to happen even when the signal arrives during migration or
 * seeding, or an orphaned workerd keeps the selected port and the run hangs. */
async function stop() {
  if (stopped) return;
  stopped = true;
  await teardown();
  process.exit(0);
}

/** Removing the temporary state must happen even when terminating the process
 * group fails, so the failure is reported and cleanup still runs. */
async function teardown() {
  try {
    if (worker) await terminateProcessGroup(worker);
  } catch (error) {
    console.error(
      `e2e-server: stopping Wrangler failed: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    cleanup();
  }
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

try {
  // A leftover file from an earlier run must never look like this server.
  rmSync(stateFile, { force: true });
  await assertPortAvailable(port);
  const config = {
    name: "example-jobs-e2e",
    main: path.join(repoRoot, "dist/_worker.js/index.js"),
    compatibility_date: "2026-09-05",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: path.join(repoRoot, "dist"), binding: "ASSETS" },
    vars: {
      APP_ENV: "local",
      NODE_ENV: "production",
      APP_URL: baseUrl,
      AUTO_CREATE_DEFAULT_ORG: "0",
      AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT: "1",
      AUTH_REQUIRE_EMAIL_VERIFICATION: "0",
      SEED_ENABLED: "1",
      BETTER_AUTH_SECRET: "e2e-only-secret-32-characters-long",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "example-jobs-local",
        database_id: "00000000-0000-0000-0000-000000000000",
        migrations_dir: path.join(repoRoot, "migrations"),
      },
    ],
  };
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  run([
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "example-jobs-local",
    "--local",
    "--persist-to",
    persistTo,
    "--config",
    configFile,
  ]);
  /**
   * Start Wrangler and wait until it answers. Extracted so the supervisor
   * below can call it again: `wrangler dev` sometimes exits on its own
   * mid-run (observed as `code 1` after workerd logs a broken-pipe write on a
   * request the browser aborted), and a run that dies for that reason has
   * nothing wrong with it that a restart does not fix.
   */
  async function startWorker() {
    worker = spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        `${port}`,
        "--persist-to",
        persistTo,
        "--config",
        configFile,
      ],
      {
        cwd: repoRoot,
        // Piped, never inherited. Playwright's web-server teardown waits for this
        // process's own stdout and stderr to close; a Wrangler descendant holding
        // the inherited handles keeps them open and hangs the whole run even after
        // Playwright has killed this process. Piping gives Wrangler handles that
        // die with it, and its output is forwarded below so failures stay visible.
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: safeEnvironment(),
      },
    );
    worker.stdout.pipe(process.stdout);
    worker.stderr.pipe(process.stderr);
    await waitFor("/_agent-native/ping", worker);
    await waitFor("/_agent-native/health", worker);
  }

  await startWorker();

  const directory = mkdtempSync(path.join(tmpdir(), "example-jobs-e2e-seed-"));
  try {
    const sqlFile = path.join(directory, "scenario.sql");
    writeFileSync(sqlFile, `${scenarioSql().scenarioSql.join("\n")}\n`);
    run([
      "exec",
      "wrangler",
      "d1",
      "execute",
      "example-jobs-local",
      "--local",
      "--persist-to",
      persistTo,
      "--config",
      configFile,
      "--yes",
      "--file",
      sqlFile,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // Written last: Playwright's readiness probe is `ping`, which answers long
  // before the scenario exists, so this file is what tells the global setup and
  // the reset fixture that the database is seeded (T11: seed only after the app
  // has touched the database).
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ configFile, persistTo }));
  // Wrangler is expected to outlive the tests and to end by our own signal.
  // When it ends by itself the run used to die in the worst possible way: this
  // process exited, `finally` deleted the state file, and every remaining test
  // failed inside `resetScenario` with ENOENT on a path — saying nothing about
  // a dead server (DISCREPANCIES.md, 2026-09-15). The database lives in
  // `persistTo` and survives, so a restart resumes against the same data and
  // Playwright's CI retry gives the tests that were in flight another go.
  const MAX_RESTARTS = 3;
  let restarts = 0;
  for (;;) {
    const exit = await new Promise((resolve, reject) => {
      worker.once("exit", (code, signal) => resolve({ code, signal }));
      worker.once("error", reject);
    });
    if (stopped) break;
    restarts += 1;
    if (restarts > MAX_RESTARTS) {
      throw new Error(
        `wrangler dev exited on its own ${restarts} times (last: code ${exit.code}, ${exit.signal}); giving up`,
      );
    }
    console.error(
      `e2e-server: wrangler dev exited on its own (code ${exit.code}, ${exit.signal}) — restarting ${restarts}/${MAX_RESTARTS}, database in ${persistTo} is unaffected`,
    );
    await startWorker();
  }
} catch (error) {
  console.error(
    `e2e-server: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
} finally {
  await teardown();
}
