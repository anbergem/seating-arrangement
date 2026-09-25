#!/usr/bin/env node
// Config hygiene checker (docs/plan/tasks/T01-toolchain.md step 5, decisions D16 and D17).
//
// Why: telemetry, auth bypasses and secrets must be impossible to acquire by accident. This
// check runs in `pnpm check` and in CI, so a committed `AUTH_DISABLED` or a secret parked in
// a placeholder left in a committed file fails the build instead of reaching an environment.
//
// Only real assignments are inspected: commented-out lines in the example files are prose.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// Secret names used to be checked against `wrangler.jsonc` `vars`, to catch a secret
// committed as a plain Worker variable. Clever Cloud has no committed variables file —
// `clever env import` reads them from stdin — so there is nothing left here to scan, and
// the list went with the check (T28).

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
const EXAMPLE_FILES = [".env.example", ".bootstrap.env.example"];

// B15/T02: the deploy-time placeholder belongs only in the `staging` and `production` blocks
// of a committed file. Anywhere it appears it is either a placeholder someone forgot to fill in or a
// local/CI setting that will silently do the wrong thing. Assembled from two halves so this
// checker does not report its own source.
const PLACEHOLDER = ["REPLACE", "ME"].join("_");
const PLACEHOLDER_SCANNED_FILES = [
  "package.json",
  ".env.example",
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

// No file carries a deploy-time placeholder any more: Clever Cloud reports the application
// domain when it creates the app, and the database address arrives as a platform variable,
// so there is nothing left for anyone to fill in by hand (T28). Any occurrence is a
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
        `${file}:${index + 1} ${PLACEHOLDER} is a leftover: nothing is filled in by hand any more (T28)`,
      );
    }
  }
}

// The real files must stay out of git: the three secret inputs, and the eval report, which
// carries prompts, model output and provider request ids. `git check-ignore -q` rejects more
// than one pathname ("fatal: --quiet is only valid with a single pathname"), so ask about one
// file at a time.
for (const file of [".env", ".bootstrap.env", "eval-evidence.json"]) {
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
