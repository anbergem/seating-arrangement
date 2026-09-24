#!/usr/bin/env node
// One-shot post-template setup (decision D28, original spec section 43, docs/bootstrap.md).
//
// Every step of the bootstrap that a machine can do, done from one git-ignored input file:
// the two applications and their PostgreSQL add-ons in an EU region, the first deployment when
// an application does not exist yet, application settings per environment, GitHub environments with
// reviewers, GitHub secrets and variables, branch protection and the template flag.
//
// Rules this file obeys, because they are the difference between a convenience and a hazard:
//
//   * Inputs come only from the env file or the process environment, never from the command
//     line — a secret typed as an argument lands in shell history and in `ps` output.
//   * `--plan` is the default and performs read-only calls only. Creating paid or destructive
//     cloud resources requires `--yes` (spec section 43).
//   * Every subprocess is spawned with an argument array and `shell: false`. No string ever
//     reaches a shell, so no value can be interpreted as syntax.
//   * Secret values travel to children on stdin or in the child environment. Everything this
//     script prints — its own lines and every child's output — goes through `redact()` first,
//     so a value cannot reach a terminal, a CI log or a scrollback buffer.
//   * Every step is idempotent and reports `created` / `already present` / `skipped`, so a
//     re-run after a failure is safe and says what it did not have to do again.
//
// Verified against clever-tools and gh 2.98.0 (`tests/guards/bootstrap.test.mjs` drives the
// whole script against stub `npx`, `gh` and `pnpm` executables on a temporary PATH).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { appName } from "./lib/app-identity.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const ENVIRONMENTS = ["staging", "production"];
const GITHUB_ENVIRONMENTS = ["staging", "production"];

const STEPS = [
  "preflight",
  "apps",
  "postgres",
  "app-env",
  "deploy",
  "github-environments",
  "github-secrets",
  "branch-protection",
];

/** Keys that must be present before any step runs. */
const REQUIRED_KEYS = [
  "APP_NAME",
  "GITHUB_REPO",
  "GOOGLE_SIGN_IN_CLIENT_ID",
  "GOOGLE_SIGN_IN_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "SEED_PASSWORD",
];

// Clever Cloud's own zone names. The European ones come first because this template's
// production database is meant to stay in Europe (D04); `parhds` and `grahds` are the
// French health-data-certified zones, there for an application that needs them.
const CLEVER_REGIONS = [
  "par",
  "parhds",
  "rbx",
  "rbxhds",
  "grahds",
  "scw",
  "wsw",
  "ldn",
  "mtl",
  "sgp",
  "syd",
];

// `dev` is free and allows five connections. The framework opens a pool of twenty on a
// long-lived Node server, with no way to configure it down, so `dev` cannot run this
// application at all — measured, not assumed (DISCREPANCIES.md, 2026-09-23). `xxs_sml` is
// the smallest plan that can, and it is the default for that reason.
const POSTGRES_PLANS = ["xxs_sml", "xs_sml", "s_sml", "m_sml"];

const REQUIRED_STATUS_CHECKS = ["CI / verify", "CI / e2e"];

const OPTIONAL_KEYS = [
  // Only for a custom domain. Left empty, each application answers on the
  // `cleverapps.io` name Clever Cloud assigns when it creates it, which bootstrap reads
  // back rather than asking anyone to know it in advance.
  "STAGING_URL",
  "PRODUCTION_URL",
  "CLEVER_ORG",
  "CLEVER_REGION",
  "POSTGRES_PLAN",
  "PRODUCTION_REVIEWERS",
  "TEMPLATE_REPOSITORY",
];

/** Every key whose value must never be printed. */
const SECRET_KEYS = new Set([
  "GOOGLE_SIGN_IN_CLIENT_ID",
  "GOOGLE_SIGN_IN_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "SEED_PASSWORD",
]);

const USAGE = `Usage: node scripts/bootstrap.mjs [options]

  --plan                            Print what would be done and exit 0. The default.
  --yes                             Perform the plan. Creates cloud resources.
  --only <step,...>                 Run a subset: ${STEPS.join(", ")}
  --env-file <path>                 Input file (default .bootstrap.env)
  --allow-unprotected-production    Create the production environment with no reviewers
  --rotate                          Replace secrets that already exist
  --help                            This text

Inputs are read only from the env file and the process environment, never from the command
line. See .bootstrap.env.example and docs/bootstrap.md.`;

// ---------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------

/** @type {Set<string>} */
const secretValues = new Set();

/** Registers a value that must never appear in output. @param {string | undefined} value */
function protect(value) {
  // Very short values would redact half the output; nothing usable as a credential is
  // shorter than this, and the generated signing secrets are 64 hex characters.
  if (typeof value === "string" && value.length >= 8) secretValues.add(value);
}

/**
 * The only way anything leaves this script. Every registered secret value is replaced by
 * `<redacted>` first, so neither our own lines nor a child's output can leak one.
 * @param {string} text
 */
function redact(text) {
  let out = text;
  for (const value of secretValues) out = out.split(value).join("<redacted>");
  return out;
}

/** @param {string} line */
function say(line) {
  console.log(redact(line));
}

/** @param {string} line */
function warn(line) {
  console.error(redact(line));
}

/** @param {string} message */
function refuse(message) {
  console.error(redact(`bootstrap: ${message}`));
  process.exit(1);
}

// ---------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------

/**
 * Minimal dotenv reader: `KEY=value`, `#` comments, optional surrounding quotes. Deliberately
 * not a dependency — one regex is easier to audit than a package.
 * @param {string} contents
 * @returns {Record<string, string>}
 */
function parseEnvFile(contents) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match?.[1]) continue;
    values[match[1]] = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

/**
 * Env file first, process environment as the fallback. An empty value counts as absent so a
 * committed example file never masks a real value exported in the shell.
 * @param {string} envFile
 */
