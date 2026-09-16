import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { createJob } from "../src/application/use-cases/create-job";
import { runAppAction } from "../src/interface/run-app-action";

/** See `create-customer.ts` for why this is structural and optional-chained. */
function createdId(result: unknown): string | undefined {
  return (result as { resource?: { id?: string } } | undefined)?.resource?.id;
}

export default defineAction({
  description:
    "Create a job for one customer of the signed-in user's organization. Use after list-customers or get-customer has established which customer the work is for. The customer must exist in the organization and still be active, or the call fails with NOT_FOUND; an assignedTo who is not a member of the organization fails with VALIDATION. The job starts in status scheduled. Compensatable, not reversible: undo-operation archives the job rather than deleting it.",
  schema: z.object({
    customerId: z
      .string()
      .min(1)
      .describe("Id of the active customer the job is for"),
    title: z.string().min(1).describe("Short job title, 1 to 200 characters"),
    description: z
      .string()
      .optional()
      .describe("What the work involves, at most 5000 characters"),
    scheduledAt: z
      .string()
      .datetime()
      .describe("ISO 8601 instant the job is scheduled for"),
    assignedTo: z
      .string()
      .optional()
      .describe(
        "Email of the organization member the job is assigned to; leave empty for unassigned",
      ),
    idempotencyKey: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Pass the same key when retrying a call whose outcome you did not see; the second call returns the job the first one created instead of creating another",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (_args, result) => ({
      type: "job",
      id: createdId(result),
      visibility: "org",
    }),
    summary: (args) => `Created job ${args.title}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "create-job", (actor, deps) =>
      createJob(deps, actor, args),
    ),
});
