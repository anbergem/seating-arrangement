import { defineEval, usesTool } from "@agent-native/core/eval";

import { footprintSize } from "../src/domain/index.ts";
import { getDependencies } from "../src/infrastructure/container.ts";
import {
  MODEL_EVAL_SKIP_REASON,
  persistedState,
  resetEvalScenario,
  successfulToolCall,
} from "./helpers.ts";

let persisted = false;

export default defineEval({
  name: "move a table to a free part of the floor plan",
  // `tbl_head` is at 0,0 and `tbl_side` at 4,0, so the only way to satisfy
  // this is to read the plan first and pick somewhere that is actually empty.
  // Anywhere on the lower half of the grid qualifies; the eval scores that the
  // table moved and did not land on its neighbour, not one exact cell.
  input: {
    prompt:
      "Move Table 2 down to the lower half of the room at the Spring Gala, somewhere it is not touching anything else.",
  },
  skipReason: MODEL_EVAL_SKIP_REASON,
  threshold: 1,
  run: async ({ input, runAgent }) => {
    await resetEvalScenario();
    const result = await runAgent(input);
    const deps = getDependencies();
    const moved = await deps.seatingTables.getById("org_acme", "tbl_side");
    const head = await deps.seatingTables.getById("org_acme", "tbl_head");
    const movedBox = moved && footprintSize(moved);
    const headBox = head && footprintSize(head);
    persisted =
      moved !== null &&
      head !== null &&
      movedBox !== null &&
      headBox !== null &&
      moved.gridY >= 4 &&
      // Still a legal plan: the two bounding boxes do not intersect.
      (moved.gridY >= head.gridY + headBox.height ||
        head.gridY >= moved.gridY + movedBox.height ||
        moved.gridX >= head.gridX + headBox.width ||
        head.gridX >= moved.gridX + movedBox.width);
    return result;
  },
  scorers: [
    usesTool("move-seating-table"),
    successfulToolCall({
      tool: "move-seating-table",
      expectedInput: (value) =>
        typeof value === "object" &&
        value !== null &&
        (value as { tableId?: unknown }).tableId === "tbl_side",
      expectedResult: (value) =>
        typeof value === "object" && value !== null && !("error" in value),
    }),
    persistedState(() => persisted),
  ],
});
