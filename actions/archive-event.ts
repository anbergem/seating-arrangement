import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { archiveEvent } from "../src/application/use-cases/archive-event";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Archive an event, taking it and its whole seating arrangement out of the active list. Only an admin or owner may do this, because it hides a whole floor plan at once. The tables themselves are untouched, so restoring the event restores the arrangement exactly as it was. Reversible: undo-operation puts the event back. Ask the user before calling it.",
  schema: z.object({
    eventId: z.string().min(1).describe("Id of the event to archive"),
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
    target: (args) => ({
      type: "event",
      id: args.eventId,
      visibility: "org",
    }),
    summary: (args) => `Archived event ${args.eventId}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "archive-event", (actor, deps) =>
      archiveEvent(deps, actor, args),
    ),
});
