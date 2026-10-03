// Creating and dropping databases on a PostgreSQL server running on this machine.
//
// Local development and the browser tests run on a real PostgreSQL (the framework has been
// PostgreSQL-only since 0.177, and its production builds refuse PGlite), so the scripts that
// used to delete a SQLite file now create and drop databases instead. Everything here refuses
// a server that is not on this machine: these are destructive operations, and a hosted URL in
// the wrong variable must not reach them.

import { createDbExec } from "@agent-native/core/db";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const DATABASE_NAME = /^[A-Za-z0-9_-]{1,63}$/;

/** @param {string} url */
export function isLocalPostgresUrl(url) {
  if (!/^postgres(ql)?:\/\//.test(url)) return false;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** @param {string} url @returns {{ name: string, maintenanceUrl: string }} */
function parse(url) {
  if (!isLocalPostgresUrl(url)) {
    throw new Error(
      "refusing: not a PostgreSQL server on this machine (localhost, 127.0.0.1 or ::1)",
    );
  }
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!DATABASE_NAME.test(name)) {
    throw new Error(
      `refusing: "${name}" is not a plain database name (letters, digits, _ and -)`,
    );
  }
  parsed.pathname = "/postgres";
  return { name, maintenanceUrl: parsed.toString() };
}

/** Run one statement against the server's `postgres` maintenance database. */
async function onServer(maintenanceUrl, sql) {
  const client = await createDbExec({ url: maintenanceUrl });
  try {
    return await client.execute(sql);
  } finally {
    await client.close?.();
  }
}

/**
 * Create the database the URL names, if it does not exist yet. New databases use production's
 * collation (`en_GB.UTF-8`, the Clever Cloud add-on's) so text sorts the same way locally; a
 * server without that locale — a minimal CI container — falls back to its own default.
 * @param {string} url
 * @returns {Promise<boolean>} whether it was created
 */
export async function ensureLocalDatabase(url) {
  const { name, maintenanceUrl } = parse(url);
  const exists = await onServer(maintenanceUrl, {
    sql: "SELECT 1 FROM pg_database WHERE datname = ?",
    args: [name],
  });
  if (exists.rows.length > 0) return false;
  try {
    await onServer(
      maintenanceUrl,
      `CREATE DATABASE "${name}" TEMPLATE template0 LC_COLLATE 'en_GB.UTF-8' LC_CTYPE 'en_GB.UTF-8'`,
    );
  } catch (error) {
    if (!/locale|collation|invalid/i.test(String(error))) throw error;
    await onServer(maintenanceUrl, `CREATE DATABASE "${name}"`);
  }
  return true;
}

/**
 * Drop the database the URL names. `WITH (FORCE)` ends any session still connected to it,
 * which is a dev server or a crashed test run — never a deployed environment, since the URL
 * has already been proven local.
 * @param {string} url
 */
export async function dropLocalDatabase(url) {
  const { name, maintenanceUrl } = parse(url);
  await onServer(
    maintenanceUrl,
    `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
  );
}
