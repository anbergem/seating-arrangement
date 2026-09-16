#!/usr/bin/env node
// One-shot post-template setup (decision D28, original spec section 43, docs/bootstrap.md).
//
// Every step of the bootstrap that a machine can do, done from one git-ignored input file:
// D1 databases in the EU jurisdiction, the Wrangler ids and URLs, the first deployment when
// a Worker does not exist yet, Worker secrets per environment, GitHub environments with
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
// Verified against wrangler 4.129.0 and gh 2.98.0 (`tests/guards/bootstrap.test.mjs` drives
// the whole script against stub `wrangler`, `gh` and `pnpm` executables on a temporary PATH).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseJsonc } from "./lib/jsonc.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const ENVIRONMENTS = ["staging", "production"];
const GITHUB_ENVIRONMENTS = ["staging", "production", "production-backup"];
const REQUIRED_STATUS_CHECKS = ["CI / verify", "CI / worker", "CI / e2e"];

const STEPS = [
  "preflight",
  "d1",
  "deploy",
  "worker-secrets",
  "github-environments",
  "github-secrets",
  "branch-protection",
];

/** Keys that must be present before any step runs. */
const REQUIRED_KEYS = [
  "APP_NAME",
  "GITHUB_REPO",
  "STAGING_URL",
  "PRODUCTION_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "GOOGLE_SIGN_IN_CLIENT_ID",
  "GOOGLE_SIGN_IN_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "SEED_PASSWORD",
];

const OPTIONAL_KEYS = [
  "PRODUCTION_REVIEWERS",
  "TEMPLATE_REPOSITORY",
  "BACKUP_AGE_RECIPIENT",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_SECRET_ACCESS_KEY",
  "BACKUP_S3_REGION",
  "BACKUP_S3_PREFIX",
];

