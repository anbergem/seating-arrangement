import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { rescheduleJob } from "../src/application/use-cases/reschedule-job";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Move a job to a different scheduled time. Allowed from status scheduled or in_progress; a completed or archived job fails with INVARIANT, and so does moving a job to the instant it already has. Reversible with undo-operation, which puts the job back on its previous time.",
  schema: z.object({
    jobId: z.string().min(1).describe("Id of the job to reschedule"),
    scheduledAt: z
      .string()
      .datetime()
      .describe("ISO 8601 instant to move the job to"),
    expectedVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Version the caller last saw; the call fails with CONFLICT if it changed",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (args) => ({ type: "job", id: args.jobId, visibility: "org" }),
    summary: (args) => `Rescheduled job ${args.jobId} to ${args.scheduledAt}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "reschedule-job", (actor, deps) =>
      rescheduleJob(deps, actor, args),
    ),
});
