import { defineEval, usesTool } from "@agent-native/core/eval";

import { getDependencies } from "../src/infrastructure/container.ts";
import {
  MODEL_EVAL_SKIP_REASON,
  persistedState,
  resetEvalScenario,
  successfulToolCall,
} from "./helpers.ts";

let persisted = false;

export default defineEval({
  name: "complete the intended in-progress job",
  input: { prompt: "Complete the in-progress job for Example Customer A." },
  skipReason: MODEL_EVAL_SKIP_REASON,
  threshold: 1,
  run: async ({ input, runAgent }) => {
    await resetEvalScenario();
    const result = await runAgent(input);
    const job = await getDependencies().jobs.getById(
      "org_acme",
      "job_in_progress",
    );
    persisted = job?.status === "completed";
    return result;
  },
  scorers: [
    usesTool("complete-job"),
    successfulToolCall({
      tool: "complete-job",
      expectedInput: (value) =>
        typeof value === "object" &&
        value !== null &&
        (value as { jobId?: unknown }).jobId === "job_in_progress",
      expectedResult: (value) =>
        typeof value === "object" &&
        value !== null &&
        JSON.stringify(value).includes('"status":"completed"'),
    }),
    persistedState(() => persisted),
  ],
});
