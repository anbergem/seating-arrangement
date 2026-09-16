import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// Every provider credential the framework's own deploy-credential list names,
// removed from the child environment so this test can never reach a paid API
// and can never be billed to whoever runs `pnpm test:guards`. With none of them
// set, `resolveEngine` refuses before any request is made, which is what the
// "No LLM provider is connected" assertion below proves.
const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "BUILDER_GATEWAY_SPACE_ID",
  "BUILDER_GATEWAY_TOKEN",
  "BUILDER_PRIVATE_KEY",
  "BUILDER_PUBLIC_KEY",
  "COHERE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "OLLAMA_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
];

function runModelEvals(args = ["--json"]) {
  const env = { ...process.env, RUN_MODEL_EVALS: "1" };
  for (const key of PROVIDER_KEYS) delete env[key];
  const result = spawnSync("node", ["scripts/run-evals.mjs", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

// `RUN_MODEL_EVALS=1 node scripts/run-evals.mjs --json > eval-evidence.json` is
// the documented way to capture release evidence, so stdout has to be exactly
// one JSON document. The preparation steps used to print "applied 0001_init.sql"
// to stdout, which put two bare words ahead of the document and made the
// artifact unparseable (DISCREPANCIES.md, 2026-09-08).
test("a model-backed --json run writes only JSON to stdout", () => {
  const result = runModelEvals();

  let report;
  assert.doesNotThrow(
    () => {
      report = JSON.parse(result.stdout);
    },
    `stdout is not a single JSON document:\n${result.stdout.slice(0, 400)}`,
  );

  assert.equal(report.report.total, 5, "all five evals ran");
  assert.equal(report.report.skipped, 0, "RUN_MODEL_EVALS=1 skips nothing");

  // The preparation output still has to be visible, just on the other stream.
  assert.match(result.stderr, /applied 0001_init\.sql/);
  assert.doesNotMatch(result.stdout, /applied 0001_init\.sql/);

  // The app logs one JSON line per action call to stdout (B16). Those lines
  // appear once the agent runs; the driver must keep them off its own stdout.
  assert.doesNotMatch(result.stdout, /"event":"action"/);

  // No provider was reachable, so nothing here was a paid request.
  for (const entry of report.report.results) {
    assert.match(String(entry.error), /No LLM provider is connected/);
  }
});

// `--out` exists so that the artifact never depends on shell redirection: pnpm
// appends `[ELIFECYCLE] …` to stdout when a script exits non-zero, so
// `pnpm eval -- --json > file` corrupts the document on a failing run no matter
// what this script does with its own streams.
test("--out writes the report itself, past any wrapper's epilogue", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "eval-json-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "evidence.json");

  // No `--json`: `--out` has to imply it, or the file holds the human table.
  const result = runModelEvals(["--", `--out=${target}`]);

  const report = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(report.report.total, 5);
  assert.notEqual(result.status, 0, "a failing run still gates the caller");
  assert.match(result.stderr, /eval report written to/);
  // The separator `pnpm eval --` passes through must not be read as a filename
  // filter, which would silently match no eval file at all.
  assert.equal(report.report.skipped, 0);
});

test("--out without a path is refused", () => {
  const result = runModelEvals(["--out"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--out needs a path/);
});

// The 400 this driver exists to avoid ("system.0: cache_control cannot be set
// for empty text blocks") is produced by exactly one input: an empty system
// prompt. The driver refuses rather than send one, so the instructions file it
// reads must never become empty unnoticed.
test("the runtime instructions the evals run with are not empty", () => {
  const configSource = readFileSync(
    path.join(root, "agent-native.config.ts"),
    "utf8",
  );
  const runtime = configSource.match(/runtime:\s*"([^"]+)"/)?.[1];
  assert.ok(runtime, "agent-native.config.ts declares instructions.runtime");
  const instructions = readFileSync(path.join(root, runtime), "utf8").trim();
  assert.notEqual(instructions, "", `${runtime} is the agent's system prompt`);
});
