import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { shiftSeats } from "../src/application/use-cases/shift-seats";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Move everybody along a row of chairs by one place, so that the chair you name is freed for somebody new. Chairs are followed as they actually stand, so a shift runs along a table, round the end of it, and on to the next table when two are pushed together — which is how it works along one side of an L or a U. The shift stops at the first empty chair, and chairs past that one are not touched. If the chairs go all the way round a table and every one of them is taken there is nowhere to leave a gap, so the whole table turns by one instead and the last person comes round to the chair you named; a rectangular table with no chair at either end never goes all the way round, so it can only be shifted along. Name the direction with towardTableId and towardSeat: the next chair along the way you want people to move, which get-event's seat order and the table positions let you work out. Fails with INVARIANT when nobody is on the seat, when every chair along the way is taken and the row does not close, and when the chair is not there because a neighbouring table is standing in it; with VALIDATION when the seat you name to shift toward is not the next chair along. Reversible: undo-operation puts everybody back.",
  schema: z.object({
    tableId: z
      .string()
      .min(1)
      .describe("Id of the table holding the chair to free"),
    seat: z
      .number()
      .int()
      .min(0)
      .describe(
        "Which seat to free, counting clockwise from 0 in the order get-event returns them",
      ),
    towardTableId: z
      .string()
      .min(1)
      .describe(
        "Id of the table holding the next chair along; the same id for a shift that stays on one table",
      ),
    towardSeat: z
      .number()
      .int()
      .min(0)
      .describe("The next chair along in the direction people should move"),
    expectedVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Version of the table, last read with get-event; the call fails with CONFLICT if it changed since",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (args) => ({
      type: "seating_table",
      id: args.tableId,
      visibility: "org",
    }),
    // Built from the arguments alone, which do not carry anybody's name — the
    // same reason `move-seating-table` names a table by its id here.
    summary: (args) =>
      `Shifted the seats along from seat ${args.seat + 1} of ${args.tableId}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "shift-seats", (actor, deps) =>
      shiftSeats(deps, actor, args),
    ),
});