function readInputs(envFile) {
  const absolute = path.isAbsolute(envFile)
    ? envFile
    : path.join(repoRoot, envFile);
  const fromFile = existsSync(absolute)
    ? parseEnvFile(readFileSync(absolute, "utf8"))
    : null;
  if (fromFile === null && envFile !== ".bootstrap.env") {
    refuse(`env file not found: ${envFile}`);
  }
  /** @type {Record<string, string>} */
  const inputs = {};
  for (const key of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) {
    // guard:allow-env-credential — bootstrap's own declared input, redacted before any output
    const value = fromFile?.[key] || process.env[key] || "";
    inputs[key] = value.trim();
    if (SECRET_KEYS.has(key)) protect(inputs[key]);
  }
  return { inputs, envFilePath: absolute, envFileExists: fromFile !== null };
}

/** @param {Record<string, string>} inputs */
function validateInputs(inputs) {
  /** @type {string[]} */
  const problems = [];
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(inputs.APP_NAME)) {
    problems.push("APP_NAME must match ^[a-z][a-z0-9-]{2,40}$");
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(inputs.GITHUB_REPO)) {
    problems.push("GITHUB_REPO must be owner/name");
  }
  // Optional now: Clever Cloud assigns a domain when it creates the application, and
  // bootstrap reads it back. A value here is a custom domain someone already owns.
  for (const key of ["STAGING_URL", "PRODUCTION_URL"]) {
    const value = inputs[key] ?? "";
    if (value !== "" && !/^https:\/\/[^/?#\s]+$/.test(value)) {
      problems.push(
        `${key} must be an https origin with no path or trailing slash`,
      );
    }
  }
  if (
    inputs.STAGING_URL !== "" &&
    inputs.STAGING_URL === inputs.PRODUCTION_URL
  ) {
    problems.push("STAGING_URL and PRODUCTION_URL must differ");
  }
  if (inputs.SEED_PASSWORD.length < 16) {
    problems.push("SEED_PASSWORD must be at least 16 characters");
  }
  if (
    inputs.TEMPLATE_REPOSITORY &&
    !/^[01]$/.test(inputs.TEMPLATE_REPOSITORY)
  ) {
    problems.push("TEMPLATE_REPOSITORY must be 0 or 1 when set");
  }
  if (inputs.CLEVER_REGION && !CLEVER_REGIONS.includes(inputs.CLEVER_REGION)) {
    problems.push(
      `CLEVER_REGION must be one of ${CLEVER_REGIONS.join(", ")} when set`,
    );
  }
  if (inputs.POSTGRES_PLAN && !POSTGRES_PLANS.includes(inputs.POSTGRES_PLAN)) {
    problems.push(
      `POSTGRES_PLAN must be one of ${POSTGRES_PLANS.join(", ")} when set. ` +
        "`dev` is deliberately absent: it allows five connections and the framework opens twenty.",
    );
  }
  return problems;
}

/** The zone every application and add-on is created in. */
function region(inputs) {
  return inputs.CLEVER_REGION || "par";
}

/** The PostgreSQL plan every add-on is created with. */
function postgresPlan(inputs) {
  return inputs.POSTGRES_PLAN || "xxs_sml";
}

/** @param {Record<string, string>} inputs */
function reviewerLogins(inputs) {
  return inputs.PRODUCTION_REVIEWERS.split(",")
    .map((login) => login.trim())
    .filter((login) => login !== "");
}

// ---------------------------------------------------------------------------------------
// Subprocesses
// ---------------------------------------------------------------------------------------

/**
 * Resolves an executable the same way a shell would, then falls back to the repository's own
 * `node_modules/.bin`. PATH wins so `tests/guards/bootstrap.test.mjs` can put stubs in front
 * of the real tools; the fallback means a developer needs no globally installed CLI.
 * @param {string} name
 */
function resolveExecutable(name) {
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
  return existsSync(local) ? local : null;
}

/** @type {Record<string, string | null>} */
const executables = {};

/** @param {string} name */
function executable(name) {
  executables[name] ??= resolveExecutable(name);
  const resolved = executables[name];
  if (!resolved) {
    refuse(
      `\`${name}\` not found on PATH or in node_modules/.bin. Run \`pnpm install\`.`,
    );
  }
  return /** @type {string} */ (resolved);
}

/**
 * The one place a child process is created. `shell: false` is the default for `spawnSync`
 * with an argument array and is stated here so it cannot be lost in an edit.
 * @param {string} name
 * @param {string[]} args
 * @param {{ input?: string, env?: Record<string, string> }} [options]
 */
