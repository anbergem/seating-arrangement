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
  name: "swap two guests with one operation",
  // Asked the way a person asks it. The point is not only that the two names
  // end up exchanged: it is that the agent reaches for `move-seat` rather than
  // two `label-seat` calls, which would be two Undos and would pass through a
  // state where one of them is seated nowhere.
  input: {
    prompt:
      "Ada Lovelace and Grace Hopper should swap places at the head table at the Spring Gala.",
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
    // Ada was on seat 0 and Grace on seat 1.
    persisted =
      table !== null &&
      findSeat(table, 0)?.label === "Grace Hopper" &&
      findSeat(table, 1)?.label === "Ada Lovelace";
    return result;
  },
  scorers: [
    usesTool("move-seat"),
    successfulToolCall({
      tool: "move-seat",
      expectedInput: (value) => {
        if (typeof value !== "object" || value === null) return false;
        const args = value as Record<string, unknown>;
        return (
          args.fromTableId === "tbl_head" &&
          args.toTableId === "tbl_head" &&
          [args.fromSeat, args.toSeat].every((seat) =>
            [0, 1].includes(seat as number),
          ) &&
          args.fromSeat !== args.toSeat
        );
      },
      // The call returns the table the name landed on, with both names on it.
      expectedResult: (value) =>
        typeof value === "object" &&
        value !== null &&
        JSON.stringify(value).includes('"label":"Ada Lovelace"') &&
        JSON.stringify(value).includes('"label":"Grace Hopper"'),
    }),
    persistedState(() => persisted),
  ],
});
