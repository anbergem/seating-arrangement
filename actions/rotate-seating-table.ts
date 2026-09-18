import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { rotateSeatingTable } from "../src/application/use-cases/rotate-seating-table";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Turn a rectangular table a quarter turn clockwise, between lying across the room and standing down it, through rotation 0, 90, 180 and 270. Nobody is reseated: a seat keeps its number and its place around the table, and only the direction the table faces changes. Refused with INVARIANT for a round table, whose square body would turn into itself. The table pivots about its own centre, so it turns roughly where it stands, and it also fails with INVARIANT when it would swing outside the room or into another table — a long table usually needs clear space on both sides of it to turn. Reversible: undo-operation turns it back and returns it to where it was.",
  schema: z.object({
    tableId: z.string().min(1).describe("Id of the table to turn"),
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
    summary: (args) => `Turned table ${args.tableId}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "rotate-seating-table", (actor, deps) =>
      rotateSeatingTable(deps, actor, args),
    ),
});
