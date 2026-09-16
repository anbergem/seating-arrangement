#!/usr/bin/env node
// Loads the deterministic scenario (blueprint B12) into one of the three databases this
// repository can talk to, and creates the seed user accounts over HTTP.
//
// Two halves, in this order, because the second depends on the first: the scenario rows go in
// by SQL, then the users are registered. The framework resolves a user's active organization
// from `org_members` (F6), so a user registered *before* its membership row exists would be
// answered by `GET /_agent-native/org/me` with no organization until the next sign-in.
//
// Where the SQL comes from: `tests/fixtures/scenario.ts` is the single definition of the
// scenario (B12 makes the file and the blueprint table two forms of the same thing), and it is
// TypeScript, while this script is plain ESM so it runs under `node` with no build step. Rather
// than keep a second copy of the rows here, it spawns `pnpm exec tsx
// tests/fixtures/scenario-sql.ts` and reads one line of JSON back — statements, the reset
// statements, the user list and the default password. A child process, not a programmatic
// `tsx` import, so this file needs no loader hook and stays runnable by hand.
//
// Safety: `--env production` and any base URL containing "production" are refused outright, and
// the `node` target refuses a `DATABASE_URL` that is not a local `file:` (B13, D16). No seed
// ever reaches a production resource (AGENTS.md).
//
// Idempotent: every scenario statement is `INSERT OR IGNORE`, and a user that already exists is
// verified with a login instead of a second registration. A second run changes nothing.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createClient } from "@libsql/client";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Worker and database base name (decision D18). Local D1 is always
 * `example-jobs-local`; a remote environment's database is `example-jobs-<env>`. */
const BASE_NAME = "example-jobs";

const TARGETS = ["node", "d1-local", "d1-remote"];

const DEFAULT_BASE_URL = {
  node: "http://localhost:8080",
  "d1-local": "http://127.0.0.1:8787",
};

const USAGE = `usage: node scripts/seed.mjs --target node|d1-local|d1-remote
                          [--env <wrangler env>] [--base-url <url>] [--reset] [--skip-users]`;

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`seed: ${message}`);
  process.exit(1);
}

