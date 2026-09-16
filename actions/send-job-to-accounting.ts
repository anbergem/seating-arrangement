import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { sendJobToAccounting } from "../src/application/use-cases/send-job-to-accounting";
import type { SendJobToAccountingResult } from "../src/application/use-cases/send-job-to-accounting";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Create an invoice draft for a completed job in the accounting system. This external effect is irreversible and requires approval. A retry safely reconciles a pending request.",
  schema: z.object({
    jobId: z.string().min(1).describe("Id of the completed job to export"),
    expectedVersion: z.number().int().positive().optional(),
  }),
  mcpTool: true,
  needsApproval: true,
  audit: {
    target: (args) => ({ type: "job", id: args.jobId, visibility: "org" }),
    summary: (_args, result) => {
      const sent = result as SendJobToAccountingResult;
      return `Sent job ${sent.resource.id} to accounting (${sent.externalReference})`;
    },
  },
  run: (args, ctx) =>
    runAppAction(ctx, "send-job-to-accounting", (actor, deps) =>
      sendJobToAccounting(deps, actor, args),
    ),
});
