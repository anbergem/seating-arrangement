import { useFormatters, useT } from "@agent-native/core/client/i18n";

import { Button } from "@/components/ui/button";

import type { ActivityItem } from "./action-ui";

export function ActivityList({
  items,
  busy,
  onUndo,
  onRedo,
}: {
  items: ActivityItem[];
  busy?: boolean;
  onUndo?: (id: string) => void;
  onRedo?: (id: string) => void;
}) {
  const t = useT();
  const formatters = useFormatters();
  return (
    <div className="divide-y rounded-lg border">
      {items.map((item) => (
        <div
          className="flex flex-wrap items-center justify-between gap-3 p-4"
          key={item.id}
        >
          <div>
            <p className="font-medium">
              {t(`activity.actions.${item.action}`)}
            </p>
            <p className="text-sm text-muted-foreground">
              {t(`activity.kinds.${item.kind}`)} ·{" "}
              {formatters.formatDate(item.performedAt, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </p>
          </div>
          <div className="flex gap-2">
            {item.undoable && onUndo ? (
              <Button
                data-testid={`activity-undo-${item.id}`}
                disabled={busy}
                variant="outline"
                onClick={() => onUndo(item.id)}
              >
                {t("common.undo")}
              </Button>
            ) : null}
            {item.redoable && onRedo ? (
              <Button
                data-testid={`activity-redo-${item.id}`}
                disabled={busy}
                variant="outline"
                onClick={() => onRedo(item.id)}
              >
                {t("common.redo")}
              </Button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
