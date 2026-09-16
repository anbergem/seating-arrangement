import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";

import {
  translatedActionError,
  type ActivityItem,
} from "@/components/activity/action-ui";
import { ActivityList } from "@/components/activity/ActivityList";
import { useOperationFeedback } from "@/components/activity/use-operation-feedback";
export default function ActivityRoute() {
  const t = useT();
  const feedback = useOperationFeedback([
    "list-recent-activity",
    "list-jobs",
    "get-job",
    "list-customers",
    "get-customer",
  ]);
  const activity = useActionQuery<ActivityItem[]>("list-recent-activity", {
    limit: 100,
  });
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("activity.title")}</h1>
        <p className="text-muted-foreground">{t("activity.description")}</p>
      </div>
      {activity.isLoading ? (
        <p>{t("common.loading")}</p>
      ) : activity.error ? (
        <p className="text-destructive">
          {translatedActionError(activity.error, t)}
        </p>
      ) : activity.data?.length ? (
        <ActivityList
          items={activity.data}
          busy={feedback.busy}
          onUndo={feedback.undo}
          onRedo={feedback.redo}
        />
      ) : (
        <p>{t("activity.empty")}</p>
      )}
    </div>
  );
}