/** @param {string} message */
function step(message) {
  console.log(`seed: ${message}`);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

let parsed;
try {
  parsed = parseArgs({
    options: {
      target: { type: "string" },
      env: { type: "string" },
      "base-url": { type: "string" },
      reset: { type: "boolean", default: false },
      "skip-users": { type: "boolean", default: false },
    },
  });
} catch (error) {
  fail(`${error instanceof Error ? error.message : error}\n${USAGE}`);
}

const target = parsed.values.target;
const wranglerEnv = parsed.values.env;
const reset = parsed.values.reset === true;
const skipUsers = parsed.values["skip-users"] === true;

if (target === undefined || !TARGETS.includes(target)) {
  fail(`--target must be one of ${TARGETS.join(", ")}\n${USAGE}`);
}

// The two refusals come before anything else, so no argument combination can reach a write.
// The base-url check is a substring match on purpose: it catches a host name that merely
// contains "production" as well as the exact production host, and a false positive is a
// renamed flag, not lost data.
if (wranglerEnv === "production") {
  fail(
    "refusing to seed --env production. Production data is never seeded (AGENTS.md).",
  );
}

const baseUrl = (
  parsed.values["base-url"] ??
  DEFAULT_BASE_URL[target] ??
  ""
).replace(/\/+$/, "");

if (baseUrl.toLowerCase().includes("production")) {
  fail(
    'refusing a --base-url containing "production". Production data is never seeded (AGENTS.md).',
  );
}

if (target === "d1-remote") {
  if (wranglerEnv === undefined) {
    fail(`--env is required for --target d1-remote\n${USAGE}`);
  }
  if (baseUrl === "" && !skipUsers) {
    fail(
      `--base-url is required for --target d1-remote (or pass --skip-users to write rows only)\n${USAGE}`,
    );
  }
} else if (wranglerEnv !== undefined) {
  // Silently ignoring it would let someone believe they had seeded a remote environment.
  fail(`--env applies to --target d1-remote only (got --target ${target})`);
}

const databaseName =
  target === "d1-remote" ? `${BASE_NAME}-${wranglerEnv}` : `${BASE_NAME}-local`;

// ---------------------------------------------------------------------------
// The scenario, from the TypeScript fixture
// ---------------------------------------------------------------------------

/**
 * @returns {{ scenarioSql: string[], resetSql: string[], defaultPassword: string,
 *             users: { email: string, orgId: string, role: string }[] }}
 */
function loadScenario() {
  const printer = spawnSync(
    "pnpm",
    ["exec", "tsx", "tests/fixtures/scenario-sql.ts"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (printer.error) {
    fail(`could not run tsx: ${printer.error.message}`);
  }
  if (printer.status !== 0) {
    fail(
      `tests/fixtures/scenario-sql.ts exited with ${printer.status ?? printer.signal}\n${printer.stderr ?? ""}`,
    );
  }
  // The printer writes exactly one line of JSON; taking the last non-empty line keeps a
  // package-manager notice on stdout from breaking the parse.
  const line = printer.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .at(-1);
  try {
    return JSON.parse(line ?? "");
  } catch (error) {
    fail(
      `could not parse the scenario JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Target: node (the local SQLite file `pnpm dev` uses)
// ---------------------------------------------------------------------------

/**
 * `file:./data/app.db` (the framework's own default spelling) is not a valid file URL, so only
 * the `file://` form goes through `fileURLToPath`. Same helper as `scripts/migrate-local.mjs`.
 * @param {string} databaseUrl
 * @returns {string}
 */
function databaseFilePath(databaseUrl) {
  const raw = databaseUrl.startsWith("file://")
    ? fileURLToPath(databaseUrl)
    : databaseUrl.slice("file:".length);
  return path.resolve(repoRoot, raw);
}

/**
 * `organizations` and `org_members` are framework-owned (F6) and are created by the
 * framework's own migration runner during the first request that touches the database (F10) —
 * not by `migrations/`, which this repository owns. A database that has been reset but never
 * served a request therefore has the application tables and not those two, and the driver's
 * message ("no such table: organizations") does not say why. This turns it into the one
 * instruction that fixes it. See DISCREPANCIES, 2026-09-06 T11.
 *
 * @param {string} output combined stdout/stderr, or an error message
 * @returns {string} a hint to append to the failure, or an empty string
 */
function missingOrgTableHint(output) {
  if (!/no such table:\s*(organizations|org_members)/i.test(output)) return "";
  return `\nThe framework creates \`organizations\` and \`org_members\` itself, during the first request that touches the database (F10). Start the server once and let it answer \`/_agent-native/ping\`, then seed:\n  --target node      \`pnpm dev\`, then \`pnpm db:seed\`\n  --target d1-local  \`pnpm dev:worker\`, then \`pnpm db:seed:worker\``;
}

/**
 * @param {string[]} statements
 * @returns {Promise<string>} a description of what was written, for the step line
 */
async function executeOnNodeDatabase(statements) {
  const url = process.env.DATABASE_URL ?? "file:./data/app.db";
  if (!url.startsWith("file:")) {
    // The same guard `scripts/migrate-local.mjs` carries: this target is the local SQLite
    // file, and a shared database is never seeded from a laptop.
    fail(
      `DATABASE_URL must start with "file:" for --target node (got "${url}")`,
    );
  }
  const databasePath = databaseFilePath(url);
  const client = createClient({ url: `file:${databasePath}` });
  try {
    // Foreign keys on, so the jobs → customers reference is checked rather than silently
    // producing orphans; the statement order below satisfies it.
    await client.execute("PRAGMA foreign_keys = ON");
    // One transaction: a half-seeded database is worse than an unseeded one, and a failure
    // leaves the file exactly as it was.
    const tx = await client.transaction("write");
    try {
      for (const statement of statements) await tx.execute(statement);
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      const message = error instanceof Error ? error.message : `${error}`;
      fail(
        `${path.relative(repoRoot, databasePath)}: ${message}${missingOrgTableHint(message)}`,
      );
    }
  } finally {
    client.close();
  }
  return path.relative(repoRoot, databasePath);
}

// ---------------------------------------------------------------------------
// Target: d1-local and d1-remote (through Wrangler)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} statements
 * @returns {string} a description of what was written, for the step line
 */
function executeOnD1(statements) {
  // `wrangler d1 execute` takes a file or a --command string and nothing else, which is why
  // the statements are rendered as literals rather than bound parameters (B12).
  const directory = mkdtempSync(path.join(tmpdir(), "seed-scenario-"));
  const file = path.join(directory, "scenario.sql");
  writeFileSync(file, `${statements.join("\n")}\n`, "utf8");
  try {
    const args = ["exec", "wrangler", "d1", "execute", databaseName];
    args.push(target === "d1-remote" ? "--remote" : "--local");
    if (wranglerEnv !== undefined) args.push("--env", wranglerEnv);
    // Never prompt: this runs from `pnpm db:seed:worker` and from CI.
    args.push("--yes", "--file", file);

    const result = spawnSync("pnpm", args, { cwd: repoRoot, encoding: "utf8" });
    if (result.error) {
      fail(`could not run wrangler: ${result.error.message}`);
    }
    if (result.status !== 0) {
      // Wrangler's own output is only interesting when it fails, so it is captured rather
      // than inherited and printed here, in full.
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      fail(
        `wrangler d1 execute ${databaseName} exited with ${result.status ?? result.signal}\n${output}${missingOrgTableHint(output)}`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return databaseName;
}

/**
 * @param {string[]} statements
 * @returns {Promise<string>}
 */
async function execute(statements) {
  return target === "node"
    ? await executeOnNodeDatabase(statements)
    : executeOnD1(statements);
}

// ---------------------------------------------------------------------------
// Users, over HTTP (F6)
// ---------------------------------------------------------------------------

/**
 * A 4xx from `register` is only treated as "this account is already there" when the body says
 * so. Anything else — a password below the minimum length, a disabled sign-up policy — must
 * fail loudly rather than be retried as a login.
 * @param {string} body
 */
function mentionsExistingAccount(body) {
  return /already|exists|taken|duplicate|in use/i.test(body);
}

/**
 * @param {string} url
 * @param {{ email: string, password: string }} credentials
 */
async function postJson(url, credentials) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
  } catch (error) {
    fail(
      `${url} is unreachable (${error instanceof Error ? error.message : error}). Start the server first: \`pnpm dev\` for --target node, \`pnpm dev:worker\` for --target d1-local.`,
    );
  }
  // Capped, and never the request body: the password must not reach a log.
  const body = (await response.text()).slice(0, 200);
  return { status: response.status, ok: response.ok, body };
}

/**
 * @param {{ email: string, orgId: string, role: string }[]} users
 * @param {string} password
 */
async function registerUsers(users, password) {
  for (const user of users) {
    const registered = await postJson(
      `${baseUrl}/_agent-native/auth/register`,
      { email: user.email, password },
    );
    if (registered.ok) {
      step(`registered ${user.email} (${user.role} of ${user.orgId})`);
      continue;
    }
    if (
      registered.status >= 400 &&
      registered.status < 500 &&
      mentionsExistingAccount(registered.body)
    ) {
      const login = await postJson(`${baseUrl}/_agent-native/auth/login`, {
        email: user.email,
        password,
      });
      if (!login.ok) {
        fail(
          `${user.email} already exists but the seed password does not sign it in (login returned HTTP ${login.status}). Reset the local database (\`pnpm db:reset\`) or set SEED_PASSWORD to the password the account was created with.`,
        );
      }
      step(`${user.email} already existed, login verified`);
      continue;
    }
    fail(
      `register ${user.email} returned HTTP ${registered.status}: ${registered.body}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const scenario = loadScenario();
step(
  `target ${target}, ${scenario.scenarioSql.length} scenario statements, ${scenario.users.length} users`,
);

if (reset) {
  const written = await execute(scenario.resetSql);
  step(`reset: removed the scenario rows from ${written}`);
}

const written = await execute(scenario.scenarioSql);
step(`applied the scenario to ${written}`);

if (skipUsers) {
  step("users skipped (--skip-users)");
} else {
  // `SEED_PASSWORD` is the deployed-environment override (B13); locally the B12 default is
  // what `.env.example` and `.dev.vars.example` already name. `resolveCredential` is the
  // wrong tool here: this is a maintenance script's own environment, not a request's, so
  // there is no user or organization to resolve a credential for — and the value is the
  // password of the accounts this script is about to create, which it never logs.
  // guard:allow-env-credential — seed script's own configuration, never logged
  const password = process.env.SEED_PASSWORD ?? scenario.defaultPassword;
  await registerUsers(scenario.users, password);
}

step("done");