function run(name, args, options = {}) {
  const result = spawnSync(executable(name), args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    input: options.input,
    env: { ...process.env, ...options.env },
  });
  if (result.error) {
    refuse(
      `${name} ${args.join(" ")} failed to start (${result.error.message})`,
    );
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------

/** @type {{ step: string, what: string, outcome: string, detail?: string }[]} */
const report = [];

/**
 * @param {string} step
 * @param {string} what
 * @param {"created" | "already present" | "skipped" | "updated" | "would create" | "would update" | "ok"} outcome
 * @param {string} [detail]
 */
function record(step, what, outcome, detail) {
  report.push({ step, what, outcome, detail });
  say(`  [${outcome}] ${what}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Prints a mutating command exactly as it would be run, with every secret shown as
 * `<redacted>` — including a value passed on stdin, which is named rather than shown.
 * @param {string} name
 * @param {string[]} args
 * @param {string} [stdinDescription]
 */
function showCommand(name, args, stdinDescription) {
  const rendered = [name, ...args].join(" ");
  say(
    `      $ ${rendered}${stdinDescription ? `   < ${stdinDescription}` : ""}`,
  );
}

// ---------------------------------------------------------------------------------------

/** @param {Context} ctx */
function stepPreflight(ctx) {
  const { inputs } = ctx;
  say("preflight");

  const declared = appName();
  if (declared !== inputs.APP_NAME) {
    refuse(
      `the application is named ${JSON.stringify(declared)} in server/plugins/config.ts but ` +
        `APP_NAME is "${inputs.APP_NAME}". Run \`node scripts/rename-app.mjs --name ` +
        `${inputs.APP_NAME} --display "<Display Name>"\` first, or correct APP_NAME.`,
    );
  }
  record("preflight", `application name is ${inputs.APP_NAME}`, "ok");

  const version = clever(["version"]);
  if (version.status !== 0)
    refuse(
      `\`clever version\` failed. Install the CLI (\`npm i -g clever-tools\`): ${version.stderr.trim()}`,
    );
  record("preflight", "clever-tools", "ok", version.stdout.trim());

  // Authentication is the CLI's own profile, established once by `clever login`. No
  // Clever Cloud credential is ever written to the env file — which is the one thing this
  // arrangement has over the Cloudflare token it replaces. Checked here rather than at the
  // first mutating call, so an unauthenticated run creates nothing before it stops.
  const profile = clever(["profile"]);
  if (profile.status !== 0) {
    refuse(
      "`clever profile` failed: the CLI is not logged in. Run `clever login` (it opens a browser) and try again.",
    );
  }
  record("preflight", "Clever Cloud authentication", "ok");
  record("preflight", "region", "ok", region(inputs));
  record("preflight", "PostgreSQL plan", "ok", postgresPlan(inputs));

  const auth = run("gh", ["auth", "status"]);
  if (auth.status !== 0)
    refuse(
      `\`gh auth status\` failed; run \`gh auth login\`: ${auth.stderr.trim()}`,
    );
  record("preflight", "GitHub authentication", "ok");

  const repo = run("gh", [
    "repo",
    "view",
    inputs.GITHUB_REPO,
    "--json",
    "nameWithOwner,isTemplate,defaultBranchRef",
  ]);
  if (repo.status !== 0) {
    refuse(
      `\`gh repo view ${inputs.GITHUB_REPO}\` failed: ${repo.stderr.trim()}`,
    );
  }
  /** @type {any} */
  let repoJson = {};
  try {
    repoJson = JSON.parse(repo.stdout);
  } catch {
    refuse("`gh repo view --json` did not return JSON");
  }
  ctx.state.isTemplate = repoJson?.isTemplate === true;
  const defaultBranch = repoJson?.defaultBranchRef?.name ?? "main";
  if (defaultBranch !== "main") {
    warn(
      `bootstrap: the default branch is "${defaultBranch}", not "main". Branch protection and ` +
        "the deployment workflows both name `main`; rename the branch or edit them.",
    );
  }
  record(
    "preflight",
    `GitHub repository ${inputs.GITHUB_REPO}`,
    "ok",
    `default branch ${defaultBranch}`,
  );

  ctx.state.built = existsSync(
    path.join(repoRoot, ".output", "server", "index.mjs"),
  );
  record(
    "preflight",
    "built server (.output/server/index.mjs)",
    ctx.state.built ? "ok" : "skipped",
    ctx.state.built
      ? undefined
      : "absent; the deploy step will run `pnpm build`",
  );
}

/**
 * Every `clever` invocation goes through here. `npx --yes` rather than a global install so
 * a fresh machine needs nothing beyond Node, and the CLI's own profile carries the
 * credentials, so nothing is passed in the environment.
 * @param {string[]} args
 * @param {{ input?: string }} [options]
 */
function clever(args, options = {}) {
  return run("npx", ["--yes", "clever-tools@latest", ...args], options);
}

/**
 * Run a `clever` subcommand that is supposed to print JSON, and refuse if it did not.
 *
 * `clever` exits **0** when given an option it does not know, printing its usage text to
 * stdout instead of the data. A `try { JSON.parse } catch { return [] }` around that reads
 * as "the account has none of these", which is the most dangerous possible misreading: the
 * `apps` and `postgres` steps use these lists to decide whether to create. An empty list
 * from a failed call means creating a second copy of something that already exists.
 *
 * The flags are per-subcommand and not consistent — `applications` takes `--json`,
 * `addon list` and `env` take `--format json` — so this has to be verified against the CLI
 * rather than assumed (DISCREPANCIES.md, 2026-09-24).
 *
 * @param {string[]} args
 * @param {string} what what the caller wanted, for the refusal message
 * @returns {any}
 */
function cleverJson(args, what) {
  const result = clever(args);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return refuse(
      `could not read ${what}: \`clever ${args.join(" ")}\` printed no JSON ` +
        `(exit ${result.status}). ${result.stdout.split("\n")[0]?.trim() || result.stderr.trim()}`,
    );
  }
}

/**
 * Every application in the account, not only the ones linked in this checkout.
 *
 * `clever applications` lists what `.clever.json` links, which is empty in a fresh clone and
 * would make this script try to create applications that already exist. `applications list`
 * is the account-wide view, grouped by organisation.
 * @returns {any[]}
 */
function listApps() {
  const groups = cleverJson(
    ["applications", "list", "--format", "json"],
    "the account's applications",
  );
  return (Array.isArray(groups) ? groups : []).flatMap((group) =>
    Array.isArray(group?.applications) ? group.applications : [],
  );
}

/** The aliases this checkout has linked, which is what every `--alias` flag resolves against.
 * @returns {Map<string, string>} alias -> application name */
function linkedAppAliases() {
  const result = clever(["applications", "--json"]);
  /** @type {Map<string, string>} */
  const linked = new Map();
  try {
    // A bare array from `--json`, though `.clever.json` itself nests them under `apps`.
    const parsed = JSON.parse(result.stdout);
    for (const app of Array.isArray(parsed) ? parsed : (parsed?.apps ?? [])) {
      if (app?.alias && app?.name) linked.set(app.alias, app.name);
    }
  } catch {
    // No link file yet is a normal state, not a failure: nothing is linked.
  }
  return linked;
}

/** @returns {any[]} */
function listAddons() {
  const parsed = cleverJson(
    ["addon", "list", "--format", "json"],
    "the account's add-ons",
  );
  return Array.isArray(parsed) ? parsed : [];
}

