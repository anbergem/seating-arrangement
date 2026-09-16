import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { listCustomers } from "../src/application/use-cases/list-customers";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "List the customers of the signed-in user's organization. Use when the user asks which customers exist, or to find a customer's id before creating a job for them. Archived customers are left out unless includeArchived is true. Read-only: it changes nothing.",
  schema: z.object({
    includeArchived: z
      .boolean()
      .optional()
      .describe("Include archived customers as well as active ones"),
    search: z
      .string()
      .optional()
      .describe("Case-insensitive substring of the customer name"),
  }),
  http: { method: "GET" },
  readOnly: true,
  mcpTool: true,
  run: (args, ctx) =>
    runAppAction(ctx, "list-customers", (actor, deps) =>
      listCustomers(deps, actor, args),
    ),
});
