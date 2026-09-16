import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { redoOperation } from "../src/application/use-cases/redo-operation";
import { runAppAction } from "../src/interface/run-app-action";

/** See `undo-operation.ts`: the same result shape, read the same way and for
 * the same reason (blueprint B2). */
type UndoRedoResultShape =
  | { resourceType?: string; resource?: { id?: string } }
  | undefined;

export default defineAction({
  description:
    "Redo an operation that was undone, re-applying the original change. Takes the operationId of an undo operation — the one undo-operation returned, or an entry of list-recent-activity whose redoable flag is true. Refuses with CONFLICT if the record changed since the undo, and with INVARIANT for the undo of a create, which is a compensation and is never re-applied.",
  schema: z.object({
    operationId: z
      .string()
      .min(1)
      .describe(
        "Id of the undo operation to reverse — not the forward operation it undid",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (_args, result) => {
      const redone = result as UndoRedoResultShape;
      return {
        type: redone?.resourceType,
        id: redone?.resource?.id,
        visibility: "org",
      };
    },
    summary: (args) => `Redid operation ${args.operationId}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "redo-operation", (actor, deps) =>
      redoOperation(deps, actor, args),
    ),
});
