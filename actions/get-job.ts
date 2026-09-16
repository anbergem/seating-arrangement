import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getJob } from "../src/application/use-cases/get-job";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Read one job of the signed-in user's organization by id, together with its customer's name and accountingExportStatus. A pending accounting export can be retried by an admin or owner even after the job is archived. Use it after any change to a job to report what actually happened, and to read the version before a call that takes expectedVersion. Fails with NOT_FOUND when no such job belongs to the organization. Read-only: it changes nothing.",
  schema: z.object({
    jobId: z.string().min(1).describe("Id of the job to read"),
  }),
  http: { method: "GET" },
  readOnly: true,
  mcpTool: true,
  run: (args, ctx) =>
    runAppAction(ctx, "get-job", (actor, deps) => getJob(deps, actor, args)),
});
