import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { archiveJob } from "../src/application/use-cases/archive-job";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Archive a job, taking it out of the active list without deleting anything. Allowed from status scheduled, in_progress or completed; an already archived job fails with INVARIANT. Reversible with undo-operation, which restores the status the job had before it was archived.",
  schema: z.object({
    jobId: z.string().min(1).describe("Id of the job to archive"),
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
    summary: (args) => `Archived job ${args.jobId}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "archive-job", (actor, deps) =>
      archiveJob(deps, actor, args),
    ),
});