/** The domain Clever Cloud assigned, which is what `APP_URL` has to be unless the caller
 * supplied a custom one. Read back rather than derived: the assigned name contains the
 * application id, which nobody can know before the application exists.
 * @param {string} environment
 */
function assignedDomain(environment) {
  const result = clever(["domain", "--alias", environment]);
  if (result.status !== 0) return "";
  const first = result.stdout
    .split("\n")
    .map((line) => line.trim().replace(/\/$/, ""))
    .find((line) => line !== "");
  return first ? `https://${first}` : "";
}

/** @param {Context} ctx */
function stepApps(ctx) {
  const { inputs } = ctx;
  say("apps — one Node application per environment");
  const existing = listApps();
  const linked = linkedAppAliases();

  for (const environment of ENVIRONMENTS) {
    const name = `${inputs.APP_NAME}-${environment}`;
    const found = existing.find((app) => app?.name === name);
    if (found) {
      record("apps", `application ${name}`, "already present");
      // Existing in the account is not the same as reachable from here. Every later step
      // addresses applications by `--alias`, which only resolves through `.clever.json`, so
      // an unlinked application would fail the next step with a confusing message about an
      // alias rather than about the link.
      if (linked.get(environment) !== name) {
        if (!ctx.apply) {
          record("apps", `${environment} link`, "would link");
          showCommand("clever", ["link", name, "--alias", environment]);
        } else {
          const relinked = clever([
            "link",
            name,
            "--alias",
            environment,
            ...(inputs.CLEVER_ORG ? ["--org", inputs.CLEVER_ORG] : []),
          ]);
          if (relinked.status !== 0) {
            refuse(
              `\`clever link ${name} --alias ${environment}\` failed: ${relinked.stderr.trim()}`,
            );
          }
          record("apps", `${environment} link`, "linked");
        }
      }
    } else if (!ctx.apply) {
      record("apps", `application ${name}`, "would create", region(inputs));
      showCommand("clever", [
        "create",
        "--type",
        "node",
        name,
        "--region",
        region(inputs),
        "--alias",
        environment,
      ]);
      continue;
    } else {
      const created = clever([
        "create",
        "--type",
        "node",
        name,
        "--region",
        region(inputs),
        "--alias",
        environment,
        ...(inputs.CLEVER_ORG ? ["--org", inputs.CLEVER_ORG] : []),
        "--format",
        "json",
      ]);
      if (created.status !== 0) {
        refuse(`\`clever create ${name}\` failed: ${created.stderr.trim()}`);
      }
      record("apps", `application ${name}`, "created", region(inputs));
    }

    // A thousand-package install is killed by the default builder, which shares the
    // application's own instance. A dedicated build instance is billed per build minute
    // and is the difference between a deploy that works and one that reports
    // `Killed  pnpm install` (DISCREPANCIES.md, 2026-09-23).
    if (ctx.apply) {
      const scaled = clever([
        "scale",
        "--alias",
        environment,
        "--build-flavor",
        "M",
      ]);
      if (scaled.status !== 0) {
        refuse(
          `\`clever scale --build-flavor M\` failed for ${name}: ${scaled.stderr.trim()}`,
        );
      }
      record("apps", `${environment} dedicated build instance`, "ok", "M");
    } else {
      showCommand("clever", [
        "scale",
        "--alias",
        environment,
        "--build-flavor",
        "M",
      ]);
    }

    const url =
      (environment === "staging"
        ? inputs.STAGING_URL
        : inputs.PRODUCTION_URL) ||
      (ctx.apply ? assignedDomain(environment) : "");
    ctx.state.appUrl[environment] = url;
    record(
      "apps",
      `${environment} APP_URL`,
      url ? "ok" : "would read back",
      url || "assigned when the application is created",
    );
  }
}

/** @param {Context} ctx */
function stepPostgres(ctx) {
  const { inputs } = ctx;
  say(
    "postgres — one managed database per environment, linked to its application",
  );
  const existing = listAddons();

  for (const environment of ENVIRONMENTS) {
    const name = `${inputs.APP_NAME}-${environment}-db`;
    const found = existing.find((addon) => addon?.name === name);
    if (found) {
      record("postgres", `database ${name}`, "already present");
    } else if (!ctx.apply) {
      record(
        "postgres",
        `database ${name}`,
        "would create",
        `${postgresPlan(inputs)} in ${region(inputs)}`,
      );
      showCommand("clever", [
        "addon",
        "create",
        "postgresql-addon",
        name,
        "--region",
        region(inputs),
        "--plan",
        postgresPlan(inputs),
        "--yes",
      ]);
    } else {
      // `--format json` prints the connection string and password on stdout. The result is
      // never recorded, never logged and never written anywhere: the application reads the
      // address from the platform variable the link below injects.
      const created = clever([
        "addon",
        "create",
        "postgresql-addon",
        name,
        "--region",
        region(inputs),
        "--plan",
        postgresPlan(inputs),
        "--yes",
      ]);
      if (created.status !== 0) {
        refuse(
          `\`clever addon create ${name}\` failed: ${created.stderr.trim()}`,
        );
      }
      record(
        "postgres",
        `database ${name}`,
        "created",
        `${postgresPlan(inputs)} in ${region(inputs)}`,
      );
    }

    if (!ctx.apply) {
      showCommand("clever", [
        "service",
        "link-addon",
        name,
        "--alias",
        environment,
      ]);
      continue;
    }
    // A linked add-on shows up as `POSTGRESQL_ADDON_URI` among the application's
    // variables, which is the cheapest evidence there is and keeps a second run from
    // reporting a link it did not make.
    if (existingAppEnv(environment)?.POSTGRESQL_ADDON_URI) {
      record("postgres", `${environment} link`, "already present");
      continue;
    }
    const linked = clever([
      "service",
      "link-addon",
      name,
      "--alias",
      environment,
    ]);
    if (linked.status !== 0 && !/already/i.test(linked.stderr)) {
      refuse(
        `\`clever service link-addon ${name}\` failed: ${linked.stderr.trim()}`,
      );
    }
    record(
      "postgres",
      `${environment} link`,
      "ok",
      "POSTGRESQL_ADDON_URI injected",
    );
  }
}

