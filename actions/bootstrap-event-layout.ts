import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { bootstrapEventLayout } from "../src/application/use-cases/bootstrap-event-layout";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Lay out an L- or U-shaped arrangement on an empty floor plan in one go. A table is never itself bent: a layout is a run of ordinary rectangular tables standing end to end, and this places every one of them and takes off the chairs that would be inside a neighbour's body — the two at each join, and the ones inside each corner. Sections are counts of tables: an L takes [across, down] and a U takes [leftWing, middle, rightWing], with the middle running across the top and a wing hanging down from each of its ends. The room grows to fit, so you do not have to work out the size first. Refused with INVARIANT when the event already has tables — it is for an empty plan; add tables one at a time with create-seating-table instead. Compensatable, not reversible: undo-operation takes the whole layout back off and restores the previous room size, and it cannot be redone.",
  schema: z.object({
    eventId: z
      .string()
      .min(1)
      .describe("Id of the active event whose plan is still empty"),
    layout: z
      .enum(["L", "U"])
      .describe(
        "L is two runs meeting at a right angle; U is a middle run with a wing hanging down from each end",
      ),
    sections: z
      .array(z.number().int().min(1).max(12))
      .min(2)
      .max(3)
      .describe(
        "How many tables are in each section: two numbers for an L ([across, down]), three for a U ([leftWing, middle, rightWing])",
      ),
    tableLength: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe(
        "How long each table in the layout is, in cells. Every table in the arrangement is the same length; a table of length n seats 2n down its two sides",
      ),
    endSeats: z
      .boolean()
      .optional()
      .describe(
        "A chair capping each far end of the arrangement. The chairs at the joins between tables come off either way. Defaults to true",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (args) => ({ type: "event", id: args.eventId, visibility: "org" }),
    summary: (args) =>
      `Laid out a ${args.layout} of ${args.sections.join(" + ")} tables`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "bootstrap-event-layout", (actor, deps) =>
      bootstrapEventLayout(deps, actor, args),
    ),
});
