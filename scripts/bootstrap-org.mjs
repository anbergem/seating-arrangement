#!/usr/bin/env node
// Creates the first organization and its owner membership on a deployed environment
// (docs/bootstrap.md step 13, decision D28).
//
// Why this exists: `AUTO_CREATE_DEFAULT_ORG=0` in every environment (D11), so the first
// person to sign in with Google has an account and no organization, and every action then
// fails with `AUTHORIZATION: No active organization`. Membership is invite-only, so there is
// nobody to invite them — somebody has to write the first two rows.
//
// The two tables are framework-owned (F6) and are created by the framework's own migration
// runner during the first request that touches the database, so this script only ever runs
// *after* the environment has served a request. It writes every NOT NULL column those
// migrations declare (`node_modules/@agent-native/core/dist/org/migrations.js` versions 1001
// and 1002): `organizations(id, name, created_by, created_at)` and
// `org_members(id, org_id, email, role, joined_at)`, with epoch-millisecond timestamps.
//
// Nullable columns are left NULL on purpose. `a2a_secret` is the per-organization cross-app
// delegation secret, and this starter configures no A2A surface (D24); `allowed_domain` stays
// empty because membership is invite-only; `required_auth_provider` is set from the Team page
// in the next bootstrap step, not here.
//
// The framework's own `POST /_agent-native/org` does the same thing from a browser session
// and additionally records the caller's `active-org-id` user setting. That setting is not
// needed here: with one membership the framework resolves the active organization from the
// membership itself (F6). Use this script when there is no browser session to use — which is
// exactly the state a freshly deployed environment is in.
//
// Idempotent: the organization id is derived from its name, so a second run inserts nothing.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseJsonc } from "./lib/jsonc.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const ENVIRONMENTS = ["staging", "production"];

const USAGE = `Usage: node scripts/bootstrap-org.mjs --env <staging|production> --name "<Org>" --owner <email>

  --env <name>      Wrangler environment to write to. Required; there is no default, because
                    the default would be production for somebody.
  --name "<Org>"    Organization display name. Its id is derived from it, so re-running with
                    the same name changes nothing.
  --owner <email>   Email of the person who signed in first. Becomes the organization owner.
  --id <id>         Override the derived organization id.
  --dry-run         Print the exact command and SQL, run nothing.
  --help            This text.

Both tables are created by the framework during the first request that touches the database,
so deploy and open the app once before running this. See docs/bootstrap.md.`;

/** @param {string} message */
function refuse(message) {
  console.error(`bootstrap-org: ${message}`);
  process.exit(1);
}

/**
 * `wrangler d1 execute --command` takes SQL text and no bound parameters, so the two values
 * that reach the SQL are validated to a shape that cannot carry syntax and then quoted.
 *
 * `;` is rejected rather than escaped: Wrangler splits a multi-statement `--command` on
 * semicolons, so one inside a string literal would still cut the statement in half. A single
 * quote is allowed (`O'Brien Services` is a real company name) and doubled, which is the SQL
 * standard escape inside a literal.
 * @param {string} value
 */
function sqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/** @param {string} name */
function deriveOrgId(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (slug === "") refuse("--name must contain at least one letter or digit");
  return `org_${slug}`;
}

/**
 * Resolves an executable through PATH, then the repository's own `node_modules/.bin`, so the
 * guard test can put a stub in front of the real Wrangler.
 * @param {string} name
 */