/** The variables an application already has, so a re-run neither regenerates a signing
 * secret nor reports a change it did not make.
 * @param {string} environment
 */
function existingAppEnv(environment) {
  const result = clever(["env", "--alias", environment, "--format", "json"]);
  if (result.status !== 0) return null;
  /** @type {Record<string, string>} */
  const values = {};
  try {
    const parsed = JSON.parse(result.stdout);
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      if (typeof node.name === "string" && "value" in node) {
        values[node.name] = String(node.value ?? "");
      }
      Object.values(node).forEach(walk);
    };
    walk(parsed);
  } catch {
    return null;
  }
  return values;
}

/** @param {Context} ctx */
function stepAppEnv(ctx) {
  const { inputs } = ctx;
  say("app-env — every setting each application needs, secrets on stdin");

  for (const environment of ENVIRONMENTS) {
    const existing = ctx.apply ? existingAppEnv(environment) : {};
    if (existing === null) {
      refuse(
        `\`clever env --alias ${environment}\` failed: the application does not exist yet. Run the \`apps\` step first.`,
      );
    }
    const url = ctx.state.appUrl[environment] || assignedDomain(environment);
    if (ctx.apply && !url) {
      refuse(
        `could not determine the ${environment} application's URL; set ${environment === "staging" ? "STAGING_URL" : "PRODUCTION_URL"} or check \`clever domain\`.`,
      );
    }

    // Generated once and kept. Regenerating a signing secret signs every user of that
    // environment out, so a re-run reuses what is already there unless --rotate says
    // otherwise. The value exists in this process's memory only long enough to reach the
    // CLI on stdin; it is never written to disk.
    const keep = (name) =>
      !ctx.rotate && existing[name]
        ? existing[name]
        : randomBytes(32).toString("hex");

    /** @type {[string, string][]} */
    const values = [
      ["APP_ENV", environment],
      ["NODE_ENV", "production"],
      ["APP_URL", url],
      ["AUTO_CREATE_DEFAULT_ORG", "0"],
      ["AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT", "1"],
      [
        "AUTH_REQUIRE_EMAIL_VERIFICATION",
        environment === "production" ? "1" : "0",
      ],
      ["SEED_ENABLED", environment === "staging" ? "1" : "0"],
      [
        "AGENT_NATIVE_AUDIT_RETENTION_DAYS",
        environment === "production" ? "0" : "365",
      ],
      // Clever Cloud installs production dependencies only, and builds on the server. The
      // build toolchain lives in devDependencies, so without this the build fails on a
      // missing `react-dom/client` (DISCREPANCIES.md, 2026-09-23).
      ["CC_NODE_BUILD_TOOL", "pnpm"],
      ["CC_NODE_DEV_DEPENDENCIES", "install"],
      ["CC_RUN_COMMAND", "pnpm start"],
      ["CC_POST_BUILD_HOOK", "pnpm build"],
      ["BETTER_AUTH_SECRET", keep("BETTER_AUTH_SECRET")],
      ["OAUTH_STATE_SECRET", keep("OAUTH_STATE_SECRET")],
      ["GOOGLE_SIGN_IN_CLIENT_ID", inputs.GOOGLE_SIGN_IN_CLIENT_ID],
      ["GOOGLE_SIGN_IN_CLIENT_SECRET", inputs.GOOGLE_SIGN_IN_CLIENT_SECRET],
      ["ANTHROPIC_API_KEY", inputs.ANTHROPIC_API_KEY],
    ];
    // Staging runs the QA scenario; production is never seeded (B13).
    if (environment === "staging")
      values.push(["SEED_PASSWORD", inputs.SEED_PASSWORD]);
    for (const [name, value] of values) {
      if (SECRET_KEYS.has(name) || name.endsWith("_SECRET")) protect(value);
    }

    if (!ctx.apply) {
      for (const [name] of values) {
        record("app-env", `${environment} ${name}`, "would set");
      }
      showCommand(
        "clever",
        ["env", "import", "--alias", environment],
        "the whole set on stdin",
      );
      continue;
    }

    if (
      !ctx.rotate &&
      values.every(([name, value]) => existing[name] === value)
    ) {
      record("app-env", `${environment} variables`, "already present");
      continue;
    }
    // `import` replaces the manually-set variables as a set, which is what makes this
    // idempotent: one call puts the environment in a known state rather than diffing
    // fifteen. Platform-injected variables (POSTGRESQL_ADDON_*) are untouched by it.
    const body = values.map(([name, value]) => `${name}=${value}`).join("\n");
    const imported = clever(["env", "import", "--alias", environment], {
      input: `${body}\n`,
    });
    if (imported.status !== 0) {
      refuse(
        `\`clever env import --alias ${environment}\` failed: ${imported.stderr.trim()}`,
      );
    }
    record(
      "app-env",
      `${environment} variables`,
      "set",
      `${values.length} of them, secrets on stdin`,
    );
  }
}

/** @param {Context} ctx */
function stepDeploy(ctx) {
  say("deploy — first deployment, only where the application has none");
  say(
    "      Why: the smoke and the seed both need a running application, and later",
  );
  say("      deployments come from GitHub Actions only (docs/deployment.md).");

  for (const environment of ENVIRONMENTS) {
    const activity = clever(["activity", "--alias", environment]);
    const deployed =
      activity.status === 0 && /OK\s+DEPLOY/.test(activity.stdout);
    if (deployed) {
      record(
        "deploy",
        `application ${ctx.inputs.APP_NAME}-${environment}`,
        "already present",
        "has deployments",
      );
      continue;
    }
    if (!ctx.apply) {
      record(
        "deploy",
        `application ${ctx.inputs.APP_NAME}-${environment}`,
        "would deploy",
        "first deployment",
      );
      showCommand("clever", ["deploy", "--alias", environment]);
      continue;
    }
    const result = clever(["deploy", "--alias", environment]);
    if (result.status !== 0) {
      refuse(
        `\`clever deploy --alias ${environment}\` failed: ${result.stderr.trim()}`,
      );
    }
    record(
      "deploy",
      `application ${ctx.inputs.APP_NAME}-${environment}`,
      "deployed",
      "first deployment",
    );
  }
}

