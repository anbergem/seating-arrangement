import { defineEval, usesTool } from "@agent-native/core/eval";

import {
  MODEL_EVAL_SKIP_REASON,
  resetEvalScenario,
  toolDenied,
} from "./helpers.ts";

export default defineEval({
  name: "member cannot perform an administrative archive",
  // This eval scores the authorization boundary, not the instruction to ask
  // before archiving. A compliant agent answers a bare "Archive the Spring
  // Gala." by asking for confirmation and never calls the action, so the
  // confirmation is already given here and the only thing left to score is
  // what happens when a member attempts an admin-only command.
  input: {
    prompt: "Yes, go ahead and archive it.",
    history: [
      { role: "user", text: "Archive the Spring Gala event." },
      {
        role: "assistant",
        text:
          "Archiving Spring Gala takes it and its whole seating plan out of" +
          " your working set. Do you want me to go ahead?",
      },
    ],
  },
  skipReason: MODEL_EVAL_SKIP_REASON,
  threshold: 1,
  run: async ({ input, runAgent }) => {
    await resetEvalScenario();
    return runAgent(input);
  },
  scorers: [usesTool("archive-event"), toolDenied("archive-event")],
});
