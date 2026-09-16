#!/usr/bin/env node
// Renames the sample application (docs/bootstrap.md step 1, decision D18).
//
// The starter ships as `example-jobs` / "Example Jobs" (D18) and a real application is not
// called that. This replaces both strings everywhere they are load-bearing: the Worker and
// database names in `wrangler.jsonc`, the framework's `app.id` and the agent-chat plugin's
// `appId` (which must agree with it), the sign-in page's app name, the browser bundle's app
// slug, the PWA manifest, the deployment workflows, the scripts and the documents.
//
// Two rules make it safe to run on a tree with uncommitted work:
//
//   * It only ever rewrites files that actually contain one of the two strings, and it prints
//     every one of them. `--dry-run` prints the list and writes nothing.
//   * `docs/plan/**` is excluded. That directory is the implementation plan: a historical
//     record whose decision records, discrepancy log and task files *state* that the sample is
//     called `example-jobs`. Rewriting them would make the record say something that never
//     happened. Task T26 deletes the directory once the plan is complete.
//
// Generated and vendored trees (`node_modules`, `dist`, `build`, `.wrangler`, `.generated`,
// `.react-router`, `data`, `pnpm-lock.yaml`) are excluded for the same reason a build output
// is not source: the next build regenerates them from the renamed source.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const FROM_NAME = "example-jobs";
const FROM_DISPLAY = "Example Jobs";

/** Directories never walked, relative to the repository root. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".generated",
  ".react-router",
  ".wrangler",
  "build",
  "data",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

/** Paths never rewritten, relative to the repository root. */
const SKIP_PATHS = new Set([
  "docs/plan",
  "pnpm-lock.yaml",
  "tests/e2e/.auth",
  // This file: the two strings below are what it searches *for*. Rewriting them would leave a
  // script that can never be run again, and could not be reverted by running it backwards.
  "scripts/rename-app.mjs",
]);

/** The subset of the extensions below that `oxfmt` formats, and that a rename can therefore
 * push over `printWidth`. `.sh` is not one of them. */
const FORMATTED_EXTENSIONS = new Set([
  ".jsonc",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

/** Only text this repository owns. A file type not listed here is never touched. */
const EXTENSIONS = new Set([
  ".example",
  ".jsonc",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const USAGE = `Usage: node scripts/rename-app.mjs --name <kebab-name> --display "<Display Name>"

  --name <kebab>       New application name. Must match ^[a-z][a-z0-9-]{2,40}$. Replaces
                       "${FROM_NAME}" and becomes package.json "name".
  --display "<name>"   New display name. Replaces "${FROM_DISPLAY}".
  --dry-run            List the files that would change and write nothing.
  --help               This text.

Run it on a clean tree and review the diff. docs/plan/** is deliberately left alone.`;

/** @param {string} message */
function refuse(message) {
  console.error(`rename-app: ${message}`);
  process.exit(1);
}

/**
 * @param {string} directory
 * @param {string[]} found
 */
function walk(directory, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(repoRoot, absolute);
    if (SKIP_PATHS.has(relative)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(absolute, found);
      continue;
    }
    if (!entry.isFile()) continue;
    // `.bootstrap.env.example` and `.env.example` end in `.example`; everything else is
    // matched on its real extension.
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;
    found.push(relative);
  }
  return found;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        name: { type: "string" },
        display: { type: "string" },
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

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const name = (values.name ?? "").trim();
  const display = (values.display ?? "").trim();
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(name)) {
    refuse(
      `--name must match ^[a-z][a-z0-9-]{2,40}$ (got ${JSON.stringify(name)})`,
    );
  }
  if (display === "" || display.length > 60 || /[\n\r"\\]/.test(display)) {
    refuse(
      "--display must be 1-60 characters and contain no quote, backslash or newline",
    );
  }

  /** @type {string[]} */
  const changed = [];
  for (const relative of walk(repoRoot, [])) {
    const absolute = path.join(repoRoot, relative);
    if (statSync(absolute).isSymbolicLink?.()) continue;
    const before = readFileSync(absolute, "utf8");
    if (!before.includes(FROM_NAME) && !before.includes(FROM_DISPLAY)) continue;
    const after = before
      .split(FROM_NAME)
      .join(name)
      .split(FROM_DISPLAY)
      .join(display);
    if (after === before) continue;
    if (!values["dry-run"]) writeFileSync(absolute, after);
    changed.push(relative);
  }

  // `package.json` "name" is the starter's own package name, not the sample app's, so the
  // string replacement above never reaches it. A real application is named after itself.
  const packagePath = path.join(repoRoot, "package.json");
  const packageSource = readFileSync(packagePath, "utf8");
  const withName = packageSource.replace(
    /^(\s*"name":\s*")[^"]*(",)$/m,
    `$1${name}$2`,
  );
  if (withName !== packageSource) {
    if (!values["dry-run"]) writeFileSync(packagePath, withName);
    if (!changed.includes("package.json")) changed.push("package.json");
  }

  if (changed.length === 0) {
    console.log(
      `rename-app: nothing to do — no file contains "${FROM_NAME}" or "${FROM_DISPLAY}".`,
    );
    return;
  }

  const formatted = values["dry-run"] ? 0 : format(changed);

  console.log(
    `rename-app: ${FROM_NAME} -> ${name}, "${FROM_DISPLAY}" -> "${display}" in ${changed.length} file(s)`,
  );
  for (const relative of changed.sort()) console.log(`  ${relative}`);
  if (formatted > 0) {
    console.log(`rename-app: reformatted ${formatted} of them with oxfmt`);
  }
  console.log(
    values["dry-run"]
      ? "rename-app: --dry-run, nothing was written"
      : "rename-app: review `git diff`, then run `pnpm check` before committing.",
  );
}

/**
 * Runs the repository's own formatter over the rewritten files.
 *
 * A name of a different length changes where `oxfmt` breaks a line — replacing
 * `example-jobs-worker-smoke-` with something shorter lets a three-line call collapse onto
 * one, and `oxfmt --check` (part of `pnpm lint`, part of `pnpm check`) then fails on a file
 * this script wrote. Formatting here rather than duplicating oxfmt's line-breaking rule is
 * the same choice `scripts/gen-migrations-manifest.mjs` made for the same reason.
 *
 * `.oxfmtrc.json`'s own `ignorePatterns` are read rather than hard-coded, so a file oxfmt does
 * not own — anything under `docs/`, for instance — is never handed to it. A production-only
 * install has no oxfmt; the rewritten files are then left as they are and the count is 0.
 * @param {string[]} changed
 */
function format(changed) {
  const binary = path.join(repoRoot, "node_modules", ".bin", "oxfmt");
  if (!existsSync(binary)) return 0;
  /** @type {string[]} */
  let ignore = [];
  try {
    ignore = JSON.parse(
      readFileSync(path.join(repoRoot, ".oxfmtrc.json"), "utf8"),
    ).ignorePatterns;
  } catch {
    return 0;
  }
  const owned = changed.filter((relative) => {
    const [first] = relative.split(path.sep);
    return (
      !ignore.includes(/** @type {string} */ (first)) &&
      FORMATTED_EXTENSIONS.has(path.extname(relative))
    );
  });
  if (owned.length === 0) return 0;
  const result = spawnSync(binary, ["--write", ...owned], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  if (result.status !== 0) {
    console.error(
      "rename-app: oxfmt failed on the rewritten files; run `pnpm lint` and fix them by hand",
    );
    return 0;
  }
  return owned.length;
}

main();
