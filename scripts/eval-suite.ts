/**
 * Eval driver.
 *
 * `agent-native eval` (0.176.5) calls `runEvalSuite` without a `systemPrompt`,
 * so `createAgentRunner` defaults it to `""`. The Anthropic engine then builds
 * one system block of empty text and, because prompt caching is on by default,
 * attaches `cache_control` to it — which the API rejects:
 *
 *   400 invalid_request_error
 *   system.0: cache_control cannot be set for empty text blocks
 *
 * Every eval fails identically before the model is ever consulted. Even with
 * that bug fixed upstream, an empty prompt would evaluate an agent we do not
 * ship: the deployed agent's instructions are `instructions.runtime` in
 * `agent-native.config.ts` (D20). So this driver supplies them and mirrors the
 * CLI's arguments, output shape and exit codes. See DISCREPANCIES.md
 * (2026-09-08) and docs/plan/upstream-issues/eval-system-prompt.md.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";

import { resolveAgentNativeConfig } from "@agent-native/core/config";
import { formatReport, runEvalSuite } from "@agent-native/core/eval";

import configInput from "../agent-native.config.ts";
import { FIXTURE_CLOCK } from "../tests/fixtures/scenario.ts";

// This process's stdout carries exactly one thing: the report. Everything the
// run itself prints goes to stderr — the app's own action log is one JSON line
// per action call on stdout (src/infrastructure/logging.ts, B16), which would
// otherwise sit ahead of the document and make the artifact unparseable, as
// would any `console.log` the framework adds. Writes below use
// `process.stdout.write` directly.
const stdout = process.stdout.write.bind(process.stdout);
console.log = (...args: unknown[]) => {
  process.stderr.write(`${format(...args)}\n`);
};

/**
 * The `<runtime-context>` block the deployed agent receives and the eval path
 * does not.
 *
 * `production-agent.ts` prepends this (from `buildRuntimeContextPrompt`) so
 * relative dates are answerable; `createAgentRunner` passes the system prompt
 * through untouched, so an evaluated agent has no idea what "today" is — and
 * rule 3 of the instructions forbids inventing one. Without this, "Show me
 * today's jobs" cannot be answered by an agent that follows its instructions.
 *
 * The block is reproduced here rather than imported: `runtime-context` is not
 * in `@agent-native/core`'s export map. Keep it in step on upgrade — the
 * upgrade playbook's eval step is where that is caught. Pinned to
 * `FIXTURE_CLOCK` so a date-relative eval is reproducible instead of depending
 * on the day it runs; override with `EVAL_NOW` (an ISO 8601 instant).
 */
function runtimeContextBlock(): string {
  // guard:allow-env-credential — test-only clock override, not a credential
  const iso = process.env.EVAL_NOW ?? FIXTURE_CLOCK;
  const now = new Date(iso);
  if (Number.isNaN(now.getTime())) {
    console.error(`eval-suite: EVAL_NOW is not an ISO 8601 instant: ${iso}`);
    process.exit(2);
  }
  const day = now.toISOString().slice(0, 10);
  return `

<runtime-context>
currentDate: ${day}
currentTimezone: UTC
currentDateInTimezone: ${day}
Use this runtime context as authoritative for relative dates such as today, yesterday, tomorrow, this week, and last month. Resolve relative dates to explicit calendar dates before querying data or creating artifacts, and include the exact date or date range in factual answers. This block only carries day-granularity.
</runtime-context>`;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const thresholdIndex = argv.indexOf("--threshold");
const thresholdOverride =
  thresholdIndex === -1 ? undefined : Number(argv[thresholdIndex + 1]);
if (thresholdOverride !== undefined && !Number.isFinite(thresholdOverride)) {
  console.error("eval-suite: --threshold needs a number between 0 and 1");
  process.exit(2);
}
const pattern = argv.find(
  (argument, index) =>
    !argument.startsWith("-") && argv[index - 1] !== "--threshold",
);

// `defineAgentNativeConfig` is identity-like and may hold a factory, so the
// framework's own resolver answers what the app would actually load. An eval
// run is neither `serve` nor a dev server; it is closest to a build.
const config = resolveAgentNativeConfig(configInput, {
  command: "build",
  mode: "production",
  isDev: false,
  isBuild: true,
});
const instructions = config.instructions?.runtime;
if (!instructions) {
  console.error(
    "eval-suite: agent-native.config.ts declares no instructions.runtime, so the" +
      " evals would score an agent with no system prompt",
  );
  process.exit(2);
}
const instructionsText = readFileSync(
  path.join(root, instructions),
  "utf8",
).trim();
// An empty prompt is the exact input that produces the opaque 400 above; fail
// with a sentence that names the file instead.
if (instructionsText === "") {
  console.error(`eval-suite: ${instructions} is empty`);
  process.exit(2);
}
const systemPrompt = instructionsText + runtimeContextBlock();

let report;
let files: string[];
try {
  ({ report, files } = await runEvalSuite({
    cwd: root,
    pattern,
    thresholdOverride,
    systemPrompt,
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (json)
    stdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  else console.error(`\n  eval failed: ${message}\n`);
  process.exit(1);
}

if (report.total === 0) {
  // An app with no evals must not fail CI — the CLI's behaviour, kept.
  if (json) stdout(`${JSON.stringify({ ok: true, report, files }, null, 2)}\n`);
  else
    console.error(
      files.length === 0
        ? "\n  No eval files found (looked for **/*.eval.ts and evals/*.ts).\n"
        : `\n  Found ${files.length} eval file(s) but no defineEval() exports.\n`,
    );
  process.exit(0);
}

if (json) {
  stdout(
    `${JSON.stringify({ ok: report.failed === 0, report, files }, null, 2)}\n`,
  );
} else {
  stdout(`${formatReport(report)}\n`);
}
process.exit(report.failed > 0 ? 1 : 0);
