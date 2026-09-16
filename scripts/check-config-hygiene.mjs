#!/usr/bin/env node
// Config hygiene checker (docs/plan/tasks/T01-toolchain.md step 5, decisions D16 and D17).
//
// Why: telemetry, auth bypasses and secrets must be impossible to acquire by accident. This
// check runs in `pnpm check` and in CI, so a committed `AUTH_DISABLED` or a secret parked in
// `wrangler.jsonc` `vars` fails the build instead of reaching an environment.
//
// Only real assignments are inspected: commented-out lines in the example files are prose.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonc } from "./lib/jsonc.mjs";
import { findUninheritedVars } from "./lib/wrangler-vars.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// D17: never configured anywhere, in any environment.
const FORBIDDEN_KEYS = [
  "VITE_AGENT_NATIVE_ANALYTICS_PUBLIC_KEY",
  "VITE_AGENT_NATIVE_ANALYTICS_ENDPOINT",
  "BUILDER_PRIVATE_KEY",
  "BUILDER_PUBLIC_KEY",
  "SENTRY_DSN",
  "ACCESS_TOKEN",
  "ACCESS_TOKENS",
  "AUTH_DISABLED",
  "AGENT_PROD_CODE_EXECUTION",
];

// Secrets: `wrangler secret put`, never a Worker var.
const SECRET_KEYS = [
  "BETTER_AUTH_SECRET",
  "OAUTH_STATE_SECRET",
  "GOOGLE_SIGN_IN_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "SEED_PASSWORD",
];

// The only non-empty values the committed example files may carry (T01 step 6, B13).
const ALLOWED_EXAMPLE_VALUES = {
  APP_ENV: "local",
  DATABASE_URL: "file:./data/app.db",
  APP_URL: "http://localhost:8080",
  AUTO_CREATE_DEFAULT_ORG: "0",
  AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT: "1",
  AUTH_REQUIRE_EMAIL_VERIFICATION: "0",
  SEED_ENABLED: "1",
  SEED_PASSWORD: "Example-Seed-Password-2026",
};

// `.bootstrap.env.example` joins the list so the same "names only" rule covers the bootstrap
// input, whose real form holds the Cloudflare token and the Google client secret (T24).
const EXAMPLE_FILES = [
  ".env.example",
  ".dev.vars.example",
  ".bootstrap.env.example",
];

// B15/T02: the deploy-time placeholder belongs only in the `staging` and `production` blocks
// of wrangler.jsonc. Anywhere else it is either a placeholder someone forgot to fill in or a
// local/CI setting that will silently do the wrong thing. Assembled from two halves so this
// checker does not report its own source.
const PLACEHOLDER = ["REPLACE", "ME"].join("_");
const PLACEHOLDER_ENVIRONMENTS = ["staging", "production"];
const PLACEHOLDER_SCANNED_FILES = [
  "package.json",
  ".env.example",
  ".dev.vars.example",
  ".bootstrap.env.example",
];

/** @type {string[]} */
const findings = [];

