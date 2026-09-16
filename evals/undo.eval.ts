import { defineEval, usesTool } from "@agent-native/core/eval";

import type { Actor } from "../src/application/actor.ts";
import { completeJob } from "../src/application/use-cases/complete-job.ts";
import { getDependencies } from "../src/infrastructure/container.ts";
import {
  MODEL_EVAL_SKIP_REASON,
  persistedState,
  resetEvalScenario,
  successfulToolCall,
} from "./helpers.ts";

const member: Actor = {
  userEmail: "member1@example.invalid",
  orgId: "org_acme",
  role: "member",
  caller: "eval-setup",
};
let restored = false;

export default defineEval({
  name: "undo the intended completion",
  input: {
    history: [
      { role: "user", text: "Complete job_in_progress." },
      { role: "assistant", text: "I completed that job." },
    ],
    prompt: "Undo that.",
  },
  skipReason: MODEL_EVAL_SKIP_REASON,
  threshold: 1,
  run: async ({ input, runAgent }) => {
    await resetEvalScenario();
    const completed = await completeJob(getDependencies(), member, {
      jobId: "job_in_progress",
    });
    const result = await runAgent({
      ...input,
      prompt: `Undo that completion. Its operation id is ${completed.operationId}.`,
    });
    const job = await getDependencies().jobs.getById(
      "org_acme",
      "job_in_progress",
    );
    restored = job?.status === "in_progress";
    return result;
  },
  scorers: [
    usesTool("undo-operation"),
    successfulToolCall({
      tool: "undo-operation",
      expectedInput: (value) =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { operationId?: unknown }).operationId === "string",
      expectedResult: (value) =>
        typeof value === "object" &&
        value !== null &&
        JSON.stringify(value).includes('"status":"in_progress"'),
    }),
    persistedState(() => restored),
  ],
});
