import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getEvent } from "../src/application/use-cases/get-event";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Read one event of the signed-in user's organization together with its whole seating arrangement: every table still on the floor plan, where each one stands, and what is written on each of its seats. This is the action to call before moving a table or labelling a seat, both because it gives you the table ids and because it gives you the version each of those calls should pass as expectedVersion. Tables that have been removed are left out. Fails with NOT_FOUND when no such event belongs to the organization. Read-only: it changes nothing.",
  schema: z.object({
    eventId: z.string().min(1).describe("Id of the event to read"),
  }),
  http: { method: "GET" },
  readOnly: true,
  mcpTool: true,
  run: (args, ctx) =>
    runAppAction(ctx, "get-event", (actor, deps) =>
      getEvent(deps, actor, args),
    ),
});
