import { defineEval, usesTool } from "@agent-native/core/eval";

import {
  MODEL_EVAL_SKIP_REASON,
  noMutations,
  resetEvalScenario,
  successfulToolCall,
} from "./helpers.ts";

export default defineEval({
  name: "list the events without mutation",
  input: { prompt: "What events do we have coming up?" },
  skipReason: MODEL_EVAL_SKIP_REASON,
  threshold: 1,
  run: async ({ input, runAgent }) => {
    await resetEvalScenario();
    return runAgent(input);
  },
  scorers: [
    usesTool("list-events"),
    successfulToolCall({
      tool: "list-events",
      expectedInput: (value) => typeof value === "object" && value !== null,
      expectedResult: (value) => Array.isArray(value),
    }),
    noMutations,
  ],
});