/** @param {string} relativePath @returns {string | null} */
function read(relativePath) {
  const absolute = path.join(repoRoot, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

/**
 * @param {string} contents
 * @returns {{ key: string, value: string, line: number }[]}
 */
function parseDotenv(contents) {
  /** @type {{ key: string, value: string, line: number }[]} */
  const entries = [];
  for (const [index, raw] of contents.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match?.[1]) continue;
    entries.push({
      key: match[1],
      value: (match[2] ?? "").trim().replace(/^["']|["']$/g, ""),
      line: index + 1,
    });
  }
  return entries;
}

for (const file of EXAMPLE_FILES) {
  const contents = read(file);
  if (contents === null) {
    findings.push(`${file}: missing`);
    continue;
  }
  for (const { key, value, line } of parseDotenv(contents)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      findings.push(
        `${file}:${line} forbidden key ${key} (D17: never configured)`,
      );
    }
    if (value === "") continue;
    const allowed = ALLOWED_EXAMPLE_VALUES[key];
    if (allowed === undefined) {
      findings.push(
        `${file}:${line} ${key} has a value; example files carry names only`,
      );
    } else if (allowed !== value) {
      findings.push(
        `${file}:${line} ${key}=${value} is not the documented local default (${allowed})`,
      );
    }
  }
}

// agent-native.config.ts: a plain text scan is enough — any occurrence of these names in the
// framework config is a misconfiguration, quoted or not.
const frameworkConfig = read("agent-native.config.ts");
if (frameworkConfig !== null) {
  for (const [index, line] of frameworkConfig.split("\n").entries()) {
    for (const key of FORBIDDEN_KEYS) {
      if (line.includes(key)) {
        findings.push(
          `agent-native.config.ts:${index + 1} forbidden key ${key} (D17: never configured)`,
        );
      }
    }
  }
}

// wrangler.jsonc does not exist until T02; skip the check until it does.
const wranglerSource = read("wrangler.jsonc");
if (wranglerSource !== null) {
  /** @type {Record<string, unknown> | null} */
  let wrangler = null;
  try {
    wrangler = parseJsonc(wranglerSource);
  } catch (error) {
    findings.push(
      `wrangler.jsonc: not parseable as JSON after stripping comments (${error})`,
    );
  }
  if (wrangler) {
    /** @type {[string, unknown][]} */
    const varBlocks = [["wrangler.jsonc vars", wrangler.vars]];
    const environments =
      /** @type {Record<string, { vars?: unknown }> | undefined} */ (
        wrangler.env
      );
    for (const [name, environment] of Object.entries(environments ?? {})) {
      varBlocks.push([`wrangler.jsonc env.${name}.vars`, environment?.vars]);
    }
    for (const [label, block] of varBlocks) {
      if (!block || typeof block !== "object") continue;
      for (const key of Object.keys(block)) {
        if (FORBIDDEN_KEYS.includes(key)) {
          findings.push(
            `${label}: forbidden key ${key} (D17: never configured)`,
          );
        }
        if (SECRET_KEYS.includes(key)) {
          findings.push(
            `${label}: secret ${key} must be a Worker secret, not a var`,
          );
        }
      }
    }

    findings.push(...findUninheritedVars(wrangler));

    // Walk the parsed config so the rule is about structure, not about which line a value
    // happens to sit on. Comments are already stripped, so prose is never a finding.
    /** @param {unknown} node @param {string[]} trail */
    const findPlaceholders = (node, trail) => {
      const inEnvironmentBlock =
        trail[0] === "env" &&
        trail[1] !== undefined &&
        PLACEHOLDER_ENVIRONMENTS.includes(trail[1]);
      if (typeof node === "string") {
        if (node.includes(PLACEHOLDER) && !inEnvironmentBlock) {
          findings.push(
            `wrangler.jsonc ${trail.join(".")}: ${PLACEHOLDER} is only allowed inside env.${PLACEHOLDER_ENVIRONMENTS.join(" and env.")}`,
          );
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const [index, item] of node.entries()) {
          findPlaceholders(item, [...trail, String(index)]);
        }
        return;
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key.includes(PLACEHOLDER) && !inEnvironmentBlock) {
            findings.push(
              `wrangler.jsonc ${[...trail, key].join(".")}: ${PLACEHOLDER} is only allowed inside env.${PLACEHOLDER_ENVIRONMENTS.join(" and env.")}`,
            );
          }
          findPlaceholders(value, [...trail, key]);
        }
      }
    };

    findPlaceholders(wrangler, []);
  }
}

// Everything outside wrangler.jsonc: no environment blocks there, so any occurrence is a
// finding — a forgotten placeholder in a script or an example file fails the same way.
const placeholderFiles = [...PLACEHOLDER_SCANNED_FILES];
const scriptsDir = path.join(repoRoot, "scripts");
if (existsSync(scriptsDir)) {
  for (const entry of readdirSync(scriptsDir).sort()) {
    if (entry.endsWith(".mjs")) {
      placeholderFiles.push(path.join("scripts", entry));
    }
  }
}
for (const file of placeholderFiles) {
  const contents = read(file);
  if (contents === null) continue;
  for (const [index, line] of contents.split("\n").entries()) {
    if (line.includes(PLACEHOLDER)) {
      findings.push(
        `${file}:${index + 1} ${PLACEHOLDER} belongs only in wrangler.jsonc env.${PLACEHOLDER_ENVIRONMENTS.join(" and env.")}`,
      );
    }
  }
}

// The real files must stay out of git: the three secret inputs, and the eval report, which
// carries prompts, model output and provider request ids. `git check-ignore -q` rejects more
// than one pathname ("fatal: --quiet is only valid with a single pathname"), so ask about one
// file at a time.
for (const file of [
  ".env",
  ".dev.vars",
  ".bootstrap.env",
  "eval-evidence.json",
]) {
  try {
    execFileSync("git", ["check-ignore", "-q", file], { cwd: repoRoot });
  } catch {
    findings.push(`.gitignore: ${file} must be git-ignored`);
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  console.error(`${findings.length} config hygiene finding(s)`);
  process.exit(1);
}

console.log("config hygiene ok");
