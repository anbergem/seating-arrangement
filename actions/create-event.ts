import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { createEvent } from "../src/application/use-cases/create-event";
import { runAppAction } from "../src/interface/run-app-action";

/** Structural and optional-chained: `audit.target` runs whatever the action
 * returned, including a failure, and must not throw on it. */
function createdId(result: unknown): string | undefined {
  return (result as { resource?: { id?: string } } | undefined)?.resource?.id;
}

export default defineAction({
  description:
    "Create an event for the signed-in user's organization. An event is the occasion that owns one seating arrangement, so this is the first thing to do before any table exists: create the event, then add tables to it with create-seating-table. Compensatable, not reversible: undo-operation archives the event rather than deleting it, and its tables come back with it.",
  schema: z.object({
    name: z
      .string()
      .min(1)
      .describe("What the event is called, 1 to 120 characters"),
    startsAt: z
      .string()
      .datetime()
      .describe("ISO 8601 instant the event starts"),
    idempotencyKey: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Pass the same key when retrying a call whose outcome you did not see; the second call returns the event the first one created instead of creating another",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (_args, result) => ({
      type: "event",
      id: createdId(result),
      visibility: "org",
    }),
    summary: (args) => `Created event ${args.name}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "create-event", (actor, deps) =>
      createEvent(deps, actor, args),
    ),
});
