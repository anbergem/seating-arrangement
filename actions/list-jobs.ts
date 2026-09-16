import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { listJobs } from "../src/application/use-cases/list-jobs";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "List the jobs of the signed-in user's organization, earliest scheduled first. Use when the user asks what work is scheduled, in progress or done, or to find a job's id before acting on it. Archived jobs are left out unless includeArchived is true or status is given explicitly. Read-only: it changes nothing.",
  schema: z.object({
    status: z
      .enum(["scheduled", "in_progress", "completed", "archived"])
      .optional()
      .describe("Only jobs in this status"),
    customerId: z
      .string()
      .min(1)
      .optional()
      .describe("Only jobs for this customer"),
    from: z
      .string()
      .datetime()
      .optional()
      .describe(
        "ISO 8601 instant; only jobs scheduled at or after it (inclusive)",
      ),
    to: z
      .string()
      .datetime()
      .optional()
      .describe("ISO 8601 instant; only jobs scheduled before it (exclusive)"),
    includeArchived: z
      .boolean()
      .optional()
      .describe("Include archived jobs as well as the active ones"),
  }),
  http: { method: "GET" },
  readOnly: true,
  mcpTool: true,
  run: (args, ctx) =>
    runAppAction(ctx, "list-jobs", (actor, deps) =>
      listJobs(deps, actor, args),
    ),
});
