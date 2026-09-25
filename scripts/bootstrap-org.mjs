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
// *after* the environment has served a request. It reaches the database through the
// framework's own executor, resolving the address from the Clever Cloud add-on so the
// connection string never appears in a command line or a log (T28). It writes every NOT NULL column those
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

import { parseArgs } from "node:util";

import { createDbExec } from "@agent-native/core/db";

import { addonDatabaseUrl } from "./lib/addon-url.mjs";
import { appName } from "./lib/app-identity.mjs";

const ENVIRONMENTS = ["staging", "production"];

const USAGE = `Usage: node scripts/bootstrap-org.mjs --env <staging|production> --name "<Org>" --owner <email>

  --env <name>      Deployment environment to write to. Required; there is no default, because
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
 * The values are bound parameters now rather than spliced text, so quoting is no longer a
 * safety property. The validation below stays anyway: a name carrying a newline or a
 * semicolon is far more likely a paste accident than an organisation, and refusing it costs
 * nothing.
 */

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

async function main() {
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

  const addon = `${appName()}-${values.env}-db`;

  const orgId = values.id ?? deriveOrgId(name);
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(orgId)) {
    refuse("--id must match ^[A-Za-z0-9_-]{1,60}$");
  }
  const now = Date.now();
  // A fresh member id every run is fine: `org_members` is UNIQUE(org_id, email), so the
  // second run's row is the one `ON CONFLICT DO NOTHING` drops.
  const memberId = crypto.randomUUID();

  const statements = [
    {
      sql: "INSERT INTO organizations (id, name, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      args: [orgId, name, owner, now],
    },
    {
      sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, 'owner', ?) ON CONFLICT DO NOTHING",
      args: [memberId, orgId, owner, now],
    },
  ];

  console.log(`bootstrap-org: ${values.env} database ${addon}`);
  console.log(`bootstrap-org: organization ${orgId} "${name}", owner ${owner}`);
  for (const statement of statements) console.log(`  sql: ${statement.sql}`);

  if (values["dry-run"]) {
    console.log("bootstrap-org: --dry-run, nothing was executed");
    return;
  }

  let client;
  try {
    client = await createDbExec({ url: addonDatabaseUrl(addon) });
  } catch (error) {
    refuse(
      `could not reach the ${values.env} database: ${error instanceof Error ? error.message : error}`,
    );
  }
  try {
    for (const statement of statements) await client.execute(statement);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    console.error(`bootstrap-org: the insert failed: ${message}`);
    if (/organizations|org_members/.test(message)) {
      console.error(
        "bootstrap-org: that names one of the framework's own tables, which it creates on " +
          "the first request that touches the database. Open the deployed app once (or " +
          "request /_agent-native/health) and run this again.",
      );
    }
    process.exit(1);
  } finally {
    await client.close?.();
  }
  console.log(
    `bootstrap-org: done. ${owner} is now the owner of ${orgId}. Next: enable "require ` +
      'Google sign-in" for the organization on the Team page (docs/bootstrap.md step 15).',
  );
}

await main();
