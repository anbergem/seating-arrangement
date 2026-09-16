#!/usr/bin/env node
// Hermetic local Worker verification. Every Wrangler command is pinned to a temporary
// persist directory, so this never reads or writes the repository's .wrangler state.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runSmoke } from "./worker-smoke.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const USAGE = `usage: node scripts/verify-worker.mjs [--port <port>] [--keep-state] [--skip-build] [--help]

Builds and runs the Worker against a new temporary local D1 database, seeds the QA
scenario, runs the local smoke checks, stops Wrangler, and removes the database.`;

function assertBuiltWorker() {
  const required = [
    path.join(repoRoot, "dist", "index.html"),
    path.join(repoRoot, "dist", "_worker.js", "index.js"),
  ];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `--skip-build requires an existing Worker build; missing ${missing.map((file) => path.relative(repoRoot, file)).join(", ")}`,
    );
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.error?.message})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`wrangler exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/_agent-native/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Worker did not become healthy within 60 seconds");
}

/** Refuse to start if readiness could accidentally inspect a process we did not launch. */
export async function assertPortAvailable(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  }).catch((error) => {
    throw new Error(
      `127.0.0.1:${port} is already in use; refusing to test an unrelated service (${error instanceof Error ? error.message : error})`,
    );
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/** Wrangler launches workerd descendants. The child is spawned detached so its process
 * group is separate from this verifier's group; signalling -pid cannot hit the parent. */
export async function terminateProcessGroup(child, graceMs = 3_000) {
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    return;
  }

  // `child.exitCode` only describes the Wrangler launcher. workerd can still
  // be alive in its detached process group after that launcher exits, so the
  // process group is the lifecycle authority. The group id is the direct
  // child's pid, assigned when `spawn({ detached: true })` created it.
  const launcherGone = () =>
    child.exitCode !== null || child.signalCode !== null;
  const groupExists = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      // EPERM means a group with that id exists but is not signallable by us.
      // Once our launcher has exited its pid can be recycled, so the group is
      // someone else's and there is nothing of ours left to terminate. While
      // the launcher is alive, EPERM is a real failure and must surface.
      if (error?.code === "EPERM" && launcherGone()) return false;
      throw error;
    }
  };
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const waitForGroupExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (groupExists()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };

  if (!groupExists()) return;
  signalGroup("SIGTERM");
  if (await waitForGroupExit(graceMs)) return;
  signalGroup("SIGKILL");
  if (!(await waitForGroupExit(graceMs))) {
    throw new Error(`owned Worker process group ${child.pid} did not exit`);
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string", default: "8787" },
      "keep-state": { type: "boolean" },
      "skip-build": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--port must be 1..65535");
  await assertPortAvailable(port);

  const temporary = mkdtempSync(
    path.join(tmpdir(), "example-jobs-worker-smoke-"),
  );
  const persistPath = path.join(temporary, "wrangler-state");
  const configPath = path.join(temporary, "wrangler.json");
  const sqlPath = path.join(temporary, "scenario.sql");
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = {
    name: "example-jobs-smoke",
    main: path.join(repoRoot, "dist/_worker.js/index.js"),
    compatibility_date: "2026-09-05",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: path.join(repoRoot, "dist"), binding: "ASSETS" },
    observability: { enabled: true, head_sampling_rate: 1 },
    vars: {
      APP_ENV: "local",
      NODE_ENV: "production",
      APP_URL: baseUrl,
      AUTO_CREATE_DEFAULT_ORG: "0",
      AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT: "1",
      AUTH_REQUIRE_EMAIL_VERIFICATION: "0",
      SEED_ENABLED: "1",
      BETTER_AUTH_SECRET: "worker-smoke-only-secret-32-characters-long",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "example-jobs-smoke-local",
        database_id: "00000000-0000-0000-0000-000000000000",
        migrations_dir: path.join(repoRoot, "migrations"),
      },
    ],
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  let worker;
  try {
    console.log(`verify-worker: isolated state ${persistPath}`);
    if (values["skip-build"]) assertBuiltWorker();
    else run("pnpm", ["run", "build:worker"], { stdio: "inherit" });
    run("pnpm", [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "example-jobs-smoke-local",
      "--local",
      "--persist-to",
      persistPath,
      "--config",
      configPath,
    ]);
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
        persistPath,
        "--config",
        configPath,
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        // Required by terminateProcessGroup: Wrangler and workerd get a group whose id
        // is the direct child's pid, separate from the verifier and its invoking shell.
        detached: process.platform !== "win32",
      },
    );
    let workerOutput = "";
    worker.stdout.on("data", (chunk) => {
      workerOutput = (workerOutput + chunk).slice(-8_000);
    });
    worker.stderr.on("data", (chunk) => {
      workerOutput = (workerOutput + chunk).slice(-8_000);
    });
    await waitForHealth(baseUrl, worker).catch((error) => {
      throw new Error(`${error.message}\n${workerOutput}`);
    });

    // Health must run first: it creates framework-owned organizations and org_members tables.
    const scenarioLine = run("pnpm", [
      "exec",
      "tsx",
      "tests/fixtures/scenario-sql.ts",
    ])
      .trim()
      .split("\n")
      .filter(Boolean)
      .at(-1);
    const scenario = JSON.parse(scenarioLine);
    writeFileSync(sqlPath, `${scenario.scenarioSql.join("\n")}\n`);
    run("pnpm", [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "example-jobs-smoke-local",
      "--local",
      "--persist-to",
      persistPath,
      "--config",
      configPath,
      "--yes",
      "--file",
      sqlPath,
    ]);
    for (const user of scenario.users) {
      const response = await fetch(`${baseUrl}/_agent-native/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({
          email: user.email,
          password: scenario.defaultPassword,
        }),
      });
      if (!response.ok)
        throw new Error(
          `register ${user.email}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
        );
    }
    const status = await runSmoke({
      baseUrl,
      mode: "local",
      qaEmail: "owner@example.invalid",
      qaPassword: scenario.defaultPassword,
      expectOrgId: "org_acme",
      runId: "hermetic",
      timeoutMs: 120_000,
    });
    return status;
  } finally {
    if (worker) await terminateProcessGroup(worker);
    // Process-group exit is awaited before state removal, so workerd cannot race cleanup.
    if (values["keep-state"]) console.log(`verify-worker: kept ${temporary}`);
    else rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      `verify-worker: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}