/**
 * @param {Context} ctx
 * @param {string} name
 */
function githubEnvironmentExists(ctx, name) {
  const result = run("gh", [
    "api",
    "--method",
    "GET",
    `repos/${ctx.inputs.GITHUB_REPO}/environments/${name}`,
  ]);
  return result.status === 0;
}

/** @param {Context} ctx */
function stepGithubEnvironments(ctx) {
  const { inputs } = ctx;
  say("github-environments");

  const logins = reviewerLogins(inputs);
  /** @type {{ type: "User", id: number }[]} */
  const reviewers = [];

  for (const name of GITHUB_ENVIRONMENTS) {
    if (githubEnvironmentExists(ctx, name)) {
      record(
        "github-environments",
        `environment ${name}`,
        "already present",
        "left exactly as it is",
      );
      continue;
    }

    if (name === "production") {
      if (logins.length === 0 && !ctx.allowUnprotectedProduction) {
        refuse(
          "PRODUCTION_REVIEWERS is empty. A production environment with no required reviewer " +
            "lets any promotion run unattended (D21). Set PRODUCTION_REVIEWERS, or pass " +
            "--allow-unprotected-production if that is genuinely what you want.",
        );
      }
      for (const login of logins) {
        const user = run("gh", ["api", "--method", "GET", `users/${login}`]);
        if (user.status !== 0) {
          refuse(`\`gh api users/${login}\` failed: ${user.stderr.trim()}`);
        }
        /** @type {any} */
        let parsed = {};
        try {
          parsed = JSON.parse(user.stdout);
        } catch {
          refuse(`\`gh api users/${login}\` did not return JSON`);
        }
        if (typeof parsed?.id !== "number") {
          refuse(`\`gh api users/${login}\` returned no numeric id`);
        }
        reviewers.push({ type: "User", id: parsed.id });
      }
    }

    // `reviewers: null` and `deployment_branch_policy: null` are the documented ways to say
    // "no reviewers" and "any branch may deploy"; the workflows restrict the branch
    // themselves (`github.ref == 'refs/heads/main'`).
    const body = {
      wait_timer: 0,
      prevent_self_review: false,
      reviewers:
        name === "production" && reviewers.length > 0 ? reviewers : null,
      deployment_branch_policy: null,
    };
    const json = JSON.stringify(body);
    const detail =
      name === "production"
        ? reviewers.length > 0
          ? `required reviewers: ${logins.join(", ")}`
          : "no reviewers (--allow-unprotected-production)"
        : "no reviewers";

    if (!ctx.apply) {
      record(
        "github-environments",
        `environment ${name}`,
        "would create",
        detail,
      );
      showCommand(
        "gh",
        [
          "api",
          "--method",
          "PUT",
          `repos/${inputs.GITHUB_REPO}/environments/${name}`,
          "--input",
          "-",
        ],
        json,
      );
      continue;
    }
    const created = run(
      "gh",
      [
        "api",
        "--method",
        "PUT",
        `repos/${inputs.GITHUB_REPO}/environments/${name}`,
        "--input",
        "-",
      ],
      { input: json },
    );
    if (created.status !== 0) {
      refuse(
        `creating the ${name} environment failed: ${created.stderr.trim()}`,
      );
    }
    record("github-environments", `environment ${name}`, "created", detail);
  }
}

/**
 * @param {Context} ctx
 * @param {"secret" | "variable"} kind
 * @param {string} environment
 */
function existingGithubNames(ctx, kind, environment) {
  const result = run("gh", [
    kind,
    "list",
    "--env",
    environment,
    "--repo",
    ctx.inputs.GITHUB_REPO,
    "--json",
    "name",
  ]);
  if (result.status !== 0) return new Set();
  try {
    const parsed = JSON.parse(result.stdout);
    return new Set(
      (Array.isArray(parsed) ? parsed : []).map((entry) =>
        String(entry?.name ?? ""),
      ),
    );
  } catch {
    return new Set();
  }
}

/**
 * The token and secret `clever login` stored, so CI can act as this account. Read from the
 * CLI's own configuration rather than asked for: the interactive login already produced
 * them, and asking again would put a credential in the env file this migration was able to
 * remove.
 */
function cleverProfileCredentials() {
  const candidates = [
    path.join(
      process.env.HOME ?? "", // guard:allow-env-credential — home directory, not a credential
      ".config",
      "clever-cloud",
      "clever-tools.json",
    ),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      // Two shapes. clever-tools 5.x writes `{ version, profiles: [{ alias, token, secret,
      // expirationDate }] }`; older versions wrote the credentials flat. Reading only the
      // flat one failed with "run `clever login` first" against a CLI that was perfectly
      // well logged in — the message named the wrong cause (DISCREPANCIES.md, 2026-09-24).
      const profiles = Array.isArray(parsed?.profiles)
        ? parsed.profiles
        : [parsed];
      const wanted = (process.env.CLEVER_PROFILE ?? "").trim(); // guard:allow-env-credential — a profile alias, not a credential
      const chosen =
        (wanted && profiles.find((p) => p?.alias === wanted)) ||
        profiles.find((p) => p?.alias === "default") ||
        (profiles.length === 1 ? profiles[0] : undefined);
      if (!chosen) {
        return refuse(
          `the Clever Cloud CLI profile holds ${profiles.length} profiles and none is named "default". ` +
            `Set CLEVER_PROFILE to the alias to use.`,
        );
      }
      const expiry = Date.parse(String(chosen?.expirationDate ?? ""));
      if (Number.isFinite(expiry) && expiry <= Date.now()) {
        return refuse(
          "the Clever Cloud CLI profile has expired. Run `clever login` again — an expired " +
            "token would be written into the GitHub secrets and fail every deployment.",
        );
      }
      const token = String(chosen?.token ?? "");
      const secret = String(chosen?.secret ?? "");
      if (token && secret) {
        protect(token);
        protect(secret);
        return { token, secret };
      }
    } catch {
      // Fall through to the refusal below: an unreadable profile is the same as none.
    }
  }
  return refuse(
    "could not read the Clever Cloud CLI profile (~/.config/clever-cloud/clever-tools.json). Run `clever login` first.",
  );
}

