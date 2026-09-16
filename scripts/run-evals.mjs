#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(tmpdir(), "example-jobs-evals-"));
const databaseUrl = `file:${path.join(temporary, "evals.db")}`;
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  AGENT_USER_EMAIL: process.env.AGENT_USER_EMAIL ?? "member1@example.invalid",
  AGENT_ORG_ID: process.env.AGENT_ORG_ID ?? "org_acme",
  // `agent-native eval` imports the `*.eval.ts` files in a plain Node process
  // (bin/agent-native.js runs the shipped build), so type stripping is all the
  // runtime offers: it cannot resolve the extensionless imports the
  // application layers use. tsx's resolver can, and the evals reach the real
  // use cases through it.
  NODE_OPTIONS: "--import tsx",
};

// `--json` makes this script's stdout a single JSON document, and a release
// artifact is produced by redirecting it to a file. The preparation steps below
// print progress of their own ("applied 0001_init.sql"), which lands in that
// redirect ahead of the document and makes it unparseable, so their stdout goes
// to this process's stderr (fd 2) instead. Only `agent-native eval` writes to
// stdout. See DISCREPANCIES.md, 2026-09-08.
let lastStdout = "";
function run(args, { stdout = "inherit" } = {}) {
  const result = spawnSync("pnpm", args, {
    cwd: root,
    env,
    stdio: ["inherit", stdout, "inherit"],
    ...(stdout === "pipe" ? { encoding: "utf8" } : {}),
  });
  if (result.error) throw result.error;
  lastStdout = stdout === "pipe" ? (result.stdout ?? "") : "";
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}

// `--out <path>` is how a release artifact is produced. Shell redirection is
// the obvious alternative and it does not survive contact with a wrapper:
// `pnpm run` writes "[ELIFECYCLE] Command failed with exit code 1." to stdout
// on a non-zero exit, appending a line after the closing brace on exactly the
// runs whose evidence matters. Writing the file here means the caller can use
// `pnpm eval` or `node` and get the same bytes either way. `--out` implies
// `--json`, because the default output is a human-readable table.
// See DISCREPANCIES.md, 2026-09-08.
const forwarded = [];
let outPath;
for (const [index, argument] of process.argv.slice(2).entries()) {
  // `pnpm eval -- --out x` passes the separator through as an argument of its
  // own, and `agent-native eval` reads a bare word as a filename filter.
  if (argument === "--" || argument === "--out") continue;
  if (process.argv.slice(2)[index - 1] === "--out") {
    outPath = path.resolve(root, argument);
    continue;
  }
  if (argument.startsWith("--out=")) {
    outPath = path.resolve(root, argument.slice("--out=".length));
    continue;
  }
  forwarded.push(argument);
}
if (process.argv.slice(2).at(-1) === "--out") {
  console.error("run-evals: --out needs a path");
  process.exit(2);
}

try {
  // The same test-only switch the eval files read (evals/helpers.ts); a
  // model-backed run needs a migrated and seeded database, a skipped run does
  // not.
  // guard:allow-env-credential — test-only run switch, not a credential
  if (process.env.RUN_MODEL_EVALS === "1") {
    if (!run(["exec", "node", "scripts/migrate-local.mjs"], { stdout: 2 }))
      process.exit();
    if (!run(["exec", "tsx", "tests/fixtures/seed-sql-only.ts"], { stdout: 2 }))
      process.exit();
  }
  const evalArgs = [...forwarded];
  if (outPath && !evalArgs.includes("--json")) evalArgs.push("--json");
  // `scripts/eval-suite.ts`, not `agent-native eval`: the CLI supplies no
  // system prompt, which makes every Anthropic run fail on an empty cached
  // system block (DISCREPANCIES.md, 2026-09-08).
  const result = run(["exec", "tsx", "scripts/eval-suite.ts", ...evalArgs], {
    stdout: outPath ? "pipe" : "inherit",
  });
  if (outPath) {
    // The report reaches the file without passing through a shell redirection,
    // so nothing any wrapper writes afterwards can land in it.
    writeFileSync(outPath, lastStdout);
    const shown = path.relative(root, outPath);
    process.stderr.write(
      `eval report written to ${shown && !shown.startsWith("..") ? shown : outPath}` +
        ` (${result ? "all evals passed" : "see the report: at least one eval did not pass"})\n`,
    );
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
