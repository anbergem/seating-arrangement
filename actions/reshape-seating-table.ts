import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { reshapeSeatingTable } from "../src/application/use-cases/reshape-seating-table";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Change a table's form: whether it is rectangular or round, how big it is, and whether a rectangle's two ends carry a seat. Seats are derived from the form, so this renumbers them — a rectangle of length n has 2n seats plus its ends, a round table of diameter n has 4n. Names are carried over by seat number, which across a change of kind is frankly a guess, so re-read the plan afterwards and check who ended up where. A bigger table needs the extra space to be free. Reversible: undo-operation restores the previous form with every name back on the seat it was on.",
  schema: z.object({
    tableId: z.string().min(1).describe("Id of the table to reshape"),
    kind: z
      .enum(["rectangle", "round"])
      .describe(
        "rectangle is a straight run; round is a circular table with chairs all the way around",
      ),
    size: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe(
        "How big the table is, in grid cells: a rectangle's length along its run (1 to 8), or a round table's diameter (1 to 4). A round table of diameter n seats 4n",
      ),
    endSeats: z
      .boolean()
      .describe(
        "A seat capping each end of a rectangle's run. Ignored for a round table",
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
    summary: (args) =>
      `Reshaped table ${args.tableId} to a ${args.kind} of ${args.size}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "reshape-seating-table", (actor, deps) =>
      reshapeSeatingTable(deps, actor, args),
    ),
});
