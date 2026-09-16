import { defineEval, usesTool } from "@agent-native/core/eval";

import {
  MODEL_EVAL_SKIP_REASON,
  noMutations,
  resetEvalScenario,
  successfulToolCall,
} from "./helpers.ts";

export default defineEval({
  name: "list today's jobs without mutation",
  input: { prompt: "Show me today's jobs." },
  skipReason: MODEL_EVAL_SKIP_REASON,
  threshold: 1,
  run: async ({ input, runAgent }) => {
    await resetEvalScenario();
    return runAgent(input);
  },
  scorers: [
    usesTool("list-jobs"),
    successfulToolCall({
      tool: "list-jobs",
      expectedInput: (value) => typeof value === "object" && value !== null,
      expectedResult: (value) => Array.isArray(value),
    }),
    noMutations,
  ],
});
