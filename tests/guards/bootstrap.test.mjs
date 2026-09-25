// `scripts/bootstrap.mjs` drives `clever` (through `npx`) and `gh`, so it cannot be tested
// against the real tools without creating cloud resources. Instead every run here happens
// with a temporary PATH whose `npx`, `gh` and `pnpm` are stub scripts that append their argv
// and their stdin to a log file and print canned JSON.
//
// What that buys, and what this file therefore asserts:
//   * the plan output, and that a plan performs no mutating call at all;
//   * the exact argument arrays and the exact stdin bodies of every mutating call;
//   * idempotency: a second `--yes` run against a world that already exists reports
//     `already present` everywhere and issues no create/import/deploy;
//   * the refusals: APP_NAME that disagrees with package.json, an unauthenticated CLI,
//     production with no reviewer, an unknown `--only` step, a malformed input;
//   * that no secret value ever appears on stdout or stderr.
//
// The repository is copied into a temporary directory for each case, and `HOME` points at
// that copy, so the CLI profile the script reads is the stub one written here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  GOOGLE_SIGN_IN_CLIENT_ID: "111111.apps.googleusercontent.com",
  GOOGLE_SIGN_IN_CLIENT_SECRET: "GOCSPX-secret-value-0000000000",
  ANTHROPIC_API_KEY: "sk-ant-api03-0000000000000000000000",
  SEED_PASSWORD: "Example-Seed-Password-2026",
};

/** The CLI profile `clever login` writes, which bootstrap reads to set the CI secrets. */
const PROFILE_TOKEN = "clever-token-000000000000000000";
const PROFILE_SECRET = "clever-secret-00000000000000000";

/** What clever-tools 5.x writes: the credentials nested in a profiles array, each with an
 * alias and an expiry. The 4.x shape put `token` and `secret` at the top level, and reading
 * only that shape made the script report "run `clever login` first" at a CLI that was logged
 * in — so the default fixture is the current shape and the old one has its own test. */
const PROFILE = {
  version: 1,
  profiles: [
    {
      alias: "default",
      token: PROFILE_TOKEN,
      secret: PROFILE_SECRET,
      expirationDate: new Date(Date.now() + 86_400_000).toISOString(),
      userId: "user_stub",
      email: "owner@example.invalid",
    },
  ],
};

const INPUTS = {
  APP_NAME: "example-jobs",
  GITHUB_REPO: "acme/field-ops",
  ...SECRETS,
  PRODUCTION_REVIEWERS: "octocat, hubot",
  TEMPLATE_REPOSITORY: "1",
};

const STAGING_DOMAIN = "app-1111.cleverapps.io";
const PRODUCTION_DOMAIN = "app-2222.cleverapps.io";

/**
 * The stubs are Node scripts with an absolute shebang, so they need nothing on PATH but the
 * Node that is already running this test. Each one appends a `>>> <name> [arg] [arg]` line
 * and, for a call that received stdin, every stdin line prefixed `<<<`, to a shared log;
 * then it answers its argv from a small mutable world stored as JSON next to the log.
 *
 * The world is mutable on purpose: `clever create` adds the application that the next
 * `clever applications` reports, which is the sequence idempotency depends on. A stub that
 * always answered `[]` would hide that.
 *
 * Any argv a stub does not recognise is a test failure with a distinctive exit code, so a
 * change to the script's commands cannot pass unnoticed.
 * @param {{ dir: string, log: string, state: string, world: "empty" | "full", loggedIn?: boolean }} options
 */
