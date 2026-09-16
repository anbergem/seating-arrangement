import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { completeJob } from "../src/application/use-cases/complete-job";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Mark a job as completed. Use when the work for a job is done. Allowed from status scheduled or in_progress — a job need not have been started first; a completed or archived job fails with INVARIANT. Reversible with undo-operation, which restores the status the job had before.",
  schema: z.object({
    jobId: z.string().min(1).describe("Id of the job to complete"),
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
    summary: (args) => `Completed job ${args.jobId}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "complete-job", (actor, deps) =>
      completeJob(deps, actor, args),
    ),
});
