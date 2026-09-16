import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getCustomer } from "../src/application/use-cases/get-customer";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Read one customer of the signed-in user's organization by id, including its contact details, status and version. Use when you already have a customer id and need the record itself; use list-customers to find the id. Fails with NOT_FOUND when no such customer belongs to the organization. Read-only: it changes nothing.",
  schema: z.object({
    customerId: z.string().min(1).describe("Id of the customer to read"),
  }),
  http: { method: "GET" },
  readOnly: true,
  mcpTool: true,
  run: (args, ctx) =>
    runAppAction(ctx, "get-customer", (actor, deps) =>
      getCustomer(deps, actor, args),
    ),
});
