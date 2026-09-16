#!/usr/bin/env node
// Worker build pipeline (docs/plan/03-blueprint.md B14, decisions D02 and D03).
//
// `NITRO_PRESET=cloudflare_pages` is deliberate: at core 0.176.5 the `cloudflare_module`
// output does not boot on workerd, while this preset's single-file bundle does (D02). The
// result is deployed as a Worker through our own `wrangler.jsonc`, not as a Pages project.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) {
    console.error(`build:worker: ${command} failed to start (${result.error})`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `build:worker: ${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`,
    );
    process.exit(1);
  }
}

// The migrations manifest is a source file the bundle imports, so it has to exist before the
// framework build runs. The generator arrives in T06; until then there is nothing to do.
const manifestGenerator = path.join(
  repoRoot,
  "scripts",
  "gen-migrations-manifest.mjs",
);
if (existsSync(manifestGenerator)) {
  run(process.execPath, [manifestGenerator]);
}

run("pnpm", ["exec", "agent-native", "build"], {
  NITRO_PRESET: "cloudflare_pages",
  NODE_ENV: "production",
});

run(process.execPath, [
  path.join(repoRoot, "scripts", "patch-worker-bundle.mjs"),
]);
run(process.execPath, [
  path.join(repoRoot, "scripts", "check-bundle-size.mjs"),
]);

const head = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
});
const sha = head.status === 0 ? head.stdout.trim() : "unknown";

const coreVersion = JSON.parse(
  readFileSync(
    path.join(
      repoRoot,
      "node_modules",
      "@agent-native",
      "core",
      "package.json",
    ),
    "utf8",
  ),
).version;

const buildInfoPath = path.join(repoRoot, "dist", "BUILD_INFO.json");
writeFileSync(
  buildInfoPath,
  `${JSON.stringify({ sha, builtAt: new Date().toISOString(), coreVersion }, null, 2)}\n`,
);
console.log(`wrote ${path.relative(repoRoot, buildInfoPath)} (sha ${sha})`);
