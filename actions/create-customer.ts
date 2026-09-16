import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { createCustomer } from "../src/application/use-cases/create-customer";
import { runAppAction } from "../src/interface/run-app-action";

/** The created resource's id, read out of the use case's `CommandResult` for
 * the audit target. Structural rather than imported: `actions/` may not import
 * `src/domain` (blueprint B2), and the audit hook is handed the result as
 * `unknown`. It is optional-chained because the same hook runs on the error
 * path, where there is no result at all. */
function createdId(result: unknown): string | undefined {
  return (result as { resource?: { id?: string } } | undefined)?.resource?.id;
}

export default defineAction({
  description:
    "Create a customer in the signed-in user's organization. Use when the user names someone new to schedule work for; check list-customers first so an existing customer is not duplicated. The customer starts active. Compensatable, not reversible: undo-operation archives the customer rather than deleting it, because nothing here deletes.",
  schema: z.object({
    name: z.string().min(1).describe("Customer name, 1 to 200 characters"),
    email: z
      .string()
      .optional()
      .describe("Contact email address, if one is known"),
    phone: z
      .string()
      .optional()
      .describe("Contact phone number, at most 40 characters"),
    notes: z
      .string()
      .optional()
      .describe("Free-text notes about the customer, at most 5000 characters"),
    idempotencyKey: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Pass the same key when retrying a call whose outcome you did not see; the second call returns the customer the first one created instead of creating another",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (_args, result) => ({
      type: "customer",
      id: createdId(result),
      visibility: "org",
    }),
    summary: (args) => `Created customer ${args.name}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "create-customer", (actor, deps) =>
      createCustomer(deps, actor, args),
    ),
});
