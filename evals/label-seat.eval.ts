import { defineEval, usesTool } from "@agent-native/core/eval";

import { findSeat } from "../src/domain/index.ts";
import { getDependencies } from "../src/infrastructure/container.ts";
import {
  MODEL_EVAL_SKIP_REASON,
  persistedState,
  resetEvalScenario,
  successfulToolCall,
} from "./helpers.ts";

let persisted = false;

export default defineEval({
  name: "seat a guest at the intended seat",
  // The seat is described the way a person would describe it, not the way the
  // action takes it. Seats are numbered clockwise, so the agent has to read the
  // plan, find Grace Hopper, and work out which number is beside her.
  input: {
    prompt:
      "Seat Katherine Johnson at the head table at the Spring Gala, on the far side of it, next to Grace Hopper.",
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
    // Grace is on seat 1, so the seat beside her is 0 or 2.
    persisted =
      table !== null &&
      [0, 2].some(
        (seat) => findSeat(table, seat)?.label === "Katherine Johnson",
      );
    return result;
  },
  scorers: [
    usesTool("label-seat"),
    successfulToolCall({
      tool: "label-seat",
      expectedInput: (value) =>
        typeof value === "object" &&
        value !== null &&
        (value as { tableId?: unknown }).tableId === "tbl_head" &&
        [0, 2].includes((value as { seat?: number }).seat ?? -1),
      expectedResult: (value) =>
        typeof value === "object" &&
        value !== null &&
        JSON.stringify(value).includes('"label":"Katherine Johnson"'),
    }),
    persistedState(() => persisted),
  ],
});
