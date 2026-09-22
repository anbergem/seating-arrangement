import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { moveSeat } from "../src/application/use-cases/move-seat";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Move the name on one seat to another seat — this is how a seated guest is moved, at the same table or to a different one at the same event. If the destination seat already has a name, the two **swap**: nobody is ever overwritten or removed by this action. Seats are numbered clockwise from 0 and get-event returns them in that order with their labels and each table's version, so read it first to see which numbers and which tables you want. Both seats must be at the same event. Fails with INVARIANT when the seat you are moving from is empty, when both seats already have the same name, and when the destination has a neighbouring table standing in it — naming somebody is what makes a chair claim its space. Fails with CONFLICT when either table changed since you read it. Reversible: undo-operation puts both names back where they were.",
  schema: z.object({
    fromTableId: z.string().min(1).describe("Id of the table the name is on"),
    fromSeat: z
      .number()
      .int()
      .min(0)
      .describe(
        "Which seat the name is on, counting clockwise from 0 in the order get-event returns them",
      ),
    toTableId: z
      .string()
      .min(1)
      .describe(
        "Id of the table it is going to; the same id to move it within one table",
      ),
    toSeat: z
      .number()
      .int()
      .min(0)
      .describe("Which seat it is going to, counting clockwise from 0"),
    fromExpectedVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Version of the table the name is on, last read with get-event; the call fails with CONFLICT if it changed since",
      ),
    toExpectedVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Version of the table it is going to, last read with get-event; the call fails with CONFLICT if it changed since",
      ),
  }),
  mcpTool: true,
  audit: {
    // The table the name lands on, matching the operation row's resource.
    target: (args) => ({
      type: "seating_table",
      id: args.toTableId,
      visibility: "org",
    }),
    // A summary is built from the arguments alone, and the arguments do not
    // carry the guest's name — the same reason `move-seating-table` names a
    // table by its id here.
    summary: (args) =>
      args.fromTableId === args.toTableId
        ? `Moved seat ${args.fromSeat + 1} to seat ${args.toSeat + 1} of ${args.toTableId}`
        : `Moved seat ${args.fromSeat + 1} of ${args.fromTableId} to seat ${args.toSeat + 1} of ${args.toTableId}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "move-seat", (actor, deps) =>
      moveSeat(deps, actor, args),
    ),
});
