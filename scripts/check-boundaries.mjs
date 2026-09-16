#!/usr/bin/env node
// Layer-boundary checker for the rules in docs/plan/03-blueprint.md section B2.
//
// Why an application-specific checker: the layer rules are the architecture. They must fail the
// build, not live only in a document. Babel parses TS/TSX so formatting cannot hide imports.
//
// Enforcement model, derived from the two columns of the B2 table:
//   * "Must never import" is always an error.
//   * The "may import from" column is enforced as an allow-list for *repository-internal*
//     targets in every layer: an internal import that is not listed is an error.
//   * For *external* specifiers (npm packages, `node:*`, virtual modules) the allow-list is
//     enforced only where B2 makes it exhaustive: `domain` and `application` may not import
//     anything external at all ("anything else, including zod, node:*, @agent-native/*,
//     react"). The other layers are checked against their deny list.
// A file may always import its own layer.
//
// Specifier forms parsed: `import ... from "x"`, `export ... from "x"`, `import "x"` and
// `import("x")`. Type-only imports count, which is why `app/` gets an explicit allowance for
// `src/domain` (B2: types and pure helpers only).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { collectImportSpecifiers } from "./lib/import-specifiers.mjs";

const { values } = parseArgs({ options: { root: { type: "string" } } });
const repoRoot = values.root
  ? path.resolve(values.root)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WALK_ROOTS = ["src", "actions", "app"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".output",
  ".wrangler",
  ".react-router",
  ".generated",
  "build",
  "data",
  ".git",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

// Top-level directories that a bare specifier can address, because tsconfig maps "*" to "./*".
const INTERNAL_ROOTS = [
  "src",
  "app",
  "actions",
  "server",
  "shared",
  "tests",
  "evals",
  "scripts",
];

/**
 * @typedef {object} LayerRule
 * @property {string} name
 * @property {string} dir             directory that defines the layer
 * @property {string[]} internalAllow repository-internal prefixes this layer may import
 * @property {string[]} externalDeny  external specifier prefixes this layer may never import
 * @property {boolean} externalAllowedByDefault
 */

/** @type {LayerRule[]} ordered most specific first */
const LAYERS = [
  {
    name: "domain",
    dir: "src/domain",
    internalAllow: ["src/domain"],
    externalDeny: [],
    externalAllowedByDefault: false,
  },
  {
    name: "application",
    dir: "src/application",
    internalAllow: ["src/domain", "src/application"],
    externalDeny: [],
    externalAllowedByDefault: false,
  },
  {
    name: "infrastructure",
    dir: "src/infrastructure",
    internalAllow: ["src/domain", "src/application", "src/infrastructure"],
    externalDeny: ["react", "react-dom"],
    externalAllowedByDefault: true,
  },
  {
    name: "interface",
    dir: "src/interface",
    internalAllow: ["src/application", "src/infrastructure", "src/interface"],
    externalDeny: ["react", "react-dom"],
    externalAllowedByDefault: true,
  },
  {
    name: "actions",
    dir: "actions",
    internalAllow: ["actions", "src/interface", "src/application"],
    externalDeny: [],
    externalAllowedByDefault: true,
  },
  {
    name: "ui",
    dir: "app",
    internalAllow: ["app", "src/domain"],
    externalDeny: [],
    externalAllowedByDefault: true,
  },
];

/** @param {string} dir @returns {string[]} repo-relative posix paths */
function collectFiles(dir) {
  const absolute = path.join(repoRoot, dir);
  if (!existsSync(absolute)) return [];
  /** @type {string[]} */
  const found = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".gitkeep") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      found.push(path.relative(repoRoot, full).split(path.sep).join("/"));
    }
  };
  if (statSync(absolute).isDirectory()) walk(absolute);
  return found;
}

/** @param {string} file */
function readSpecifiers(file) {
  return collectImportSpecifiers(
    readFileSync(path.join(repoRoot, file), "utf8"),
  );
}

/**
 * Resolve a specifier to a repository-relative path, or null when it is external.
 * @param {string} fromFile repo-relative path of the importing file
 * @param {string} specifier
 * @returns {string | null}
 */
function resolveInternal(fromFile, specifier) {
  /** @type {string | null} */
  let candidate = null;
  if (specifier.startsWith(".")) {
    const absolute = path.resolve(
      path.dirname(path.join(repoRoot, fromFile)),
      specifier,
    );
    const relative = path
      .relative(repoRoot, absolute)
      .split(path.sep)
      .join("/");
    candidate = relative.startsWith("..") ? null : relative;
  } else if (specifier.startsWith("@/")) {
    candidate = `app/${specifier.slice(2)}`;
  } else if (specifier.startsWith("@shared/")) {
    candidate = `shared/${specifier.slice(8)}`;
  } else if (INTERNAL_ROOTS.includes(specifier.split("/")[0] ?? "")) {
    candidate = specifier;
  }
  if (candidate === null) return null;
  const normalized = path.posix.normalize(candidate);
  if (normalized.startsWith("..")) return null;
  // Drop query suffixes (`?url`) and extensions so prefixes compare cleanly.
  return normalized
    .replace(/\?.*$/, "")
    .replace(/\.(tsx?|jsx?|mjs|cjs|css|json)$/, "");
}

/** @param {string} target @param {string} prefix */
function isUnder(target, prefix) {
  return target === prefix || target.startsWith(`${prefix}/`);
}

/** @param {string} file @returns {LayerRule | null} */
function layerOf(file) {
  return LAYERS.find((layer) => isUnder(file, layer.dir)) ?? null;
}

/** @type {string[]} */
const violations = [];

for (const root of WALK_ROOTS) {
  for (const file of collectFiles(root)) {
    const layer = layerOf(file);
    if (!layer) continue; // a file under src/ that is not in one of the four layers
    for (const { specifier, line } of readSpecifiers(file)) {
      const internal = resolveInternal(file, specifier);
      if (internal !== null) {
        if (layer.internalAllow.some((prefix) => isUnder(internal, prefix)))
          continue;
        const targetLayer = layerOf(internal);
        const target = targetLayer ? targetLayer.dir : internal.split("/")[0];
        violations.push(
          `${file}:${line} forbidden import "${specifier}" (${layer.name} may not import ${target})`,
        );
        continue;
      }
      const denied = layer.externalDeny.some(
        (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
      );
      if (!denied && layer.externalAllowedByDefault) continue;
      violations.push(
        `${file}:${line} forbidden import "${specifier}" (${layer.name} may not import ${specifier})`,
      );
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  console.error(`${violations.length} boundary violation(s)`);
  process.exit(1);
}

console.log("boundaries ok");