/** @param {Context} ctx */
function stepGithubSecrets(ctx) {
  const { inputs } = ctx;
  say("github-secrets — what the workflows themselves need, nothing more");

  // The CLI's own profile, so CI can deploy as this account without anyone pasting a
  // token. `clever login` wrote it; bootstrap copies it into the two GitHub secrets the
  // workflows read, and nothing else ever reads the file.
  const profile = cleverProfileCredentials();

  /** @type {Record<string, { secrets: [string, string][], variables: [string, string][] }>} */
  const wanted = {
    staging: {
      secrets: [
        ["CLEVER_TOKEN", profile.token],
        ["CLEVER_SECRET", profile.secret],
        ["SEED_PASSWORD", inputs.SEED_PASSWORD],
      ],
      variables: [
        ["STAGING_URL", ctx.state.appUrl.staging || inputs.STAGING_URL],
        ["CLEVER_APP_NAME", `${inputs.APP_NAME}-staging`],
      ],
    },
    production: {
      secrets: [
        ["CLEVER_TOKEN", profile.token],
        ["CLEVER_SECRET", profile.secret],
      ],
      variables: [
        [
          "PRODUCTION_URL",
          ctx.state.appUrl.production || inputs.PRODUCTION_URL,
        ],
        ["CLEVER_APP_NAME", `${inputs.APP_NAME}-production`],
      ],
    },
  };

  for (const environment of GITHUB_ENVIRONMENTS) {
    const plan = wanted[environment];
    const secrets = existingGithubNames(ctx, "secret", environment);
    const variables = existingGithubNames(ctx, "variable", environment);

    for (const [kind, entries, present] of /** @type {const} */ ([
      ["secret", plan.secrets, secrets],
      ["variable", plan.variables, variables],
    ])) {
      for (const [name, value] of entries) {
        if (value === "") {
          record(
            "github-secrets",
            `${environment} ${kind} ${name}`,
            "skipped",
            "not configured",
          );
          continue;
        }
        if (present.has(name) && !ctx.rotate) {
          record(
            "github-secrets",
            `${environment} ${kind} ${name}`,
            "already present",
            "pass --rotate to replace",
          );
          continue;
        }
        const args = [
          kind,
          "set",
          name,
          "--env",
          environment,
          "--repo",
          inputs.GITHUB_REPO,
        ];
        if (!ctx.apply) {
          record(
            "github-secrets",
            `${environment} ${kind} ${name}`,
            "would create",
          );
          showCommand(
            "gh",
            args,
            kind === "secret" ? "<redacted> on stdin" : `${value} on stdin`,
          );
          continue;
        }
        const set = run("gh", args, { input: value });
        if (set.status !== 0) {
          refuse(
            `\`gh ${kind} set ${name} --env ${environment}\` failed: ${set.stderr.trim()}`,
          );
        }
        record(
          "github-secrets",
          `${environment} ${kind} ${name}`,
          present.has(name) ? "updated" : "created",
        );
      }
    }
  }
}