/** Every key whose value must never be printed. */
const SECRET_KEYS = new Set([
  "CLOUDFLARE_API_TOKEN",
  "GOOGLE_SIGN_IN_CLIENT_ID",
  "GOOGLE_SIGN_IN_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "SEED_PASSWORD",
  "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_SECRET_ACCESS_KEY",
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
  for (const key of ["STAGING_URL", "PRODUCTION_URL"]) {
    const value = inputs[key] ?? "";
    if (!/^https:\/\/[^/?#\s]+$/.test(value)) {
      problems.push(
        `${key} must be an https origin with no path or trailing slash`,
      );
    }
  }
  if (inputs.STAGING_URL === inputs.PRODUCTION_URL) {
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
  const s3 = [
    "BACKUP_S3_BUCKET",
    "BACKUP_S3_ENDPOINT",
    "BACKUP_S3_ACCESS_KEY_ID",
    "BACKUP_S3_SECRET_ACCESS_KEY",
  ];
  const s3Present = s3.filter((key) => inputs[key] !== "");
  if (s3Present.length > 0 && s3Present.length < s3.length) {
    problems.push(
      `S3 backup upload needs all of ${s3.join(", ")} or none of them`,
    );
  }
  return problems;
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
 * of the real tools; the fallback means a developer needs no globally installed wrangler.
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

/**
 * The token has to reach `wrangler`, and the only channel that is not a file and not an
 * argument is the child environment.
 * @param {Record<string, string>} inputs
 */
function cloudflareEnv(inputs) {
  return {
    CLOUDFLARE_API_TOKEN: inputs.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: inputs.CLOUDFLARE_ACCOUNT_ID,
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
// wrangler.jsonc, edited as text
// ---------------------------------------------------------------------------------------

const wranglerPath = path.join(repoRoot, "wrangler.jsonc");

/** @returns {string} */
function readWrangler() {
  if (!existsSync(wranglerPath)) refuse("wrangler.jsonc not found");
  return readFileSync(wranglerPath, "utf8");
}

/**
 * The `{ ... }` span of one `env.<name>` block, found by string-aware brace matching so a
 * brace inside a comment or a string cannot end it early.
 * @param {string} source
 * @param {string} environment
 * @returns {{ start: number, end: number }}
 */
function environmentBlock(source, environment) {
  const envKey = /"env"\s*:\s*\{/.exec(source);
  if (!envKey?.index) refuse('wrangler.jsonc has no top-level "env" object');
  const search = new RegExp(`"${environment}"\\s*:\\s*\\{`, "g");
  search.lastIndex = /** @type {number} */ (envKey.index);
  const opening = search.exec(source);
  if (!opening) refuse(`wrangler.jsonc has no env.${environment} block`);
  const start =
    /** @type {RegExpExecArray} */ (opening).index +
    /** @type {RegExpExecArray} */ (opening)[0].length -
    1;
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  return refuse(`wrangler.jsonc env.${environment} block is not closed`);
}

/**
 * Replaces the first `"key": "…"` value inside one environment block, leaving every comment,
 * every blank line and the surrounding formatting exactly as it was.
 * @param {string} source
 * @param {string} environment
 * @param {string} key
 * @param {string} value
 * @returns {{ source: string, changed: boolean, previous: string }}
 */
function setEnvironmentString(source, environment, key, value) {
  const { start, end } = environmentBlock(source, environment);
  const block = source.slice(start, end);
  const pattern = new RegExp(`("${key}"\\s*:\\s*")([^"]*)(")`);
  const match = pattern.exec(block);
  if (!match) {
    return refuse(
      `wrangler.jsonc env.${environment} has no "${key}" string to set`,
    );
  }
  const previous = match[2] ?? "";
  if (previous === value) return { source, changed: false, previous };
  const updatedBlock =
    block.slice(0, match.index) +
    match[1] +
    value +
    match[3] +
    block.slice(match.index + match[0].length);
  return {
    source: source.slice(0, start) + updatedBlock + source.slice(end),
    changed: true,
    previous,
  };
}

/**
 * Re-parses the edited file with the reader `scripts/check-config-hygiene.mjs` uses and
 * asserts the value actually landed where it was meant to. An in-place text edit that
 * produced unparseable JSONC, or wrote into the wrong block, fails here rather than at the
 * next `wrangler deploy`.
 * @param {string} source
 * @param {string} environment
 * @param {(env: Record<string, any>) => unknown} pick
 * @param {string} expected
 * @param {string} label
 */
function verifyWrangler(source, environment, pick, expected, label) {
  /** @type {any} */
  let parsed;
  try {
    parsed = parseJsonc(source);
  } catch (error) {
    refuse(
      `the wrangler.jsonc edit is not parseable (${error}); nothing was written`,
    );
  }
  const block = parsed?.env?.[environment];
  if (!block)
    refuse(
      `the wrangler.jsonc edit lost env.${environment}; nothing was written`,
    );
  const actual = pick(block);
  if (actual !== expected) {
    refuse(
      `the wrangler.jsonc edit did not set env.${environment} ${label} (found ${JSON.stringify(actual)}); nothing was written`,
    );
  }
}

/** @param {string} environment */
function currentWranglerValues(environment) {
  /** @type {any} */
  const parsed = parseJsonc(readWrangler());
  const block = parsed?.env?.[environment] ?? {};
  return {
    databaseId: block?.d1_databases?.[0]?.database_id ?? "",
    appUrl: block?.vars?.APP_URL ?? "",
  };
}

// ---------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------

/**
 * @typedef {{
 *   inputs: Record<string, string>,
 *   apply: boolean,
 *   rotate: boolean,
 *   allowUnprotectedProduction: boolean,
 *   selected: Set<string>,
 *   state: {
 *     workerExists: Record<string, boolean>,
 *     deploymentNeeded: Record<string, boolean>,
 *     isTemplate: boolean,
 *     built: boolean,
 *   },
 * }} Context
 */

/** @param {Context} ctx */
function stepPreflight(ctx) {
  const { inputs } = ctx;
  say("preflight");

  /** @type {any} */
  const wrangler = parseJsonc(readWrangler());
  if (wrangler?.name !== inputs.APP_NAME) {
    refuse(
      `wrangler.jsonc top-level "name" is ${JSON.stringify(wrangler?.name)} but APP_NAME is ` +
        `"${inputs.APP_NAME}". Run \`node scripts/rename-app.mjs --name ${inputs.APP_NAME} ` +
        `--display "<Display Name>"\` first, or correct APP_NAME.`,
    );
  }
  record("preflight", `wrangler.jsonc name is ${inputs.APP_NAME}`, "ok");

  const version = run("wrangler", ["--version"], {
    env: cloudflareEnv(inputs),
  });
  if (version.status !== 0)
    refuse(`wrangler --version failed: ${version.stderr.trim()}`);
  record(
    "preflight",
    "wrangler",
    "ok",
    version.stdout.trim().split("\n").pop(),
  );

  const whoami = run("wrangler", ["whoami", "--json"], {
    env: cloudflareEnv(inputs),
  });
  if (whoami.status !== 0) {
    refuse(
      "`wrangler whoami` failed with the supplied CLOUDFLARE_API_TOKEN. Check the token's " +
        `permissions (Workers Scripts:Edit, D1:Edit) and CLOUDFLARE_ACCOUNT_ID: ${whoami.stderr.trim()}`,
    );
  }
  record("preflight", "Cloudflare authentication", "ok");

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

  ctx.state.built = existsSync(path.join(repoRoot, "dist", "BUILD_INFO.json"));
  record(
    "preflight",
    "built Worker bundle (dist/BUILD_INFO.json)",
    ctx.state.built ? "ok" : "skipped",
    ctx.state.built
      ? undefined
      : "absent; the deploy step will run `pnpm build:worker`",
  );
}

/** @param {Context} ctx */
function listDatabases(ctx) {
  const result = run("wrangler", ["d1", "list", "--json"], {
    env: cloudflareEnv(ctx.inputs),
  });
  if (result.status !== 0)
    refuse(`\`wrangler d1 list --json\` failed: ${result.stderr.trim()}`);
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return refuse("`wrangler d1 list --json` did not return a JSON array");
  }
}

/** @param {Context} ctx */
function stepD1(ctx) {
  const { inputs } = ctx;
  say("d1 — databases, ids and APP_URL");
  let databases = listDatabases(ctx);

  for (const environment of ENVIRONMENTS) {
    const name = `${inputs.APP_NAME}-${environment}`;
    let existing = databases.find((database) => database?.name === name);
    if (existing) {
      record(
        "d1",
        `database ${name}`,
        "already present",
        `id ${existing.uuid}`,
      );
    } else if (!ctx.apply) {
      record("d1", `database ${name}`, "would create", "EU jurisdiction");
      showCommand("wrangler", ["d1", "create", name, "--jurisdiction", "eu"]);
    } else {
      const created = run(
        "wrangler",
        ["d1", "create", name, "--jurisdiction", "eu"],
        {
          env: cloudflareEnv(inputs),
        },
      );
      if (created.status !== 0) {
        refuse(
          `\`wrangler d1 create ${name}\` failed: ${created.stderr.trim()}`,
        );
      }
      databases = listDatabases(ctx);
      existing = databases.find((database) => database?.name === name);
      if (!existing?.uuid) {
        refuse(
          `created ${name} but \`wrangler d1 list --json\` does not report its id`,
        );
      }
      record("d1", `database ${name}`, "created", `id ${existing.uuid}`);
    }

    const appUrl =
      environment === "staging" ? inputs.STAGING_URL : inputs.PRODUCTION_URL;
    const current = currentWranglerValues(environment);
    const databaseId = existing?.uuid ?? current.databaseId;

    if (!existing && !ctx.apply) {
      record(
        "d1",
        `wrangler.jsonc env.${environment}.database_id`,
        "would update",
        "id known only after creation",
      );
    } else if (current.databaseId === databaseId) {
      record(
        "d1",
        `wrangler.jsonc env.${environment}.database_id`,
        "already present",
      );
    } else if (!ctx.apply) {
      record(
        "d1",
        `wrangler.jsonc env.${environment}.database_id`,
        "would update",
        `${current.databaseId} -> ${databaseId}`,
      );
    } else {
      let source = readWrangler();
      const edit = setEnvironmentString(
        source,
        environment,
        "database_id",
        databaseId,
      );
      verifyWrangler(
        edit.source,
        environment,
        (block) => block?.d1_databases?.[0]?.database_id,
        databaseId,
        "database_id",
      );
      writeFileSync(wranglerPath, edit.source);
      record(
        "d1",
        `wrangler.jsonc env.${environment}.database_id`,
        "updated",
        `${edit.previous} -> ${databaseId}`,
      );
    }

    const afterId = currentWranglerValues(environment);
    if (afterId.appUrl === appUrl) {
      record(
        "d1",
        `wrangler.jsonc env.${environment}.vars.APP_URL`,
        "already present",
        appUrl,
      );
    } else if (!ctx.apply) {
      record(
        "d1",
        `wrangler.jsonc env.${environment}.vars.APP_URL`,
        "would update",
        `${afterId.appUrl} -> ${appUrl}`,
      );
    } else {
      const source = readWrangler();
      const edit = setEnvironmentString(source, environment, "APP_URL", appUrl);
      verifyWrangler(
        edit.source,
        environment,
        (block) => block?.vars?.APP_URL,
        appUrl,
        "vars.APP_URL",
      );
      writeFileSync(wranglerPath, edit.source);
      record(
        "d1",
        `wrangler.jsonc env.${environment}.vars.APP_URL`,
        "updated",
        `${edit.previous} -> ${appUrl}`,
      );
    }
  }

  if (ctx.apply) {
    say(
      "      commit the changed wrangler.jsonc: the deployment workflows read it from git.",
    );
  }
}

/**
 * A Worker that has never been deployed has no secrets store, so `wrangler secret put` fails
 * on it. `wrangler deployments list` is the cheapest way to ask: a missing Worker makes it
 * exit non-zero, and a Worker that exists but was never deployed returns an empty array.
 * @param {Context} ctx
 * @param {string} environment
 */
function deploymentsPresent(ctx, environment) {
  const result = run(
    "wrangler",
    ["deployments", "list", "--env", environment, "--json"],
    {
      env: cloudflareEnv(ctx.inputs),
    },
  );
  if (result.status !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed.length > 0 : Boolean(parsed);
  } catch {
    return false;
  }
}

/** @param {Context} ctx */
function stepDeploy(ctx) {
  const { inputs } = ctx;
  say("deploy — first deployment, only where the Worker does not exist yet");
  say(
    "      Why: `wrangler secret put` needs the Worker to exist, so the very first deployment",
  );
  say(
    "      has to happen before any secret can be stored. Later deployments come from GitHub",
  );
  say("      Actions only (docs/deployment.md).");

  for (const environment of ENVIRONMENTS) {
    const present = deploymentsPresent(ctx, environment);
    ctx.state.workerExists[environment] = present;
    ctx.state.deploymentNeeded[environment] = !present;
    if (present) {
      record(
        "deploy",
        `Worker ${inputs.APP_NAME}-${environment}`,
        "already present",
        "has deployments",
      );
      continue;
    }
    if (!ctx.apply) {
      record(
        "deploy",
        `Worker ${inputs.APP_NAME}-${environment}`,
        "would create",
        "first deployment",
      );
      if (!ctx.state.built) showCommand("pnpm", ["build:worker"]);
      showCommand("wrangler", ["deploy", "--env", environment]);
      continue;
    }
    if (!ctx.state.built) {
      const build = run("pnpm", ["build:worker"]);
      if (build.status !== 0) {
        refuse(
          `\`pnpm build:worker\` failed:\n${build.stdout}\n${build.stderr}`,
        );
      }
      ctx.state.built = true;
      record("deploy", "pnpm build:worker", "ok");
    }
    const deployed = run("wrangler", ["deploy", "--env", environment], {
      env: cloudflareEnv(inputs),
    });
    if (deployed.status !== 0) {
      refuse(
        `\`wrangler deploy --env ${environment}\` failed: ${deployed.stderr.trim()}`,
      );
    }
    ctx.state.workerExists[environment] = true;
    record(
      "deploy",
      `Worker ${inputs.APP_NAME}-${environment}`,
      "created",
      "first deployment",
    );
  }
}

/**
 * @param {Context} ctx
 * @param {string} environment
 */
function existingWorkerSecrets(ctx, environment) {
  const result = run(
    "wrangler",
    ["secret", "list", "--env", environment, "--format", "json"],
    {
      env: cloudflareEnv(ctx.inputs),
    },
  );
  if (result.status !== 0) return null;
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

/** @param {Context} ctx */
function stepWorkerSecrets(ctx) {
  const { inputs } = ctx;
  say("worker-secrets — one set per environment, never shared between them");

  for (const environment of ENVIRONMENTS) {
    // A generated signing secret is created per environment and never written to disk: it
    // exists in this process's memory only long enough to reach `wrangler` on stdin.
    /** @type {[string, string][]} */
    const values = [
      ["BETTER_AUTH_SECRET", randomBytes(32).toString("hex")],
      ["OAUTH_STATE_SECRET", randomBytes(32).toString("hex")],
      ["GOOGLE_SIGN_IN_CLIENT_ID", inputs.GOOGLE_SIGN_IN_CLIENT_ID],
      ["GOOGLE_SIGN_IN_CLIENT_SECRET", inputs.GOOGLE_SIGN_IN_CLIENT_SECRET],
      ["ANTHROPIC_API_KEY", inputs.ANTHROPIC_API_KEY],
    ];
    // Staging runs the QA scenario; production is never seeded (B13).
    if (environment === "staging")
      values.push(["SEED_PASSWORD", inputs.SEED_PASSWORD]);
    for (const [, value] of values) protect(value);

    const existing = existingWorkerSecrets(ctx, environment);
    if (existing === null) {
      const needed = ctx.state.deploymentNeeded[environment];
      if (ctx.apply) {
        refuse(
          `\`wrangler secret list --env ${environment}\` failed: the Worker ` +
            `${inputs.APP_NAME}-${environment} does not exist yet. ` +
            (needed === false
              ? "Check the token's Workers Scripts permission."
              : "Run the `deploy` step first (do not exclude it with --only)."),
        );
      }
      record(
        "worker-secrets",
        `secrets for ${environment}`,
        "would create",
        "the Worker does not exist yet",
      );
      for (const [name] of values) {
        showCommand(
          "wrangler",
          ["secret", "put", name, "--env", environment],
          "<redacted> on stdin",
        );
      }
      continue;
    }

    for (const [name, value] of values) {
      const present = existing.has(name);
      const signing =
        name === "BETTER_AUTH_SECRET" || name === "OAUTH_STATE_SECRET";
      if (present && !ctx.rotate) {
        record(
          "worker-secrets",
          `${environment} ${name}`,
          "already present",
          "pass --rotate to replace",
        );
        continue;
      }
      if (!ctx.apply) {
        record(
          "worker-secrets",
          `${environment} ${name}`,
          "would create",
          signing ? "generated, 32 random bytes as hex" : "from the env file",
        );
        showCommand(
          "wrangler",
          ["secret", "put", name, "--env", environment],
          "<redacted> on stdin",
        );
        continue;
      }
      if (present && signing) {
        warn(
          `bootstrap: rotating ${name} on ${environment} signs every user of that environment out.`,
        );
      }
      const put = run(
        "wrangler",
        ["secret", "put", name, "--env", environment],
        {
          input: value,
          env: cloudflareEnv(inputs),
        },
      );
      if (put.status !== 0) {
        refuse(
          `\`wrangler secret put ${name} --env ${environment}\` failed: ${put.stderr.trim()}`,
        );
      }
      record(
        "worker-secrets",
        `${environment} ${name}`,
        present ? "updated" : "created",
      );
    }
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

/** @param {Context} ctx */
function stepGithubSecrets(ctx) {
  const { inputs } = ctx;
  say("github-secrets — what the workflows themselves need, nothing more");

  /** @type {Record<string, { secrets: [string, string][], variables: [string, string][] }>} */
  const wanted = {
    staging: {
      secrets: [
        ["CLOUDFLARE_API_TOKEN", inputs.CLOUDFLARE_API_TOKEN],
        ["CLOUDFLARE_ACCOUNT_ID", inputs.CLOUDFLARE_ACCOUNT_ID],
        ["SEED_PASSWORD", inputs.SEED_PASSWORD],
      ],
      variables: [["STAGING_URL", inputs.STAGING_URL]],
    },
    production: {
      secrets: [
        ["CLOUDFLARE_API_TOKEN", inputs.CLOUDFLARE_API_TOKEN],
        ["CLOUDFLARE_ACCOUNT_ID", inputs.CLOUDFLARE_ACCOUNT_ID],
      ],
      variables: [["PRODUCTION_URL", inputs.PRODUCTION_URL]],
    },
    "production-backup": {
      secrets: [
        ["CLOUDFLARE_API_TOKEN", inputs.CLOUDFLARE_API_TOKEN],
        ["CLOUDFLARE_ACCOUNT_ID", inputs.CLOUDFLARE_ACCOUNT_ID],
        ["BACKUP_AGE_RECIPIENT", inputs.BACKUP_AGE_RECIPIENT],
        ["BACKUP_S3_BUCKET", inputs.BACKUP_S3_BUCKET],
        ["BACKUP_S3_ENDPOINT", inputs.BACKUP_S3_ENDPOINT],
        ["BACKUP_S3_ACCESS_KEY_ID", inputs.BACKUP_S3_ACCESS_KEY_ID],
        ["BACKUP_S3_SECRET_ACCESS_KEY", inputs.BACKUP_S3_SECRET_ACCESS_KEY],
      ],
      variables: [
        ["BACKUP_S3_REGION", inputs.BACKUP_S3_REGION],
        ["BACKUP_S3_PREFIX", inputs.BACKUP_S3_PREFIX],
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
    "  1. Enable the Workers Paid plan on the Cloudflare account (D04: the bundle is over",
  );
  say("     the 3 MiB free-plan limit).");
  say(
    '  2. Create the Cloudflare API token — template "Edit Cloudflare Workers" plus D1 Edit —',
  );
  say(
    "     before running this script. It is CLOUDFLARE_API_TOKEN in the env file.",
  );
  say(
    "  3. Create the Google OAuth client (Web application, internal consent screen) with",
  );
  say("     these authorized redirect URIs:");
  say(`       ${inputs.STAGING_URL}/_agent-native/google/callback`);
  say(`       ${inputs.PRODUCTION_URL}/_agent-native/google/callback`);
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
      ? "Done. Commit the changed wrangler.jsonc, then follow docs/bootstrap.md from step 11."
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
      workerExists: {},
      deploymentNeeded: {},
      isTemplate: false,
      built: false,
    },
  };

  /** @type {Record<string, (ctx: Context) => void>} */
  const runners = {
    preflight: stepPreflight,
    d1: stepD1,
    deploy: stepDeploy,
    "worker-secrets": stepWorkerSecrets,
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
