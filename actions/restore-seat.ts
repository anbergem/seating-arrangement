import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { restoreSeat } from "../src/application/use-cases/restore-seat";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Put a chair back on a table after remove-seat took it away. It needs the space it used to stand in, which a neighbouring table may have taken in the meantime — that is usually why it was removed — so it can fail with INVARIANT or CONFLICT. Move whatever is in the way first. Reversible: undo-operation takes the chair away again.",
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
    summary: (args) => `Put back seat ${args.seat + 1}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "restore-seat", (actor, deps) =>
      restoreSeat(deps, actor, args),
    ),
});
