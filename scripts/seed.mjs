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
// it refuses any database or base URL whose name contains "production" (B13, D16). No seed
// ever reaches a production resource (AGENTS.md).
//
// Idempotent: every scenario statement is `INSERT OR IGNORE`, and a user that already exists is
// verified with a login instead of a second registration. A second run changes nothing.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createDbExec } from "@agent-native/core/db";

import { addonDatabaseUrl } from "./lib/addon-url.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const USAGE = `usage: node scripts/seed.mjs [--base-url <url>] [--reset] [--skip-users]

Writes the scenario to whatever DATABASE_URL names and registers the seed users over
HTTP against --base-url. There is one target now: Wrangler owned D1 and is gone (T28).`;

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
      "base-url": { type: "string" },
      addon: { type: "string" },
      reset: { type: "boolean", default: false },
      "skip-users": { type: "boolean", default: false },
    },
  });
} catch (error) {
  fail(`${error instanceof Error ? error.message : error}\n${USAGE}`);
}

const reset = parsed.values.reset === true;
const skipUsers = parsed.values["skip-users"] === true;

// `server/plugins/00-database-url.ts` performs this mapping for the application; a script
// is not the application, so it repeats the two reads rather than importing a plugin.
const databaseUrl = parsed.values.addon
  ? addonDatabaseUrl(parsed.values.addon)
  : process.env.DATABASE_URL || // guard:allow-env-credential — connection string, never logged
    process.env.POSTGRESQL_ADDON_URI || // guard:allow-env-credential — platform-injected, never logged
    "file:./data/app.db";

const baseUrl = (parsed.values["base-url"] ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);

// The refusals come before anything else, so no argument combination can reach a write.
// Both checks are substring matches on purpose: they catch a host or a database name that
// merely contains "production" as well as the exact one, and a false positive is a renamed
// flag, not lost data.
if (baseUrl.toLowerCase().includes("production")) {
  fail(
    'refusing a --base-url containing "production". Production data is never seeded (AGENTS.md).',
  );
}
if (databaseUrl.toLowerCase().includes("production")) {
  fail(
    'refusing a DATABASE_URL containing "production". Production data is never seeded (AGENTS.md).',
  );
}
if (baseUrl === "" && !skipUsers) {
  fail(`--base-url is required unless --skip-users is passed\n${USAGE}`);
}

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
 * the `file://` form goes through `fileURLToPath`. Same helper as `scripts/migrate.mjs`.
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
  return `\nThe framework creates \`organizations\` and \`org_members\` itself, during the first request that touches the database (F10). Start the server once and let it answer \`/_agent-native/ping\`, then seed: \`pnpm dev\` (or \`pnpm start\`), then \`pnpm db:seed\`.`;
}

/**
 * Apply the scenario through the framework's own executor, whichever dialect
 * `DATABASE_URL` names (T28). Wrangler owned D1 and is gone; there is one way to reach a
 * database now, and it is the one the application itself uses.
 *
 * @param {string[]} statements
 * @returns {Promise<string>} a description of what was written, for the step line
 */
async function execute(statements) {
  const client = await createDbExec({ url: databaseUrl });
  const label = databaseUrl.startsWith("file:")
    ? path.relative(repoRoot, databaseFilePath(databaseUrl))
    : `${new URL(databaseUrl).host.split(".")[0]} (postgres)`;
  try {
    // Foreign keys on, so the seats → tables reference is checked rather than silently
    // producing orphans; the statement order below satisfies it. PostgreSQL enforces them
    // always and has no such pragma, so this is SQLite-only housekeeping.
    if (databaseUrl.startsWith("file:")) {
      await client.execute("PRAGMA foreign_keys = ON");
    }
    if (!client.transaction) {
      fail(
        "the database exposes no interactive transaction; refusing a partial seed",
      );
    }
    // One transaction: a half-seeded database is worse than an unseeded one, and a failure
    // leaves it exactly as it was.
    await client.transaction(async (tx) => {
      for (const statement of statements) await tx.execute(statement);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    fail(`${label}: ${message}${missingOrgTableHint(message)}`);
  } finally {
    await client.close?.();
  }
  return label;
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
      `${url} is unreachable (${error instanceof Error ? error.message : error}). Start the server first: \`pnpm dev\`, or \`pnpm start\` against a built output.`,
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
  `${scenario.scenarioSql.length} scenario statements, ${scenario.users.length} users`,
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
  // what `.env.example` already names. `resolveCredential` is the
  // wrong tool here: this is a maintenance script's own environment, not a request's, so
  // there is no user or organization to resolve a credential for — and the value is the
  // password of the accounts this script is about to create, which it never logs.
  // guard:allow-env-credential — seed script's own configuration, never logged
  const password = process.env.SEED_PASSWORD ?? scenario.defaultPassword;
  await registerUsers(scenario.users, password);
}

step("done");