function writeStubs({ dir, log, state, world, loggedIn = true }) {
  mkdirSync(dir, { recursive: true });

  const fullEnv = (environment) => ({
    APP_ENV: environment,
    NODE_ENV: "production",
    APP_URL: `https://${environment === "staging" ? STAGING_DOMAIN : PRODUCTION_DOMAIN}`,
    AUTO_CREATE_DEFAULT_ORG: "0",
    AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT: "1",
    AUTH_REQUIRE_EMAIL_VERIFICATION: environment === "production" ? "1" : "0",
    SEED_ENABLED: environment === "staging" ? "1" : "0",
    AGENT_NATIVE_AUDIT_RETENTION_DAYS:
      environment === "production" ? "0" : "365",
    CC_NODE_BUILD_TOOL: "pnpm",
    CC_NODE_DEV_DEPENDENCIES: "install",
    CC_RUN_COMMAND: "pnpm start",
    CC_POST_BUILD_HOOK: "pnpm build",
    POSTGRESQL_ADDON_URI: "postgresql://stub",
    BETTER_AUTH_SECRET: "a".repeat(64),
    OAUTH_STATE_SECRET: "b".repeat(64),
    GOOGLE_SIGN_IN_CLIENT_ID: SECRETS.GOOGLE_SIGN_IN_CLIENT_ID,
    GOOGLE_SIGN_IN_CLIENT_SECRET: SECRETS.GOOGLE_SIGN_IN_CLIENT_SECRET,
    ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY,
    ...(environment === "staging"
      ? { SEED_PASSWORD: SECRETS.SEED_PASSWORD }
      : {}),
  });

  const initial =
    world === "full"
      ? {
          apps: [
            { name: "example-jobs-staging", alias: "staging" },
            { name: "example-jobs-production", alias: "production" },
          ],
          addons: [
            { name: "example-jobs-staging-db" },
            { name: "example-jobs-production-db" },
          ],
          appEnv: {
            staging: fullEnv("staging"),
            production: fullEnv("production"),
          },
          deployed: ["staging", "production"],
          environments: ["staging", "production"],
          repositorySecrets: {
            staging: ["CLEVER_TOKEN", "CLEVER_SECRET", "SEED_PASSWORD"],
            production: ["CLEVER_TOKEN", "CLEVER_SECRET"],
          },
          repositoryVariables: {
            staging: ["STAGING_URL", "CLEVER_APP_NAME"],
            production: ["PRODUCTION_URL", "CLEVER_APP_NAME"],
          },
          protected: true,
          isTemplate: true,
        }
      : {
          apps: [],
          addons: [],
          appEnv: {},
          deployed: [],
          environments: [],
          repositorySecrets: {},
          repositoryVariables: {},
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
// The real \`clever\` prints usage to stdout and exits 0 for an option it does not know,
// so a caller that only checks the exit status sees success and parses nothing.
const usage = (message) => {
  process.stdout.write(message + "\\n\\nUSAGE\\n  clever ...\\n");
  process.exit(0);
};
const unexpected = (code) => {
  process.stderr.write("stub ${name}: unexpected argv: " + argv.join(" ") + "\\n");
  process.exit(code);
};
const flag = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
`;

  // Bootstrap reaches the CLI as `npx --yes clever-tools@latest <command> …`, so the stub
  // strips those two arguments and answers the command. Asserting on that shape is
  // deliberate: it is what lets a fresh machine bootstrap with nothing installed globally.
  const npx = `${header("npx")}
if (argv[0] !== "--yes" || !String(argv[1]).startsWith("clever-tools")) unexpected(93);
const c = argv.slice(2);
const join = c.slice(0, 2).join(" ");
const loggedIn = ${loggedIn ? "true" : "false"};
if (c[0] === "version") ok("clever-tools 4.0.0");
if (c[0] === "profile") {
  if (!loggedIn) notFound("[ERROR] No profile found, use clever login command");
  ok("default (owner@example.invalid) [active]");
}
// The real CLI takes a DIFFERENT json flag per subcommand and, worse, exits 0 with its
// usage text when given one it does not know. This stub reproduces both, because a stub
// that answered every spelling was what let a wrong flag pass its own idempotency test
// (DISCREPANCIES.md, 2026-09-24). 'applications list' is account-wide and grouped by
// organisation; bare 'applications' is only what this checkout has linked.
if (join === "applications list") {
  if (flag("--format") !== "json") usage("Unknown option: json");
  ok(JSON.stringify([
    { id: "user_stub", name: "Personal space",
      applications: world.apps.map(({ name }) => ({ name })) },
  ]));
}
if (c[0] === "applications") {
  if (!argv.includes("--json")) usage("Unknown option: format");
  ok(JSON.stringify(
    world.apps.filter((app) => app.alias).map(({ name, alias }) => ({ name, alias })),
  ));
}
if (c[0] === "create") {
  const name = c[3];
  world.apps.push({ name, alias: flag("--alias") });
  save();
  ok(JSON.stringify({ id: "app_" + name, name }));
}
if (c[0] === "link") {
  const app = world.apps.find((candidate) => candidate.name === c[1]);
  if (!app) notFound("[ERROR] Application not found");
  app.alias = flag("--alias");
  save();
  ok("Application " + c[1] + " successfully linked");
}
if (c[0] === "scale") ok("App rescaled successfully");
if (c[0] === "domain") {
  const alias = flag("--alias");
  ok("  " + (alias === "staging" ? ${JSON.stringify(STAGING_DOMAIN)} : ${JSON.stringify(PRODUCTION_DOMAIN)}) + "/");
}
if (join === "addon list") ok(JSON.stringify(world.addons));
if (join === "addon create") {
  world.addons.push({ name: c[3] });
  save();
  ok(JSON.stringify({ id: "addon_" + c[3] }));
}
if (join === "service link-addon") ok("Addon " + c[2] + " successfully linked");
if (c[0] === "env" && c[1] !== "import") {
  const alias = flag("--alias");
  if (!world.apps.some((app) => app.name === "example-jobs-" + alias)) {
    notFound("[ERROR] Application not found");
  }
  const values = world.appEnv[alias] ?? {};
  ok(JSON.stringify(Object.entries(values).map(([name, value]) => ({ name, value }))));
}
if (join === "env import") {
  const alias = flag("--alias");
  const values = {};
  for (const line of stdin.split("\\n")) {
    if (line === "") continue;
    const at = line.indexOf("=");
    values[line.slice(0, at)] = line.slice(at + 1);
  }
  world.appEnv[alias] = values;
  save();
  ok("Environment variables have been set");
}
if (c[0] === "activity") {
  const alias = flag("--alias");
  ok(world.deployed.includes(alias) ? "2026-09-23  deployment-1  OK  DEPLOY  abc  Git" : "");
}
if (c[0] === "deploy") {
  const alias = flag("--alias");
  if (!world.deployed.includes(alias)) world.deployed.push(alias);
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
// Secrets and variables are scoped to a GitHub environment, and the script relies on that:
// staging carries SEED_PASSWORD and production does not. A stub with one repository-wide
// list would report production's as already present the moment staging set them.
if (join === "secret list") ok(JSON.stringify((world.repositorySecrets[flag("--env")] ?? []).map((name) => ({ name }))));
if (join === "variable list") ok(JSON.stringify((world.repositoryVariables[flag("--env")] ?? []).map((name) => ({ name }))));
if (join === "secret set") {
  const environment = flag("--env");
  world.repositorySecrets[environment] ??= [];
  if (!world.repositorySecrets[environment].includes(argv[2])) world.repositorySecrets[environment].push(argv[2]);
  save();
  ok();
}
if (join === "variable set") {
  const environment = flag("--env");
  world.repositoryVariables[environment] ??= [];
  if (!world.repositoryVariables[environment].includes(argv[2])) world.repositoryVariables[environment].push(argv[2]);
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
        required_status_checks: { strict: false, contexts: ["CI / verify", "CI / e2e"] },
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
unexpected(92);
`;

  for (const [name, source] of [
    ["npx", npx],
    ["gh", gh],
    ["pnpm", pnpm],
  ]) {
    const file = path.join(dir, name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  }
}

/**
 * Copies the parts of the repository the script reads into a scratch tree, and writes the
 * CLI profile it reads the CI credentials from. Nothing in the repository is written by a
 * run any more — the applications, their databases and their settings all live on the
 * platform — so unlike the Cloudflare version there is no configuration file to stage.
 * @param {string} destination
 * @param {{ appName?: string, withProfile?: boolean, profile?: unknown }} [options]
 */
function stageRepository(destination, options = {}) {
  const {
    appName = INPUTS.APP_NAME,
    withProfile = true,
    profile = PROFILE,
  } = options;
  mkdirSync(path.join(destination, "scripts", "lib"), { recursive: true });
  mkdirSync(path.join(destination, "server", "plugins"), { recursive: true });
  // The application's name lives where `rename-app.mjs` puts it, which is the one place
  // every script agrees to read it from.
  writeFileSync(
    path.join(destination, "server", "plugins", "config.ts"),
    `export default defineAppConfig({\n  app: { id: "${appName}", name: "Example Jobs" },\n});\n`,
  );
  cpSync(
    path.join(repoRoot, "scripts", "bootstrap.mjs"),
    path.join(destination, "scripts", "bootstrap.mjs"),
  );
  for (const helper of ["app-identity.mjs", "addon-url.mjs"]) {
    cpSync(
      path.join(repoRoot, "scripts", "lib", helper),
      path.join(destination, "scripts", "lib", helper),
    );
  }
  cpSync(
    path.join(repoRoot, ".bootstrap.env.example"),
    path.join(destination, ".bootstrap.env.example"),
  );
  if (withProfile) {
    const directory = path.join(destination, ".config", "clever-cloud");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "clever-tools.json"),
      JSON.stringify(profile),
    );
  }
}

/**
 * @param {{
 *   args?: string[],
 *   inputs?: Record<string, string>,
 *   world?: "empty" | "full",
 *   appName?: string,
 *   loggedIn?: boolean,
 *   withProfile?: boolean,
 *   profile?: unknown,
 * }} [options]
 */
function bootstrap(options = {}) {
  const {
    args = ["--plan"],
    inputs = INPUTS,
    world = "empty",
    appName,
    loggedIn = true,
    withProfile = true,
    profile,
  } = options;
  const scratch = mkdtempSync(path.join(tmpdir(), "bootstrap-guard-"));
  try {
    stageRepository(scratch, { appName, withProfile, profile });
    const log = path.join(scratch, "calls.log");
    writeFileSync(log, "");
    const stubs = path.join(scratch, "stubs");
    writeStubs({
      dir: stubs,
      log,
      state: path.join(scratch, "world.json"),
      world,
      loggedIn,
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
        // reach a real clever, gh or pnpm. Every input the script may read is cleared from
        // the environment so the env file is the only source, and HOME points at the
        // scratch tree so the CLI profile read is the stub one.
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
    };
  } finally {
    // Kept until the assertions have run: the caller reads the scratch tree through the
    // returned values, so removal is deferred to the single exit handler above.
    scratchDirectories.push(scratch);
  }
}

/** Every mutating call any stub could have been asked to make. */
const MUTATING = [
  ">>> npx [--yes] [clever-tools@latest] [create]",
  ">>> npx [--yes] [clever-tools@latest] [scale]",
  ">>> npx [--yes] [clever-tools@latest] [addon] [create]",
  ">>> npx [--yes] [clever-tools@latest] [service] [link-addon]",
  ">>> npx [--yes] [clever-tools@latest] [env] [import]",
  ">>> npx [--yes] [clever-tools@latest] [deploy]",
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
  // The credential values themselves, not the profile file's structure: spreading PROFILE
  // here once meant asserting that stdout does not contain its `version: 1`, which every
  // run trivially fails.
  const leakable = {
    ...SECRETS,
    CLEVER_TOKEN: PROFILE_TOKEN,
    CLEVER_SECRET: PROFILE_SECRET,
  };
  for (const [name, value] of Object.entries(leakable)) {
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
  const result = bootstrap();
  assert.equal(result.status, 0, result.stderr);
  for (const step of [
    "preflight",
    "apps",
    "postgres",
    "app-env",
    "deploy",
    "github-environments",
    "github-secrets",
    "branch-protection",
  ]) {
    assert.match(result.stdout, new RegExp(`^${step}`, "m"), `${step} missing`);
  }
  assert.deepEqual(mutatingCalls(result.calls), []);
  assert.match(result.stdout, /This was a plan\. Nothing was created\./);
  assertNoSecretLeaked(result);
});

test("--yes issues exactly the expected argument arrays and stdin bodies", () => {
  const result = bootstrap({ args: ["--yes"] });
  assert.equal(result.status, 0, result.stderr);

  const calls = mutatingCalls(result.calls);
  for (const environment of ["staging", "production"]) {
    assert.ok(
      calls.includes(
        `>>> npx [--yes] [clever-tools@latest] [create] [--type] [node] [example-jobs-${environment}] [--region] [par] [--alias] [${environment}] [--format] [json]`,
      ),
      `application not created for ${environment}:\n${calls.join("\n")}`,
    );
    assert.ok(
      calls.includes(
        `>>> npx [--yes] [clever-tools@latest] [addon] [create] [postgresql-addon] [example-jobs-${environment}-db] [--region] [par] [--plan] [xxs_sml] [--yes]`,
      ),
      `database not created for ${environment}`,
    );
    assert.ok(
      calls.includes(
        `>>> npx [--yes] [clever-tools@latest] [service] [link-addon] [example-jobs-${environment}-db] [--alias] [${environment}]`,
      ),
      `database not linked for ${environment}`,
    );
    assert.ok(
      calls.includes(
        `>>> npx [--yes] [clever-tools@latest] [env] [import] [--alias] [${environment}]`,
      ),
      `environment not imported for ${environment}`,
    );
  }

  // The settings travel on stdin, never on a command line, so they never reach a shell
  // history or a process list.
  assert.match(result.calls, /<<< ANTHROPIC_API_KEY=/);
  assert.match(result.calls, /<<< BETTER_AUTH_SECRET=/);
  assert.match(result.calls, /<<< CC_NODE_DEV_DEPENDENCIES=install/);
  // Staging is seeded; production never is (B13).
  const staging = result.calls.slice(
    result.calls.indexOf("[env] [import] [--alias] [staging]"),
    result.calls.indexOf("[env] [import] [--alias] [production]"),
  );
  assert.match(staging, /<<< SEED_PASSWORD=/);
  assert.match(staging, /<<< SEED_ENABLED=1/);
  const production = result.calls.slice(
    result.calls.indexOf("[env] [import] [--alias] [production]"),
  );
  assert.equal(/<<< SEED_PASSWORD=/.test(production), false);
  assert.match(production, /<<< SEED_ENABLED=0/);

  // The URL nobody could know in advance: read back from the platform, not asked for.
  assert.match(
    production,
    new RegExp(`<<< APP_URL=https://${PRODUCTION_DOMAIN}`),
  );

  // CI deploys as this account using the profile `clever login` wrote.
  assert.ok(
    calls.includes(
      ">>> gh [secret] [set] [CLEVER_TOKEN] [--env] [staging] [--repo] [acme/field-ops]",
    ),
    `CLEVER_TOKEN not set on staging:\n${calls.join("\n")}`,
  );
  assert.ok(
    calls.includes(
      ">>> gh [secret] [set] [CLEVER_SECRET] [--env] [production] [--repo] [acme/field-ops]",
    ),
    `CLEVER_SECRET not set on production:\n${calls.join("\n")}`,
  );
  assertNoSecretLeaked(result);
});

test("a second --yes run against an existing world creates nothing", () => {
  const result = bootstrap({ args: ["--yes"], world: "full" });
  assert.equal(result.status, 0, result.stderr);
  const calls = mutatingCalls(result.calls).filter(
    // Re-scaling the builder is idempotent on the platform and cheap; it is the one call
    // the script repeats deliberately rather than reading back first.
    (line) => !line.includes("[scale]"),
  );
  assert.deepEqual(
    calls,
    [],
    `expected no mutation, got:\n${calls.join("\n")}`,
  );
  assert.match(result.stdout, /already present/);
  assertNoSecretLeaked(result);
});

test("--rotate replaces existing signing secrets and says signing out is the cost", () => {
  const result = bootstrap({ args: ["--yes", "--rotate"], world: "full" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    mutatingCalls(result.calls).some((line) => line.includes("[env] [import]")),
  );
  assertNoSecretLeaked(result);
});

test("--only runs the named steps and nothing else", () => {
  const result = bootstrap({ args: ["--only", "preflight,apps"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^preflight/m);
  assert.match(result.stdout, /^apps/m);
  assert.match(result.stdout, /^postgres — skipped \(--only\)/m);
  assert.match(result.stdout, /^github-secrets — skipped \(--only\)/m);
});

test("refuses an APP_NAME that does not match the application name", () => {
  const result = bootstrap({ appName: "something-else" });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /the application is named "something-else" in server\/plugins\/config\.ts/,
  );
  assert.deepEqual(mutatingCalls(result.calls), []);
});

test("reads the credentials out of a clever-tools 4.x profile too", () => {
  // The old flat shape. Accepting only one of the two shapes is how this broke: the newer
  // CLI wrote `profiles: [...]`, the script read a top-level `token`, and the refusal it
  // printed told the maintainer to run `clever login` at a CLI that was already logged in.
  const result = bootstrap({
    args: ["--yes", "--only", "github-secrets"],
    world: "full",
    profile: { token: PROFILE_TOKEN, secret: PROFILE_SECRET },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /CLEVER_TOKEN/);
  assertNoSecretLeaked(result);
});

test("refuses an expired profile rather than writing a dead token into CI", () => {
  const result = bootstrap({
    args: ["--yes", "--only", "github-secrets"],
    world: "full",
    profile: {
      version: 1,
      profiles: [
        {
          alias: "default",
          token: PROFILE_TOKEN,
          secret: PROFILE_SECRET,
          expirationDate: new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /expired/i);
  assertNoSecretLeaked(result);
});

test("refuses when the Clever CLI is not logged in, before creating anything", () => {
  const result = bootstrap({ args: ["--yes"], loggedIn: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /clever login/);
  assert.deepEqual(mutatingCalls(result.calls), []);
});

test("refuses to create the production environment with no reviewer", () => {
  const result = bootstrap({
    args: ["--yes"],
    inputs: { ...INPUTS, PRODUCTION_REVIEWERS: "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--allow-unprotected-production/);
});

test("--allow-unprotected-production is the documented way past that refusal", () => {
  const result = bootstrap({
    args: ["--yes", "--allow-unprotected-production"],
    inputs: { ...INPUTS, PRODUCTION_REVIEWERS: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assertNoSecretLeaked(result);
});

test("refuses malformed inputs before touching anything", () => {
  for (const [key, value, expected] of [
    ["APP_NAME", "Not Kebab", /APP_NAME must match/],
    ["GITHUB_REPO", "not-a-repo", /GITHUB_REPO must be owner\/name/],
    ["SEED_PASSWORD", "short", /SEED_PASSWORD must be at least 16/],
    [
      "STAGING_URL",
      "http://insecure.invalid",
      /STAGING_URL must be an https origin/,
    ],
    ["CLEVER_REGION", "atlantis", /CLEVER_REGION must be one of/],
    ["POSTGRES_PLAN", "dev", /POSTGRES_PLAN must be one of/],
    ["TEMPLATE_REPOSITORY", "yes", /TEMPLATE_REPOSITORY must be 0 or 1/],
  ]) {
    const result = bootstrap({
      args: ["--yes"],
      inputs: { ...INPUTS, [key]: value },
      appName: key === "APP_NAME" ? value : undefined,
    });
    assert.notEqual(result.status, 0, `${key}=${value} was accepted`);
    assert.match(result.stderr, expected);
    assert.deepEqual(
      mutatingCalls(result.calls),
      [],
      `${key} mutated something`,
    );
  }
});

test("refuses an unknown --only step and --plan together with --yes", () => {
  const unknown = bootstrap({ args: ["--only", "d1"] });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown --only step/i);

  const both = bootstrap({ args: ["--plan", "--yes"] });
  assert.notEqual(both.status, 0);
});

test("the committed example file yields a fill-in report and exit 0", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bootstrap-guard-example-"));
  scratchDirectories.push(scratch);
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
      path.join(scratch, ".bootstrap.env.example"),
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
  // Exit 0, not a failure: an unfilled example is a starting point, not a mistake, and a
  // non-zero exit here would make `--plan` unusable as the first thing anyone runs.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Fill in these keys/);
  // Every required key is empty in the example, so the report names them all rather than
  // failing on the first one.
  for (const key of [
    "APP_NAME",
    "GITHUB_REPO",
    "GOOGLE_SIGN_IN_CLIENT_ID",
    "ANTHROPIC_API_KEY",
    "SEED_PASSWORD",
  ]) {
    assert.match(result.stdout, new RegExp(key));
  }
  assert.deepEqual(mutatingCalls(readFileSync(log, "utf8")), []);
});

test("the committed example file carries names only", () => {
  const source = readFileSync(
    path.join(repoRoot, ".bootstrap.env.example"),
    "utf8",
  );
  for (const line of source.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    assert.match(line, /^[A-Z_]+=$/, `${line} carries a value`);
  }
  // The credential this migration removed must not come back by accident.
  assert.equal(/CLEVER_TOKEN|CLEVER_SECRET|CLOUDFLARE/.test(source), false);
});