function executable(name) {
  // guard:allow-env-credential — PATH, the shell's executable search list, never a credential
  const searchPath = process.env.PATH ?? "";
  for (const entry of searchPath.split(path.delimiter)) {
    if (entry === "") continue;
    const candidate = path.join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  const local = path.join(repoRoot, "node_modules", ".bin", name);
  if (existsSync(local)) return local;
  return refuse(
    `\`${name}\` not found on PATH or in node_modules/.bin. Run \`pnpm install\`.`,
  );
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        env: { type: "string" },
        name: { type: "string" },
        owner: { type: "string" },
        id: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    console.error(USAGE);
    process.exit(2);
  }
  const { values } = parsed;

  // `--help` prints usage and exits 0 without reading a config file or spawning anything.
  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (values.env === undefined) {
    console.error("bootstrap-org: --env is required (staging or production)");
    console.error(USAGE);
    process.exit(1);
  }
  if (!ENVIRONMENTS.includes(values.env)) {
    refuse(
      `--env must be one of ${ENVIRONMENTS.join(", ")} (got "${values.env}")`,
    );
  }
  const name = (values.name ?? "").trim();
  const owner = (values.owner ?? "").trim();
  // No control character (a newline would split the statement the same way `;` does) and no
  // `;`. Checked with an explicit code-point scan rather than a control-character regex,
  // which oxlint's `no-control-regex` rule rightly refuses.
  const nameIsPrintable =
    name.length >= 1 &&
    name.length <= 200 &&
    !name.includes(";") &&
    [...name].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    });
  if (!nameIsPrintable) {
    refuse('--name must be 1-200 printable characters and contain no ";"');
  }
  if (!/^[^\s@;'"]+@[^\s@;'"]+\.[^\s@;'"]+$/.test(owner)) {
    refuse("--owner must be a plain email address");
  }

  const wranglerPath = path.join(repoRoot, "wrangler.jsonc");
  if (!existsSync(wranglerPath)) refuse("wrangler.jsonc not found");
  /** @type {any} */
  const wrangler = parseJsonc(readFileSync(wranglerPath, "utf8"));
  const appName = wrangler?.name;
  if (typeof appName !== "string" || appName === "") {
    refuse('wrangler.jsonc has no top-level "name"');
  }
  const database = `${appName}-${values.env}`;

  const orgId = values.id ?? deriveOrgId(name);
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(orgId)) {
    refuse("--id must match ^[A-Za-z0-9_-]{1,60}$");
  }
  const now = Date.now();
  // A fresh member id every run is fine: `org_members` is UNIQUE(org_id, email), so the
  // second run's row is the one `INSERT OR IGNORE` drops.
  const memberId = crypto.randomUUID();

  const sql = [
    `INSERT OR IGNORE INTO organizations (id, name, created_by, created_at) VALUES (${sqlString(orgId)}, ${sqlString(name)}, ${sqlString(owner)}, ${now})`,
    `INSERT OR IGNORE INTO org_members (id, org_id, email, role, joined_at) VALUES (${sqlString(memberId)}, ${sqlString(orgId)}, ${sqlString(owner)}, 'owner', ${now})`,
  ].join("; ");

  const args = [
    "d1",
    "execute",
    database,
    "--remote",
    "--env",
    values.env,
    "--yes",
    "--command",
    sql,
  ];

  console.log(`bootstrap-org: ${values.env} database ${database}`);
  console.log(`bootstrap-org: organization ${orgId} "${name}", owner ${owner}`);
  console.log(`  $ wrangler ${args.slice(0, -1).join(" ")} "<sql>"`);
  console.log(`  sql: ${sql}`);

  if (values["dry-run"]) {
    console.log("bootstrap-org: --dry-run, nothing was executed");
    return;
  }

  const result = spawnSync(executable("wrangler"), args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    stdio: "inherit",
  });
  if (result.error)
    refuse(`wrangler failed to start (${result.error.message})`);
  if (result.status !== 0) {
    console.error(
      "bootstrap-org: the insert failed. If the error names a missing `organizations` or " +
        "`org_members` table, the framework has not created its own tables yet: open the " +
        "deployed app once (or request /_agent-native/health) and run this again.",
    );
    process.exit(result.status ?? 1);
  }
  console.log(
    `bootstrap-org: done. ${owner} is now the owner of ${orgId}. Next: enable "require ` +
      'Google sign-in" for the organization on the Team page (docs/bootstrap.md step 14).',
  );
}

main();
