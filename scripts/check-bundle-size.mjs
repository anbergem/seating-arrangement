#!/usr/bin/env node
// Compressed Worker bundle size guard (decision D04, blueprint B14 step 3).
//
// Cloudflare measures the compressed Worker size: 3 MiB on the Free plan, 10 MiB on Paid.
// The starter requires Paid and keeps a 2 MiB margin, so the build fails above 8 MiB rather
// than at `wrangler deploy`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workerDir = path.join(repoRoot, "dist", "_worker.js");
const LIMIT_BYTES = 8 * 1024 * 1024;

/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...jsFiles(absolute));
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      found.push(absolute);
    }
  }
  return found;
}

try {
  statSync(workerDir);
} catch {
  console.error(
    `bundle size: ${path.relative(repoRoot, workerDir)} not found — run \`pnpm build:worker\` first`,
  );
  process.exit(1);
}

let total = 0;
for (const file of jsFiles(workerDir)) {
  total += gzipSync(readFileSync(file), { level: 9 }).byteLength;
}

const mib = (total / (1024 * 1024)).toFixed(2);
console.log(`worker bundle gzip total: ${mib} MiB`);

if (total > LIMIT_BYTES) {
  console.error(
    `bundle size: ${mib} MiB exceeds the ${LIMIT_BYTES / (1024 * 1024)} MiB ceiling (D04)`,
  );
  process.exit(1);
}
