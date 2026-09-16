import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { listRecentActivity } from "../src/application/use-cases/list-recent-activity";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "List what has recently been done in the signed-in user's organization, newest first: who changed which customer or job, when, and through which surface. Use when the user asks what changed, or to find the operationId to pass to undo-operation or redo-operation. Each entry carries undoable and redoable, computed against the record's current version, so an entry that someone else has since changed is reported as not undoable. Read-only: it changes nothing.",
  schema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many operations to return; defaults to 20, at most 100"),
    resourceType: z
      .enum(["customer", "job"])
      .optional()
      .describe("Only the history of one record; requires resourceId"),
    resourceId: z
      .string()
      .min(1)
      .optional()
      .describe("Id of that record; requires resourceType"),
  }),
  http: { method: "GET" },
  readOnly: true,
  mcpTool: true,
  run: (args, ctx) =>
    runAppAction(ctx, "list-recent-activity", (actor, deps) =>
      listRecentActivity(deps, actor, args),
    ),
});
