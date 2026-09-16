import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { undoOperation } from "../src/application/use-cases/undo-operation";
import { runAppAction } from "../src/interface/run-app-action";

/** The record an undo or redo touched, read out of the use case's result,
 * which carries `resourceType` precisely so the audit target needs no second
 * lookup. Read structurally rather than imported, because `actions/` may not
 * import `src/domain` (blueprint B2) and the audit hook is handed the result as
 * `unknown`; every field is optional-chained because the same hook runs on the
 * error path, where there is no result at all. */
type UndoRedoResultShape =
  | { resourceType?: string; resource?: { id?: string } }
  | undefined;

export default defineAction({
  description:
    "Undo a previous operation when no newer change exists. Refuses with CONFLICT if the record changed since. Takes the operationId of a forward operation — from list-recent-activity, or the operationId a command returned. Undoing a create archives the record rather than deleting it; undoing a transition restores exactly the fields it changed. Reverse an undo with redo-operation.",
  schema: z.object({
    operationId: z
      .string()
      .min(1)
      .describe(
        "Id of the operation to undo, as reported by the command that performed it or by list-recent-activity",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (_args, result) => {
      const undone = result as UndoRedoResultShape;
      return {
        type: undone?.resourceType,
        id: undone?.resource?.id,
        visibility: "org",
      };
    },
    summary: (args) => `Undid operation ${args.operationId}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "undo-operation", (actor, deps) =>
      undoOperation(deps, actor, args),
    ),
});