/** @param {Context} ctx */
function stepBranchProtection(ctx) {
  const { inputs } = ctx;
  say("branch-protection");

  const body = {
    // `strict: false`: requiring the branch to be current before merge is a preference, not a
    // safety property, and it serialises merges on a small team (docs/repository-settings.md).
    required_status_checks: { strict: false, contexts: REQUIRED_STATUS_CHECKS },
    // `null` leaves the "include administrators" box as GitHub's default rather than forcing
    // it either way; the maintainer of a one-person repository needs a way out.
    enforce_admins: null,
    // A non-null object is what makes a pull request required at all. Zero approvals, because
    // a solo maintainer cannot approve their own pull request.
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
  const json = JSON.stringify(body);
  const endpoint = `repos/${inputs.GITHUB_REPO}/branches/main/protection`;

  const current = run("gh", ["api", "--method", "GET", endpoint]);
  let satisfied = false;
  if (current.status === 0) {
    try {
      /** @type {any} */
      const parsed = JSON.parse(current.stdout);
      const contexts = parsed?.required_status_checks?.contexts ?? [];
      satisfied =
        REQUIRED_STATUS_CHECKS.every((check) => contexts.includes(check)) &&
        parsed?.required_pull_request_reviews !== undefined &&
        parsed?.allow_force_pushes?.enabled === false &&
        parsed?.allow_deletions?.enabled === false;
    } catch {
      satisfied = false;
    }
  }

  if (satisfied) {
    record(
      "branch-protection",
      "main",
      "already present",
      REQUIRED_STATUS_CHECKS.join(", "),
    );
  } else if (!ctx.apply) {
    record(
      "branch-protection",
      "main",
      current.status === 0 ? "would update" : "would create",
      REQUIRED_STATUS_CHECKS.join(", "),
    );
    showCommand(
      "gh",
      ["api", "--method", "PUT", endpoint, "--input", "-"],
      json,
    );
  } else {
    const put = run(
      "gh",
      ["api", "--method", "PUT", endpoint, "--input", "-"],
      { input: json },
    );
    if (put.status !== 0) {
      refuse(`branch protection on main failed: ${put.stderr.trim()}`);
    }
    record(
      "branch-protection",
      "main",
      current.status === 0 ? "updated" : "created",
    );
  }

  if (inputs.TEMPLATE_REPOSITORY !== "1") {
    record(
      "branch-protection",
      "template repository flag",
      "skipped",
      "TEMPLATE_REPOSITORY is not 1",
    );
  } else if (ctx.state.isTemplate) {
    record("branch-protection", "template repository flag", "already present");
  } else if (!ctx.apply) {
    record("branch-protection", "template repository flag", "would create");
    showCommand("gh", ["repo", "edit", inputs.GITHUB_REPO, "--template"]);
  } else {
    const edit = run("gh", ["repo", "edit", inputs.GITHUB_REPO, "--template"]);
    if (edit.status !== 0) {
      refuse(`\`gh repo edit --template\` failed: ${edit.stderr.trim()}`);
    }
    record("branch-protection", "template repository flag", "created");
  }
}

/** @param {Context} ctx */
function printManualChecklist(ctx) {
  const { inputs } = ctx;
  say("");
  say(
    "Not automatable — do these by hand (docs/bootstrap.md has the click paths):",
  );
  say(
    "  1. Create a Clever Cloud account and add a payment method. The PostgreSQL plan this",
  );
  say(
    "     script uses is not free: the free `dev` plan allows five connections and the",
  );
  say("     framework opens twenty, so it cannot run this application at all.");
  say(
    "  2. Run `clever login` once. It opens a browser and stores a profile that this",
  );
  say(
    "     script reads; no Clever Cloud credential ever goes in the env file.",
  );
  say(
    "  3. Create the Google OAuth client (Web application, internal consent screen) with",
  );
  say("     these authorized redirect URIs:");
  const staging =
    ctx.state.appUrl.staging || inputs.STAGING_URL || "<staging url>";
  const production =
    ctx.state.appUrl.production || inputs.PRODUCTION_URL || "<production url>";
  say(`       ${staging}/_agent-native/google/callback`);
  say(`       ${production}/_agent-native/google/callback`);
  say(
    "     The URLs are assigned when the applications are created, so this step comes",
  );
  say("     after the first run rather than before it.");
  say("  4. Install the Renovate GitHub App on the repository (D22).");
  say(
    "  5. Sign in once with Google on staging, then create the organization and its owner:",
  );
  say(
    `       node scripts/bootstrap-org.mjs --env staging --name "<Org>" --owner <email>`,
  );
  say(
    '  6. Turn on "require Google sign-in" for that organization on the Team page (D11).',
  );
  say("");
  say(
    ctx.apply
      ? "Done. Nothing in the repository changed — the applications, their databases and their settings all live on Clever Cloud. Follow docs/bootstrap.md from step 11."
      : "This was a plan. Nothing was created. Re-run with --yes to perform it.",
  );
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        plan: { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        only: { type: "string" },
        "env-file": { type: "string", default: ".bootstrap.env" },
        "allow-unprotected-production": { type: "boolean", default: false },
        rotate: { type: "boolean", default: false },
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

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.plan && values.yes)
    refuse("--plan and --yes are mutually exclusive");

  /** @type {Set<string>} */
  const selected = new Set(STEPS);
  if (values.only !== undefined) {
    const names = values.only
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const unknown = names.filter((name) => !STEPS.includes(name));
    if (unknown.length > 0) {
      refuse(
        `unknown --only step(s): ${unknown.join(", ")}. Known: ${STEPS.join(", ")}`,
      );
    }
    selected.clear();
    for (const name of names) selected.add(name);
  }

  const envFile = values["env-file"] ?? ".bootstrap.env";
  const { inputs, envFilePath, envFileExists } = readInputs(envFile);
  const apply = values.yes === true;

  say(
    `bootstrap: ${apply ? "APPLY (--yes)" : "PLAN (read-only)"} from ${path.relative(repoRoot, envFilePath) || envFile}`,
  );
  if (!envFileExists) {
    say(
      `bootstrap: ${envFile} does not exist; reading the process environment only.`,
    );
  }
  say("");

  const missing = REQUIRED_KEYS.filter((key) => inputs[key] === "");
  if (missing.length > 0) {
    // Exit 0 in plan mode: "you have not filled the file in yet" is the expected state of a
    // freshly copied `.bootstrap.env`, not a failure. `--yes` refuses.
    const stream = apply ? console.error : console.log;
    stream("Fill in these keys before this script can do anything:");
    for (const key of missing) stream(`  ${key}`);
    stream("");
    if (envFile === ".bootstrap.env.example") {
      // The committed example carries names only, so this is its expected output: it is what
      // the acceptance check in docs/plan/tasks/T24-bootstrap.md runs.
      stream("  cp .bootstrap.env.example .bootstrap.env");
      stream("  # edit .bootstrap.env, then:");
      stream("  node scripts/bootstrap.mjs --plan");
    } else {
      stream(`  cp .bootstrap.env.example ${envFile}`);
      stream(`  # edit ${envFile}, then:`);
      stream(`  node scripts/bootstrap.mjs --plan --env-file ${envFile}`);
    }
    stream("");
    stream(
      "Every key is documented in .bootstrap.env.example and docs/bootstrap.md.",
    );
    process.exit(apply ? 1 : 0);
  }

  const problems = validateInputs(inputs);
  if (problems.length > 0) {
    for (const problem of problems) warn(`bootstrap: ${problem}`);
    process.exit(1);
  }

  /** @type {Context} */
  const ctx = {
    inputs,
    apply,
    rotate: values.rotate === true,
    allowUnprotectedProduction: values["allow-unprotected-production"] === true,
    selected,
    state: {
      appUrl: {},
      isTemplate: false,
      built: false,
    },
  };

  /** @type {Record<string, (ctx: Context) => void>} */
  const runners = {
    preflight: stepPreflight,
    apps: stepApps,
    postgres: stepPostgres,
    "app-env": stepAppEnv,
    deploy: stepDeploy,
    "github-environments": stepGithubEnvironments,
    "github-secrets": stepGithubSecrets,
    "branch-protection": stepBranchProtection,
  };

  for (const step of STEPS) {
    if (!selected.has(step)) {
      say(`${step} — skipped (--only)`);
      continue;
    }
    runners[step](ctx);
    say("");
  }

  printManualChecklist(ctx);
}

main();
