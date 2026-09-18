import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { labelSeat } from "../src/application/use-cases/label-seat";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Write a name on one seat of one table — this is how a guest is seated. Seats are numbered clockwise around the table starting from 0, and get-event returns them in that order with their labels, so read it first to see which number you want and which are still empty. The numbering follows the table's shape, so reshaping a table renumbers its seats. A seat get-event reports as blocked has a neighbouring table standing in it and cannot be named until that table moves; naming somebody is also what makes a chair claim its space, so it can be refused with INVARIANT for want of room. An empty label clears the seat. Reversible: undo-operation puts the previous name back.",
  schema: z.object({
    tableId: z.string().min(1).describe("Id of the table the seat belongs to"),
    seat: z
      .number()
      .int()
      .min(0)
      .describe(
        "Which seat, counting clockwise from 0 in the order get-event returns them",
      ),
    label: z
      .string()
      .max(32)
      .describe("The name to write on the seat, or empty to clear it"),
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
      args.label
        ? `Seated ${args.label} at seat ${args.seat + 1}`
        : `Cleared seat ${args.seat + 1}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "label-seat", (actor, deps) =>
      labelSeat(deps, actor, args),
    ),
});
