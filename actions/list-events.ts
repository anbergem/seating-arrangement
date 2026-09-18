import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { listEvents } from "../src/application/use-cases/list-events";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "List the events of the signed-in user's organization, earliest first. An event is the occasion a seating arrangement belongs to — a dinner, a conference, a party — and every table on a floor plan belongs to exactly one of them. Use this when the user asks what is coming up, or to find an event's id before reading or changing its seating. Archived events are left out unless includeArchived is true or status is given explicitly. Read-only: it changes nothing.",
  schema: z.object({
    status: z
      .enum(["active", "archived"])
      .optional()
      .describe("Only events in this status"),
    includeArchived: z
      .boolean()
      .optional()
      .describe("Include archived events as well as the active ones"),
  }),
  http: { method: "GET" },
  readOnly: true,
  mcpTool: true,
  run: (args, ctx) =>
    runAppAction(ctx, "list-events", (actor, deps) =>
      listEvents(deps, actor, args),
    ),
});
