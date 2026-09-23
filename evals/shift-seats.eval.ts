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
  name: "make room for a guest by shifting everybody along",
  // Asked the way a person asks it. The agent has to see that this is a shift
  // rather than a label: writing Katherine on to seat 1 would put her where
  // Grace is sitting, and clearing Grace first would lose her.
  input: {
    prompt:
      "Katherine Johnson should sit next to Ada Lovelace at the head table at the Spring Gala. Ada keeps her chair — move everybody else along to make room on her other side.",
  },
  skipReason: MODEL_EVAL_SKIP_REASON,
  threshold: 1,
  run: async ({ input, runAgent }) => {
    await resetEvalScenario();
    const result = await runAgent(input);
    const table = await getDependencies().seatingTables.getById(
      "org_acme",
      "tbl_head",
    );
    // Ada started on seat 0 and Grace on seat 1. Whichever way round the
    // agent shifted, nobody may have been lost and Katherine must be seated.
    const labels = table?.seats.map((seat) => seat.label) ?? [];
    persisted =
      labels.includes("Ada Lovelace") &&
      labels.includes("Grace Hopper") &&
      labels.includes("Katherine Johnson");
    return result;
  },
  scorers: [
    usesTool("shift-seats"),
    successfulToolCall({
      tool: "shift-seats",
      expectedInput: (value) =>
        typeof value === "object" &&
        value !== null &&
        (value as { tableId?: unknown }).tableId === "tbl_head",
      // The shift frees the chair it was aimed at, whichever way it ran.
      expectedResult: (value) =>
        typeof value === "object" &&
        value !== null &&
        JSON.stringify(value).includes('"label":""'),
    }),
    persistedState(() => persisted),
  ],
});
