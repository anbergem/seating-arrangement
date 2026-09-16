import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { startJob } from "../src/application/use-cases/start-job";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Mark a job as in progress. Use when work on it has begun. Allowed from status scheduled only; a job that is already in_progress, completed or archived fails with INVARIANT. Reversible with undo-operation, which puts the job back to scheduled.",
  schema: z.object({
    jobId: z.string().min(1).describe("Id of the job to start"),
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
    summary: (args) => `Started job ${args.jobId}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "start-job", (actor, deps) =>
      startJob(deps, actor, args),
    ),
});
