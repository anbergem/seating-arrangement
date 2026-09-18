import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { removeSeat } from "../src/application/use-cases/remove-seat";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Take one chair off a table, freeing the space it stood in so a neighbouring table can use it. This is how two tables are brought end to end into a continuous run: the chair capping one table's end stands exactly where the next table's body has to go. bootstrap-event-layout does all of this for you on an empty plan; use this when building or extending an arrangement by hand. The seat must be empty — clear its name with label-seat first, because freeing space is not a reason to discard somebody's place. Reversible: undo-operation puts the chair back, unless the space has been taken since.",
  schema: z.object({
    tableId: z.string().min(1).describe("Id of the table the seat belongs to"),
    seat: z
      .number()
      .int()
      .min(0)
      .describe(
        "Which seat, counting clockwise from 0 in the order get-event returns them",
      ),
    expectedVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Version last read with get-event; the call fails with CONFLICT if the table changed since",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (args) => ({
      type: "seating_table",
      id: args.tableId,
      visibility: "org",
    }),
    summary: (args) => `Took away seat ${args.seat + 1}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "remove-seat", (actor, deps) =>
      removeSeat(deps, actor, args),
    ),
});
