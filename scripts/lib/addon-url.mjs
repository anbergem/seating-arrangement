#!/usr/bin/env node
// Resolves a Clever Cloud PostgreSQL add-on's connection string, without printing it (T28).
//
// CI has to migrate and seed a deployed environment, which means it needs the connection
// string — and the one thing it must not do is put that string in a log, a command line or
// a GitHub variable. So nothing returns it to the shell: the callers that need it
// (`scripts/migrate.mjs`, `scripts/seed.mjs`) ask for it here and use it in-process.
//
// Authentication is the CLI's own: `clever login` locally, `CLEVER_TOKEN` / `CLEVER_SECRET`
// in CI. No credential passes through this module.

import { spawnSync } from "node:child_process";

/** @param {string[]} args */
function clever(args) {
  const result = spawnSync("npx", ["--yes", "clever-tools@latest", ...args], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(
      `could not run the Clever Cloud CLI: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `clever ${args[0]} failed (${result.status}): ${(result.stderr ?? "").trim()}`,
    );
  }
  return result.stdout ?? "";
}

/**
 * The connection string out of `clever addon env <id> --format json`, in either shape.
 *
 * clever-tools 4.x printed a list of `{ name, value }` pairs; 5.x prints one object keyed by
 * variable name. Reading only the list made every caller — `bootstrap-org`, and the
 * migration and seed the deploy workflow runs — report an add-on with no connection string,
 * against an add-on that had one (DISCREPANCIES.md, 2026-09-25).
 * @param {unknown} variables
 * @returns {string | undefined}
 */
export function connectionStringFrom(variables) {
  const uri = Array.isArray(variables)
    ? variables.find((entry) => entry?.name === "POSTGRESQL_ADDON_URI")?.value
    : /** @type {Record<string, unknown> | null} */ (variables)?.[
        "POSTGRESQL_ADDON_URI"
      ];
  return typeof uri === "string" && uri.startsWith("postgres")
    ? uri
    : undefined;
}

/** @param {string} what @param {string} stdout */
function parseJson(what, stdout) {
  // `clever` exits 0 and prints usage for an option it does not know, so a parse failure
  // here means the CLI's flags moved, not that the data is empty.
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `\`clever ${what}\` printed no JSON: ${stdout.split("\n")[0]?.trim() ?? ""}`,
    );
  }
}

/**
 * @param {string} addonName the add-on's name, e.g. `example-jobs-staging-db`
 * @returns {string} a `postgresql://` URL
 */
export function addonDatabaseUrl(addonName) {
  // `clever addon env` takes an id, not a name, so the name is resolved first. Doing it in
  // two steps rather than asking the caller for an id keeps the workflow readable: the name
  // is derived from the application name and needs no separate GitHub variable.
  const listed = parseJson(
    "addon list",
    clever(["addon", "list", "--format", "json"]),
  );
  const addon = (Array.isArray(listed) ? listed : []).find(
    (entry) => entry?.name === addonName,
  );
  const addonId = addon?.realId ?? addon?.id ?? addon?.addonId;
  if (!addonId) {
    throw new Error(
      `no add-on named "${addonName}". Run \`node scripts/bootstrap.mjs --yes --only postgres\` first.`,
    );
  }
  const uri = connectionStringFrom(
    parseJson(
      "addon env",
      clever(["addon", "env", addonId, "--format", "json"]),
    ),
  );
  if (!uri) {
    throw new Error(`add-on "${addonName}" reported no POSTGRESQL_ADDON_URI`);
  }
  return uri;
}
