import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { resizeRoom } from "../src/application/use-cases/resize-room";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Change how big an event's room is, in grid cells. Every event has its own floor: a new one starts at 16 across by 10 down, and bootstrap-event-layout enlarges it when a layout needs more. Growing always works. Shrinking is refused with INVARIANT when a table would be left outside the new bounds, and the message names the table, so move that table first and try again. Read get-event for the current size and version. Reversible: undo-operation puts the previous size back, unless a table has since been placed in the space that would disappear.",
  schema: z.object({
    eventId: z.string().min(1).describe("Id of the event whose room to resize"),
    width: z.number().int().min(4).max(64).describe("Cells across, 4 to 64"),
    height: z.number().int().min(4).max(40).describe("Cells down, 4 to 40"),
    expectedVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Version last read with get-event; the call fails with CONFLICT if the event changed since",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (args) => ({ type: "event", id: args.eventId, visibility: "org" }),
    summary: (args) => `Resized the room to ${args.width} by ${args.height}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "resize-room", (actor, deps) =>
      resizeRoom(deps, actor, args),
    ),
});
