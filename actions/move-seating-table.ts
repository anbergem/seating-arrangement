import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { moveSeatingTable } from "../src/application/use-cases/move-seating-table";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Move a table to a different place on its event's floor plan. gridX and gridY are the top-left corner of the table's bounding box in grid cells, counting from 0, on a grid 16 across and 10 down; that box includes the table's seats, so a straight table of 4 with end seats is 6 cells wide and 3 cells tall, and an L of [4, 3] with end seats is 6 by 5. A table covers only the cells its body and its remaining chairs actually stand on, not the whole box, so two tables may meet at an edge. Read get-event first to see where everything currently stands. Fails with INVARIANT when the destination is off the grid or on top of another table, and with CONFLICT when somebody moved a table into that space between your read and this call. Reversible: undo-operation puts the table back where it was, unless that spot has been taken since.",
  schema: z.object({
    tableId: z.string().min(1).describe("Id of the table to move"),
    gridX: z
      .number()
      .int()
      .min(0)
      .describe("New left edge in grid cells, counting from 0"),
    gridY: z
      .number()
      .int()
      .min(0)
      .describe("New top edge in grid cells, counting from 0"),
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
      `Moved table ${args.tableId} to ${args.gridX},${args.gridY}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "move-seating-table", (actor, deps) =>
      moveSeatingTable(deps, actor, args),
    ),
});
