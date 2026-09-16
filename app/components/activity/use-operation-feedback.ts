import { callAction, useActionMutation } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  translatedActionError,
  type ActivityItem,
  type CommandResult,
} from "./action-ui";

export function useOperationFeedback(queryNames: string[]) {
  const t = useT();
  const queryClient = useQueryClient();
  const invalidate = () =>
    Promise.all(
      queryNames.map((name) =>
        queryClient.invalidateQueries({ queryKey: ["action", name] }),
      ),
    );
  const activity = () =>
    callAction<ActivityItem[]>(
      "list-recent-activity",
      { limit: 100 },
      { method: "GET" },
    );
  const redo = useActionMutation<
    CommandResult<unknown>,
    { operationId: string }
  >("redo-operation", {
    onSuccess: () => {
      void invalidate();
      toast.success(t("activity.redone"));
    },
    onError: (error) => toast.error(translatedActionError(error, t)),
  });
  const undo = useActionMutation<
    CommandResult<unknown>,
    { operationId: string }
  >("undo-operation", {
    onSuccess: async (result) => {
      await invalidate();
      let items: ActivityItem[];
      try {
        items = await activity();
      } catch {
        toast.success(t("activity.undone"));
        return;
      }
      const entry = items.find((item) => item.id === result.operationId);
      toast.success(
        t("activity.undone"),
        entry?.redoable
          ? {
              action: {
                label: t("common.redo"),
                onClick: () => redo.mutate({ operationId: result.operationId }),
              },
            }
          : undefined,
      );
    },
    onError: (error) => toast.error(translatedActionError(error, t)),
  });
  async function success(result: CommandResult<unknown>, message: string) {
    await invalidate();
    let items: ActivityItem[];
    try {
      items = await activity();
    } catch {
      toast.success(message);
      return;
    }
    const entry = items.find((item) => item.id === result.operationId);
    toast.success(
      message,
      entry?.undoable
        ? {
            action: {
              label: t("common.undo"),
              onClick: () => undo.mutate({ operationId: result.operationId }),
            },
          }
        : undefined,
    );
  }
  return {
    busy: undo.isPending || redo.isPending,
    success,
    undo: (operationId: string) => undo.mutate({ operationId }),
    redo: (operationId: string) => redo.mutate({ operationId }),
  };
}
