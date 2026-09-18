import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { archiveSeatingTable } from "../src/application/use-cases/archive-seating-table";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Take a table off an event's floor plan. The table keeps its seats and their names, and the space it stood in becomes free for another table. Reversible: undo-operation puts it back — but only while its old space is still free, so a table removed and then built over cannot be restored. Ask the user before calling it.",
  schema: z.object({
    tableId: z.string().min(1).describe("Id of the table to remove"),
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
    summary: (args) => `Removed table ${args.tableId}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "archive-seating-table", (actor, deps) =>
      archiveSeatingTable(deps, actor, args),
    ),
});
