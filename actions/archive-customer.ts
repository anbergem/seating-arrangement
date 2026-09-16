import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { archiveCustomer } from "../src/application/use-cases/archive-customer";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Archive a customer of the signed-in user's organization, taking them out of the active list without deleting anything. Allowed only from status active; an already archived customer fails with INVARIANT. Restricted to the admin and owner roles: a member is refused with AUTHORIZATION. Reversible with undo-operation, which restores the customer.",
  schema: z.object({
    customerId: z.string().min(1).describe("Id of the customer to archive"),
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
    target: (args) => ({
      type: "customer",
      id: args.customerId,
      visibility: "org",
    }),
    summary: (args) => `Archived customer ${args.customerId}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "archive-customer", (actor, deps) =>
      archiveCustomer(deps, actor, args),
    ),
});
