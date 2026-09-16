// `scripts/bootstrap.mjs` drives `wrangler` and `gh`, so it cannot be tested against the real
// tools without creating cloud resources. Instead every run here happens with a temporary
// PATH whose `wrangler`, `gh` and `pnpm` are stub shell scripts that append their argv and
// their stdin to a log file and print canned JSON.
//
// What that buys, and what this file therefore asserts:
//   * the plan output, and that a plan performs no mutating call at all;
//   * the exact argument arrays and the exact stdin bodies of every mutating call;
//   * idempotency: a second `--yes` run against a world that already exists reports
//     `already present` everywhere and issues no `create`/`put`/`set`;
//   * the refusals: APP_NAME that disagrees with wrangler.jsonc, production with no reviewer,
//     an unknown `--only` step, a malformed input;
//   * that no secret value ever appears on stdout or stderr.
//
// The repository is copied into a temporary directory for each case, so a run can edit
// `wrangler.jsonc` for real and be inspected afterwards without touching the working tree.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseJsonc } from "../../scripts/lib/jsonc.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/** Scratch trees are read by the assertions after the run, so they are removed at exit. */
/** @type {string[]} */
const scratchDirectories = [];
process.once("exit", () => {
  for (const directory of scratchDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Values the stubs must never see echoed back on stdout or stderr. */
const SECRETS = {
  CLOUDFLARE_API_TOKEN: "cf-token-000000000000000000000000",
  GOOGLE_SIGN_IN_CLIENT_ID: "111111.apps.googleusercontent.com",
  GOOGLE_SIGN_IN_CLIENT_SECRET: "GOCSPX-secret-value-0000000000",
  ANTHROPIC_API_KEY: "sk-ant-api03-0000000000000000000000",
  SEED_PASSWORD: "Example-Seed-Password-2026",
  BACKUP_S3_ACCESS_KEY_ID: "backup-access-key-000000000000",
  BACKUP_S3_SECRET_ACCESS_KEY: "backup-secret-key-000000000000",
};

const INPUTS = {
  APP_NAME: "example-jobs",
  GITHUB_REPO: "acme/field-ops",
  STAGING_URL: "https://staging.example.invalid",
  PRODUCTION_URL: "https://app.example.invalid",
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  ...SECRETS,
  PRODUCTION_REVIEWERS: "octocat, hubot",
  TEMPLATE_REPOSITORY: "1",
  BACKUP_AGE_RECIPIENT: "age1exampleexampleexampleexample",
  BACKUP_S3_BUCKET: "example-backups",
  BACKUP_S3_ENDPOINT: "https://accountid.r2.cloudflarestorage.com",
  BACKUP_S3_REGION: "auto",
  BACKUP_S3_PREFIX: "d1/example-jobs-production",
};

const STAGING_DB_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCTION_DB_ID = "22222222-2222-4222-8222-222222222222";

/**
 * The stubs are Node scripts with an absolute shebang, so they need nothing on PATH but the
 * Node that is already running this test. Each one appends a `>>> <name> [arg] [arg]` line
 * and, for a call that received stdin, every stdin line prefixed `<<<`, to a shared log; then
 * it answers its argv from a small mutable world stored as JSON next to the log.
 *
 * The world is mutable on purpose: `wrangler d1 create` adds the database that the next
 * `wrangler d1 list --json` reports, which is exactly the sequence the script relies on to
 * learn the id it must write into `wrangler.jsonc`. A stub that always answered `[]` would
 * hide that.
 *
 * `world` is the starting state: `empty` (nothing bootstrapped) or `full` (databases,
 * deployments, secrets, variables, environments, protection and the template flag all
 * present), which is what proves idempotency.
 *
 * Any argv a stub does not recognise is a test failure with a distinctive exit code, so a
 * change to the script's commands cannot pass unnoticed.
 * @param {{ dir: string, log: string, state: string, world: "empty" | "full" }} options
 */
function writeStubs({ dir, log, state, world }) {
  mkdirSync(dir, { recursive: true });

  const initial =
    world === "full"
      ? {
          databases: [
            { uuid: STAGING_DB_ID, name: "example-jobs-staging" },
            { uuid: PRODUCTION_DB_ID, name: "example-jobs-production" },
          ],
          deployed: ["staging", "production"],
          workerSecrets: {
            staging: [
              "BETTER_AUTH_SECRET",
              "OAUTH_STATE_SECRET",
              "GOOGLE_SIGN_IN_CLIENT_ID",
              "GOOGLE_SIGN_IN_CLIENT_SECRET",
              "ANTHROPIC_API_KEY",
              "SEED_PASSWORD",
            ],
            production: [
              "BETTER_AUTH_SECRET",
              "OAUTH_STATE_SECRET",
              "GOOGLE_SIGN_IN_CLIENT_ID",
              "GOOGLE_SIGN_IN_CLIENT_SECRET",
              "ANTHROPIC_API_KEY",
            ],
          },
          environments: ["staging", "production", "production-backup"],
          repositorySecrets: [
            "CLOUDFLARE_API_TOKEN",
            "CLOUDFLARE_ACCOUNT_ID",
            "SEED_PASSWORD",
            "BACKUP_AGE_RECIPIENT",
            "BACKUP_S3_BUCKET",
            "BACKUP_S3_ENDPOINT",
            "BACKUP_S3_ACCESS_KEY_ID",
            "BACKUP_S3_SECRET_ACCESS_KEY",
          ],
          repositoryVariables: [
            "STAGING_URL",
            "PRODUCTION_URL",
            "BACKUP_S3_REGION",
            "BACKUP_S3_PREFIX",
          ],
          protected: true,
          isTemplate: true,
        }
      : {
          databases: [],
          deployed: [],
          workerSecrets: {},
          environments: [],
          repositorySecrets: [],
          repositoryVariables: [],
          protected: false,
          isTemplate: false,
        };
  writeFileSync(state, JSON.stringify(initial, null, 2));

  const header = (name) => `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const LOG = ${JSON.stringify(log)};
const STATE = ${JSON.stringify(state)};
const argv = process.argv.slice(2);
appendFileSync(LOG, ">>> ${name}" + argv.map((a) => " [" + a + "]").join("") + "\\n");
const stdin = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
if (stdin !== "") {
  for (const line of stdin.split("\\n")) {
    if (line !== "") appendFileSync(LOG, "<<< " + line + "\\n");
  }
}
const world = JSON.parse(readFileSync(STATE, "utf8"));
const save = () => writeFileSync(STATE, JSON.stringify(world, null, 2));
const ok = (text) => { if (text !== undefined) process.stdout.write(text + "\\n"); process.exit(0); };
const notFound = (text) => { process.stderr.write(text + "\\n"); process.exit(1); };
const unexpected = (code) => {
  process.stderr.write("stub ${name}: unexpected argv: " + argv.join(" ") + "\\n");
  process.exit(code);
};
const flag = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
`;

  const wrangler = `${header("wrangler")}
const uuidFor = (name) =>
  name.endsWith("-staging") ? ${JSON.stringify(STAGING_DB_ID)} : ${JSON.stringify(PRODUCTION_DB_ID)};
const join = argv.slice(0, 2).join(" ");
if (argv[0] === "--version") ok(" \\u26c5\\ufe0f wrangler 4.129.0");
if (argv[0] === "whoami") ok(JSON.stringify({ account_id: "0123456789abcdef0123456789abcdef", email: "owner@example.invalid" }));
if (join === "d1 list") ok(JSON.stringify(world.databases));
if (join === "d1 create") {
  const name = argv[2];
  world.databases.push({ uuid: uuidFor(name), name });
  save();
  ok("Created " + name);
}
if (join === "deployments list") {
  const environment = flag("--env");
  if (!world.deployed.includes(environment)) notFound("workerd: script not found");
  ok(JSON.stringify([{ id: "deployment-1" }]));
}
if (join === "secret list") {
  const environment = flag("--env");
  if (!world.deployed.includes(environment)) notFound("A request to the Cloudflare API failed: script not found");
  ok(JSON.stringify((world.workerSecrets[environment] ?? []).map((name) => ({ name, type: "secret_text" }))));
}
if (join === "secret put") {
  const environment = flag("--env");
  world.workerSecrets[environment] ??= [];
  if (!world.workerSecrets[environment].includes(argv[2])) world.workerSecrets[environment].push(argv[2]);
  save();
  ok("Success! Uploaded secret " + argv[2]);
}
if (argv[0] === "deploy") {
  const environment = flag("--env");
  if (!world.deployed.includes(environment)) world.deployed.push(environment);
  save();
  ok("Deployed");
}
unexpected(90);
`;

  const gh = `${header("gh")}
const join = argv.slice(0, 2).join(" ");
if (join === "auth status") ok("Logged in to github.com account owner");
if (join === "repo view")
  ok(JSON.stringify({ nameWithOwner: argv[2], isTemplate: world.isTemplate, defaultBranchRef: { name: "main" } }));
if (join === "repo edit") {
  if (argv.includes("--template")) world.isTemplate = true;
  save();
  ok();
}
if (join === "secret list") ok(JSON.stringify(world.repositorySecrets.map((name) => ({ name }))));
if (join === "variable list") ok(JSON.stringify(world.repositoryVariables.map((name) => ({ name }))));
if (join === "secret set") {
  if (!world.repositorySecrets.includes(argv[2])) world.repositorySecrets.push(argv[2]);
  save();
  ok();
}
if (join === "variable set") {
  if (!world.repositoryVariables.includes(argv[2])) world.repositoryVariables.push(argv[2]);
  save();
  ok();
}
if (argv[0] === "api") {
  const method = flag("--method");
  const endpoint = argv[3];
  if (endpoint.startsWith("users/")) ok(JSON.stringify({ login: endpoint.slice(6), id: 583231 }));
  if (endpoint.endsWith("/branches/main/protection")) {
    if (method === "PUT") {
      world.protected = true;
      save();
      ok("{}");
    }
    if (!world.protected) notFound("gh: Branch not protected (HTTP 404)");
    ok(
      JSON.stringify({
        required_status_checks: { strict: false, contexts: ["CI / verify", "CI / worker", "CI / e2e"] },
        required_pull_request_reviews: { required_approving_review_count: 0 },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
      }),
    );
  }
  const environment = /\\/environments\\/(.+)$/.exec(endpoint)?.[1];
  if (environment !== undefined) {
    if (method === "PUT") {
      if (!world.environments.includes(environment)) world.environments.push(environment);
      save();
      ok("{}");
    }
    if (!world.environments.includes(environment)) notFound("gh: Not Found (HTTP 404)");
    ok(JSON.stringify({ name: environment }));
  }
}
unexpected(91);
`;

  const pnpm = `${header("pnpm")}
if (argv[0] === "build:worker") {
  mkdirSync("dist", { recursive: true });
  writeFileSync(
    "dist/BUILD_INFO.json",
    JSON.stringify({ sha: "stub", builtAt: "2026-09-08T00:00:00.000Z", coreVersion: "0.176.5" }),
  );
  ok("built");
}
unexpected(92);
`;

  for (const [name, source] of [
    ["wrangler", wrangler],
    ["gh", gh],
    ["pnpm", pnpm],
  ]) {
    const file = path.join(dir, name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  }
}

/**
 * Copies the parts of the repository the script reads into a scratch tree. `wrangler.jsonc` is
 * copied so a run may rewrite it; the scripts are copied so the run under test is the real one.
 *
 * `prepared` mirrors the `full` stub world into the configuration: a repository that has
 * already been bootstrapped has the real ids and URLs committed, which is the state the
 * idempotency case has to start from.
 * @param {string} destination
 * @param {{ prepared?: boolean }} [options]
 */
function stageRepository(destination, options = {}) {
  mkdirSync(path.join(destination, "scripts", "lib"), { recursive: true });
  const wranglerFile = path.join(destination, "wrangler.jsonc");
  cpSync(path.join(repoRoot, "wrangler.jsonc"), wranglerFile);
  if (options.prepared) {
    const source = readFileSync(wranglerFile, "utf8");
    const staged = source
      .replace(
        /("staging":[\s\S]*?"database_id":\s*")[^"]*(")/,
        `$1${STAGING_DB_ID}$2`,
      )
      .replace(
        /("production":[\s\S]*?"database_id":\s*")[^"]*(")/,
        `$1${PRODUCTION_DB_ID}$2`,
      )
      .replace(
        /("staging":[\s\S]*?"APP_URL":\s*")[^"]*(")/,
        `$1${INPUTS.STAGING_URL}$2`,
      )
      .replace(
        /("production":[\s\S]*?"APP_URL":\s*")[^"]*(")/,
        `$1${INPUTS.PRODUCTION_URL}$2`,
      );
    writeFileSync(wranglerFile, staged);
  }
  cpSync(
    path.join(repoRoot, "scripts", "bootstrap.mjs"),
    path.join(destination, "scripts", "bootstrap.mjs"),
  );
  cpSync(
    path.join(repoRoot, "scripts", "lib", "jsonc.mjs"),
    path.join(destination, "scripts", "lib", "jsonc.mjs"),
  );
  cpSync(
    path.join(repoRoot, ".bootstrap.env.example"),
    path.join(destination, ".bootstrap.env.example"),
  );
}

/**
 * @param {{
 *   args?: string[],
 *   inputs?: Record<string, string>,
 *   world?: "empty" | "full",
 *   wranglerName?: string,
 * }} [options]
 */
function bootstrap(options = {}) {
  const {
    args = ["--plan"],
    inputs = INPUTS,
    world = "empty",
    wranglerName,
  } = options;
  const scratch = mkdtempSync(path.join(tmpdir(), "bootstrap-guard-"));
  try {
    stageRepository(scratch, { prepared: world === "full" });
    if (wranglerName !== undefined) {
      const file = path.join(scratch, "wrangler.jsonc");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          /"name":\s*"[^"]*"/,
          `"name": "${wranglerName}"`,
        ),
      );
    }
    const log = path.join(scratch, "calls.log");
    writeFileSync(log, "");
    const stubs = path.join(scratch, "stubs");
    writeStubs({
      dir: stubs,
      log,
      state: path.join(scratch, "world.json"),
      world,
    });

    const envFile = path.join(scratch, ".bootstrap.env");
    writeFileSync(
      envFile,
      Object.entries(inputs)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(scratch, "scripts", "bootstrap.mjs"),
        ...args,
        "--env-file",
        envFile,
      ],
      {
        cwd: scratch,
        encoding: "utf8",
        // A bare PATH: only the stubs plus the directory holding this Node, so nothing can
        // reach a real wrangler, gh or pnpm. Every input the script may read is cleared from
        // the environment so the env file is the only source.
        env: {
          PATH: `${stubs}${path.delimiter}${path.dirname(process.execPath)}`,
          HOME: scratch,
        },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      calls: readFileSync(log, "utf8"),
      scratch,
      wrangler: () =>
        readFileSync(path.join(scratch, "wrangler.jsonc"), "utf8"),
    };
  } finally {
    // Kept until the assertions have run: the caller reads the scratch tree through the
    // returned closures, so removal is deferred to the single exit handler above.
    scratchDirectories.push(scratch);
  }
}

/** Every mutating call any stub could have been asked to make. */
const MUTATING = [
  ">>> wrangler [d1] [create]",
  ">>> wrangler [deploy]",
  ">>> wrangler [secret] [put]",
  ">>> gh [secret] [set]",
  ">>> gh [variable] [set]",
  ">>> gh [repo] [edit]",
  ">>> gh [api] [--method] [PUT]",
];

/** @param {string} calls */
function mutatingCalls(calls) {
  return calls
    .split("\n")
    .filter((line) => MUTATING.some((prefix) => line.startsWith(prefix)));
}

/** @param {{ stdout: string, stderr: string }} result */
function assertNoSecretLeaked(result) {
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.equal(
      result.stdout.includes(value),
      false,
      `${name} leaked to stdout`,
    );
    assert.equal(
      result.stderr.includes(value),
      false,
      `${name} leaked to stderr`,
    );
  }
  // The generated signing secrets are 64 hex characters and must never be printed either.
  const hex64 = /\b[0-9a-f]{64}\b/;
  assert.equal(
    hex64.test(result.stdout),
    false,
    "a 64-hex-character value reached stdout",
  );
  assert.equal(
    hex64.test(result.stderr),
    false,
    "a 64-hex-character value reached stderr",
  );
}

test("--plan reports every step, performs no mutating call and redacts every secret", () => {
  const run = bootstrap({ args: ["--plan"] });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^bootstrap: PLAN \(read-only\)/m);

  for (const expected of [
    "[would create] database example-jobs-staging",
    "[would create] database example-jobs-production",
    "[would create] Worker example-jobs-staging",
    "[would create] environment staging",
    "[would create] environment production",
    "[would create] environment production-backup",
    "[would create] staging secret CLOUDFLARE_API_TOKEN",
    "[would create] staging variable STAGING_URL",
    "[would create] main",
    "[would create] template repository flag",
  ]) {
    assert.ok(run.stdout.includes(expected), `plan is missing: ${expected}`);
  }

  // The plan prints the commands it would run, with the secret named and never shown.
  assert.match(
    run.stdout,
    /\$ wrangler secret put BETTER_AUTH_SECRET --env staging {3}< <redacted> on stdin/,
  );
  assert.match(
    run.stdout,
    /\$ wrangler d1 create example-jobs-staging --jurisdiction eu/,
  );
  assert.match(run.stdout, /\$ pnpm build:worker/);
  assert.match(run.stdout, /Re-run with --yes to perform it\./);

  assert.deepEqual(mutatingCalls(run.calls), []);
  // The read-only probes did run.
  assert.ok(run.calls.includes(">>> wrangler [--version]"));
  assert.ok(run.calls.includes(">>> wrangler [whoami] [--json]"));
  assert.ok(run.calls.includes(">>> gh [auth] [status]"));
  // …and wrangler.jsonc is untouched by a plan.
  assert.equal(
    run.wrangler(),
    readFileSync(path.join(repoRoot, "wrangler.jsonc"), "utf8"),
  );
  assertNoSecretLeaked(run);
});

test("--yes issues exactly the expected argument arrays and stdin bodies", () => {
  const run = bootstrap({ args: ["--yes"], world: "empty" });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.calls.split("\n");

  // Preflight, in order, before anything is created.
  assert.equal(lines[0], ">>> wrangler [--version]");
  assert.equal(lines[1], ">>> wrangler [whoami] [--json]");
  assert.equal(lines[2], ">>> gh [auth] [status]");
  assert.equal(
    lines[3],
    ">>> gh [repo] [view] [acme/field-ops] [--json] [nameWithOwner,isTemplate,defaultBranchRef]",
  );

  for (const expected of [
    ">>> wrangler [d1] [list] [--json]",
    ">>> wrangler [d1] [create] [example-jobs-staging] [--jurisdiction] [eu]",
    ">>> wrangler [d1] [create] [example-jobs-production] [--jurisdiction] [eu]",
    ">>> wrangler [deployments] [list] [--env] [staging] [--json]",
    ">>> pnpm [build:worker]",
    ">>> wrangler [deploy] [--env] [staging]",
    ">>> wrangler [deploy] [--env] [production]",
    ">>> wrangler [secret] [list] [--env] [staging] [--format] [json]",
    ">>> wrangler [secret] [put] [BETTER_AUTH_SECRET] [--env] [staging]",
    ">>> wrangler [secret] [put] [OAUTH_STATE_SECRET] [--env] [production]",
    ">>> wrangler [secret] [put] [SEED_PASSWORD] [--env] [staging]",
    ">>> gh [api] [--method] [GET] [repos/acme/field-ops/environments/staging]",
    ">>> gh [api] [--method] [PUT] [repos/acme/field-ops/environments/staging] [--input] [-]",
    ">>> gh [api] [--method] [GET] [users/octocat]",
    ">>> gh [api] [--method] [GET] [users/hubot]",
    ">>> gh [secret] [set] [CLOUDFLARE_API_TOKEN] [--env] [staging] [--repo] [acme/field-ops]",
    ">>> gh [variable] [set] [STAGING_URL] [--env] [staging] [--repo] [acme/field-ops]",
    ">>> gh [secret] [set] [BACKUP_S3_SECRET_ACCESS_KEY] [--env] [production-backup] [--repo] [acme/field-ops]",
    ">>> gh [api] [--method] [PUT] [repos/acme/field-ops/branches/main/protection] [--input] [-]",
    ">>> gh [repo] [edit] [acme/field-ops] [--template]",
  ]) {
    assert.ok(lines.includes(expected), `missing call: ${expected}`);
  }

  // Production is never given a SEED_PASSWORD: it is never seeded (B13).
  assert.equal(
    lines.includes(
      ">>> wrangler [secret] [put] [SEED_PASSWORD] [--env] [production]",
    ),
    false,
  );
  assert.equal(
    lines.includes(
      ">>> gh [secret] [set] [SEED_PASSWORD] [--env] [production] [--repo] [acme/field-ops]",
    ),
    false,
  );

  // The exact JSON bodies, read back from the stubs' stdin log.
  assert.ok(
    run.calls.includes(
      '<<< {"wait_timer":0,"prevent_self_review":false,"reviewers":null,"deployment_branch_policy":null}',
    ),
    "staging environment body",
  );
  assert.ok(
    run.calls.includes(
      '<<< {"wait_timer":0,"prevent_self_review":false,"reviewers":[{"type":"User","id":583231},{"type":"User","id":583231}],"deployment_branch_policy":null}',
    ),
    "production environment body with resolved reviewer ids",
  );
  assert.ok(
    run.calls.includes(
      '<<< {"required_status_checks":{"strict":false,"contexts":["CI / verify","CI / worker","CI / e2e"]},' +
        '"enforce_admins":null,"required_pull_request_reviews":{"required_approving_review_count":0,' +
        '"dismiss_stale_reviews":false,"require_code_owner_reviews":false},"restrictions":null,' +
        '"allow_force_pushes":false,"allow_deletions":false}',
    ),
    "branch protection body",
  );

  // Two different generated signing secrets reached the two environments on stdin, and both
  // are 32 random bytes as hex.
  const stdinValues = run.calls
    .split("\n")
    .filter((line) => line.startsWith("<<< "))
    .map((line) => line.slice(4));
  const generated = stdinValues.filter((value) => /^[0-9a-f]{64}$/.test(value));
  assert.equal(generated.length, 4, "two signing secrets per environment");
  assert.equal(
    new Set(generated).size,
    4,
    "no signing secret is reused across environments",
  );
  assert.ok(
    stdinValues.includes(SECRETS.ANTHROPIC_API_KEY),
    "the provider key reached stdin",
  );

  // wrangler.jsonc now carries the created ids and the real URLs, and still parses.
  const written = run.wrangler();
  /** @type {any} */
  const parsed = parseJsonc(written);
  assert.equal(parsed.env.staging.d1_databases[0].database_id, STAGING_DB_ID);
  assert.equal(
    parsed.env.production.d1_databases[0].database_id,
    PRODUCTION_DB_ID,
  );
  assert.equal(parsed.env.staging.vars.APP_URL, INPUTS.STAGING_URL);
  assert.equal(parsed.env.production.vars.APP_URL, INPUTS.PRODUCTION_URL);
  // The in-place text edit kept every comment and the local block untouched.
  assert.ok(written.includes("// Worker configuration"));
  assert.ok(written.includes('"database_name": "example-jobs-local"'));
  assert.equal(parsed.env.production.vars.AUTH_REQUIRE_EMAIL_VERIFICATION, "1");

  assertNoSecretLeaked(run);
});

test("a second --yes run against an existing world creates nothing", () => {
  const run = bootstrap({ args: ["--yes"], world: "full" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(mutatingCalls(run.calls), []);

  for (const expected of [
    "[already present] database example-jobs-staging",
    "[already present] wrangler.jsonc env.staging.database_id",
    "[already present] wrangler.jsonc env.staging.vars.APP_URL",
    "[already present] Worker example-jobs-staging",
    "[already present] staging BETTER_AUTH_SECRET",
    "[already present] production ANTHROPIC_API_KEY",
    "[already present] environment production",
    "[already present] staging secret CLOUDFLARE_API_TOKEN",
    "[already present] main",
    "[already present] template repository flag",
  ]) {
    assert.ok(
      run.stdout.includes(expected),
      `missing idempotent report: ${expected}`,
    );
  }
  assert.equal(
    run.stdout.includes("[created]"),
    false,
    "nothing should report created",
  );
  assertNoSecretLeaked(run);
});

test("--rotate replaces existing secrets and says signing out is the cost", () => {
  const run = bootstrap({ args: ["--yes", "--rotate"], world: "full" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(
    run.calls.includes(
      ">>> wrangler [secret] [put] [BETTER_AUTH_SECRET] [--env] [production]",
    ),
  );
  assert.match(
    run.stderr,
    /rotating BETTER_AUTH_SECRET on production signs every user/,
  );
  assertNoSecretLeaked(run);
});

test("--only runs the named steps and nothing else", () => {
  const run = bootstrap({
    args: ["--plan", "--only", "preflight,branch-protection"],
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^d1 — skipped \(--only\)$/m);
  assert.match(run.stdout, /^worker-secrets — skipped \(--only\)$/m);
  assert.equal(run.calls.includes(">>> wrangler [d1] [list] [--json]"), false);
  assert.ok(
    run.calls.includes(
      ">>> gh [api] [--method] [GET] [repos/acme/field-ops/branches/main/protection]",
    ),
  );
});

test("refuses an APP_NAME that does not match the Worker name in wrangler.jsonc", () => {
  const run = bootstrap({ args: ["--plan"], wranglerName: "something-else" });
  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    /wrangler\.jsonc top-level "name" is "something-else"/,
  );
  assert.match(run.stderr, /scripts\/rename-app\.mjs/);
  assert.deepEqual(mutatingCalls(run.calls), []);
});

test("refuses to create the production environment with no reviewer", () => {
  const run = bootstrap({
    args: ["--yes"],
    inputs: { ...INPUTS, PRODUCTION_REVIEWERS: "" },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /PRODUCTION_REVIEWERS is empty/);
  assert.match(run.stderr, /--allow-unprotected-production/);
  // It refused at the environment step, so the production environment was never written.
  assert.equal(
    run.calls.includes(
      ">>> gh [api] [--method] [PUT] [repos/acme/field-ops/environments/production] [--input] [-]",
    ),
    false,
  );
});

test("--allow-unprotected-production is the documented way past that refusal", () => {
  const run = bootstrap({
    args: ["--yes", "--allow-unprotected-production"],
    inputs: { ...INPUTS, PRODUCTION_REVIEWERS: "" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(
    run.stdout.includes("no reviewers (--allow-unprotected-production)"),
  );
  assert.ok(
    run.calls.includes(
      '<<< {"wait_timer":0,"prevent_self_review":false,"reviewers":null,"deployment_branch_policy":null}',
    ),
  );
});

test("refuses malformed inputs before touching anything", () => {
  for (const [
    override,
    pattern,
  ] of /** @type {[Record<string, string>, RegExp][]} */ ([
    [{ APP_NAME: "Example_Jobs" }, /APP_NAME must match/],
    [{ GITHUB_REPO: "not-a-repo" }, /GITHUB_REPO must be owner\/name/],
    [
      { STAGING_URL: "http://staging.example.invalid" },
      /STAGING_URL must be an https origin/,
    ],
    [
      { PRODUCTION_URL: "https://app.example.invalid/app" },
      /PRODUCTION_URL must be an https origin/,
    ],
    [
      { SEED_PASSWORD: "short" },
      /SEED_PASSWORD must be at least 16 characters/,
    ],
    [
      { BACKUP_S3_BUCKET: "", BACKUP_S3_ENDPOINT: "https://x.invalid" },
      /all of BACKUP_S3_BUCKET/,
    ],
  ])) {
    const run = bootstrap({
      args: ["--yes"],
      inputs: { ...INPUTS, ...override },
    });
    assert.equal(
      run.status,
      1,
      `expected a refusal for ${JSON.stringify(override)}`,
    );
    assert.match(run.stderr, pattern);
    assert.equal(
      run.calls.trim(),
      "",
      "no subprocess should run on invalid input",
    );
  }
});

test("refuses an unknown --only step and --plan together with --yes", () => {
  const unknown = bootstrap({ args: ["--plan", "--only", "d1,nonsense"] });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown --only step\(s\): nonsense/);

  const both = bootstrap({ args: ["--plan", "--yes"] });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /mutually exclusive/);
});

test("the committed example file yields a fill-in report and exit 0", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bootstrap-example-"));
  try {
    stageRepository(scratch);
    const log = path.join(scratch, "calls.log");
    writeFileSync(log, "");
    const stubs = path.join(scratch, "stubs");
    writeStubs({
      dir: stubs,
      log,
      state: path.join(scratch, "world.json"),
      world: "empty",
    });
    const result = spawnSync(
      process.execPath,
      [
        path.join(scratch, "scripts", "bootstrap.mjs"),
        "--plan",
        "--env-file",
        ".bootstrap.env.example",
      ],
      {
        cwd: scratch,
        encoding: "utf8",
        env: {
          PATH: `${stubs}${path.delimiter}${path.dirname(process.execPath)}`,
          HOME: scratch,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout ?? "", /Fill in these keys/);
    for (const key of [
      "APP_NAME",
      "GITHUB_REPO",
      "CLOUDFLARE_API_TOKEN",
      "SEED_PASSWORD",
    ]) {
      assert.match(result.stdout ?? "", new RegExp(`^ {2}${key}$`, "m"));
    }
    assert.match(
      result.stdout ?? "",
      /cp \.bootstrap\.env\.example \.bootstrap\.env/,
    );
    assert.equal(
      readFileSync(log, "utf8").trim(),
      "",
      "no probe should run without inputs",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the committed example file carries names only", () => {
  const contents = readFileSync(
    path.join(repoRoot, ".bootstrap.env.example"),
    "utf8",
  );
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    assert.match(
      line,
      /^[A-Z][A-Z0-9_]*=$/,
      `.bootstrap.env.example must carry no value: ${line}`,
    );
  }
  // Not "the file does not exist": a maintainer who is actually bootstrapping
  // has one, and asserting its absence failed `pnpm check` for the first person
  // to use the script as documented (DISCREPANCIES.md, 2026-09-11). What has to
  // hold is that it can never be committed, which is what the ignore rule does.
  // `git check-ignore -q` exits 0 when the path is ignored.
  assert.doesNotThrow(
    () =>
      execFileSync("git", ["check-ignore", "-q", ".bootstrap.env"], {
        cwd: repoRoot,
      }),
    ".bootstrap.env must be git-ignored",
  );
});
