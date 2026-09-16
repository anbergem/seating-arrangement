import { getDbExec } from "@agent-native/core/db";
import { createScorer, type AgentRunOutput } from "@agent-native/core/eval";

import {
  buildScenarioResetSql,
  buildScenarioSql,
} from "../tests/fixtures/scenario.ts";

// `agent-native eval` discovers and loads these files itself (F13), so the run
// mode can only reach them through the environment; the value is compared,
// never logged.
// guard:allow-env-credential — test-only run switch, not a credential
export const MODEL_EVALS_ENABLED = process.env.RUN_MODEL_EVALS === "1";
export const MODEL_EVAL_SKIP_REASON = MODEL_EVALS_ENABLED
  ? undefined
  : "Set RUN_MODEL_EVALS=1 and a configured provider credential to run model-backed evals";

export async function resetEvalScenario(): Promise<void> {
  const db = getDbExec();
  for (const sql of [...buildScenarioResetSql(), ...buildScenarioSql()]) {
    await db.execute(sql);
  }
}

function detailFor(run: AgentRunOutput, tool: string) {
  return run.toolCallDetails?.find((detail) => detail.name === tool);
}

/**
 * Why a scorer landed where it did, for the report.
 *
 * An `EvalResultRow` keeps only names and numbers, so a failing eval otherwise
 * says "Agent never called X" and nothing about what it did instead. That is
 * the whole diagnosis for a model-behaviour failure, and re-running to find out
 * costs another paid run. Both are safe to record: the report is git-ignored.
 */
function trace(run: AgentRunOutput, tool: string): string {
  const called = run.toolCalls.length === 0 ? "none" : run.toolCalls.join(", ");
  const detail = detailFor(run, tool);
  const outcome =
    detail === undefined
      ? `${tool} was not called`
      : `${tool} → ${detail.isError === true ? "error" : "ok"}` +
        `${detail.completedSideEffect === false ? ", side effect withheld" : ""}` +
        `: ${JSON.stringify(detail.result ?? null).slice(0, 300)}`;
  const said = run.text.trim().replace(/\s+/g, " ").slice(0, 300);
  return `tools called: ${called}. ${outcome}. agent said: ${said || "(nothing)"}`;
}

function parsedResult(detail: ReturnType<typeof detailFor>): unknown {
  if (!detail?.result) return undefined;
  try {
    return JSON.parse(detail.result);
  } catch {
    return detail.result;
  }
}

export function successfulToolCall(input: {
  tool: string;
  expectedInput: (value: unknown) => boolean;
  expectedResult: (value: unknown) => boolean;
}) {
  return createScorer({
    name: `${input.tool}-correct-target-and-result`,
    generateReason: ({ run }) => trace(run, input.tool),
    generateScore(run: AgentRunOutput) {
      const detail = detailFor(run, input.tool);
      return detail?.completed === true &&
        detail.isError !== true &&
        input.expectedInput(detail.input) &&
        input.expectedResult(parsedResult(detail))
        ? 1
        : 0;
    },
  });
}

export function persistedState(getPassed: () => boolean) {
  return createScorer({
    name: "persisted-state",
    generateScore: () => (getPassed() ? 1 : 0),
  });
}

export const noMutations = createScorer({
  name: "no-mutations",
  generateScore(run: AgentRunOutput) {
    const commands = new Set([
      "create-customer",
      "archive-customer",
      "create-job",
      "reschedule-job",
      "start-job",
      "complete-job",
      "archive-job",
      "send-job-to-accounting",
      "undo-operation",
      "redo-operation",
    ]);
    return run.toolCalls.some((name) => commands.has(name)) ? 0 : 1;
  },
});

export function approvalPaused(tool: string) {
  return createScorer({
    name: `${tool}-awaits-human-approval`,
    generateReason: ({ run }) => trace(run, tool),
    generateScore(run: AgentRunOutput) {
      const detail = detailFor(run, tool);
      return detail?.completed === true &&
        detail.completedSideEffect === false &&
        detail.isError !== true &&
        detail.result?.includes("Awaiting human approval")
        ? 1
        : 0;
    },
  });
}

export function toolDenied(tool: string) {
  return createScorer({
    name: `${tool}-authorization-denied`,
    generateReason: ({ run }) => trace(run, tool),
    generateScore(run: AgentRunOutput) {
      const detail = detailFor(run, tool);
      return detail?.completed === true &&
        detail.isError === true &&
        detail.result?.includes("AUTHORIZATION")
        ? 1
        : 0;
    },
  });
}
