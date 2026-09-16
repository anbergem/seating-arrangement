import {
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useFormatters, useT } from "@agent-native/core/client/i18n";
import { useOrgRole } from "@agent-native/core/client/org";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";

import {
  translatedActionError,
  type ActivityItem,
  type CommandResult,
} from "@/components/activity/action-ui";
import { ActivityList } from "@/components/activity/ActivityList";
import { useOperationFeedback } from "@/components/activity/use-operation-feedback";
import { StatusBadge } from "@/components/jobs/StatusBadge";
import type { Job } from "@/components/jobs/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Detail {
  job: Job;
  customerName: string | null;
  accountingExportStatus: "pending" | "completed" | null;
}
interface ExportResult extends CommandResult<Job> {
  externalReference: string;
}

function useJobMutation(name: string) {
  const t = useT();
  const feedback = useOperationFeedback([
    "list-jobs",
    "get-job",
    "list-recent-activity",
  ]);
  return useActionMutation<CommandResult<Job>, Record<string, unknown>>(name, {
    onSuccess: (result) => void feedback.success(result, t("jobs.changed")),
    onError: (error) => toast.error(translatedActionError(error, t)),
  });
}

export default function JobDetailRoute() {
  const { id = "" } = useParams();
  const t = useT();
  const fmt = useFormatters();
  const qc = useQueryClient();
  const { canManageOrg } = useOrgRole();
  const [when, setWhen] = useState("");
  const [confirmExport, setConfirmExport] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const detail = useActionQuery<Detail>("get-job", { jobId: id });
  const activity = useActionQuery<ActivityItem[]>("list-recent-activity", {
    resourceType: "job",
    resourceId: id,
  });
  const start = useJobMutation("start-job");
  const complete = useJobMutation("complete-job");
  const reschedule = useJobMutation("reschedule-job");
  const archive = useJobMutation("archive-job");
  const accounting = useActionMutation<
    ExportResult,
    { jobId: string; expectedVersion?: number }
  >("send-job-to-accounting", {
    onSuccess: (result) => {
      setReference(result.externalReference);
      setConfirmExport(false);
      void qc.invalidateQueries({ queryKey: ["action"] });
      toast.success(t("jobs.accountingSent"));
    },
    onError: (error) => toast.error(translatedActionError(error, t)),
  });
  if (detail.isLoading) return <div className="p-6">{t("common.loading")}</div>;
  if (!detail.data || detail.error)
    return (
      <div className="p-6 text-destructive">
        {translatedActionError(detail.error, t)}
      </div>
    );
  const { job, customerName, accountingExportStatus } = detail.data;
  const args = { jobId: job.id, expectedVersion: job.version };
  const busy =
    start.isPending ||
    complete.isPending ||
    reschedule.isPending ||
    archive.isPending ||
    accounting.isPending;
  const canExport =
    canManageOrg &&
    (accountingExportStatus === "pending" ||
      (job.status === "completed" && accountingExportStatus === null));
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div className="flex justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{job.title}</h1>
          <p className="text-muted-foreground">{customerName}</p>
        </div>
        <StatusBadge status={job.status} testId="job-status" />
      </div>
      {job.description ? <p>{job.description}</p> : null}
      <p>
        {t("jobs.scheduledFor", {
          date: fmt.formatDate(job.scheduledAt, {
            dateStyle: "long",
            timeStyle: "short",
          }),
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        {job.status === "scheduled" ? (
          <Button
            data-testid="start-job"
            disabled={busy}
            onClick={() => start.mutate(args)}
          >
            {t("jobs.start")}
          </Button>
        ) : null}
        {job.status !== "completed" && job.status !== "archived" ? (
          <Button
            data-testid="complete-job"
            disabled={busy}
            onClick={() => complete.mutate(args)}
          >
            {t("jobs.complete")}
          </Button>
        ) : null}
        {job.status !== "archived" ? (
          <Button
            data-testid="archive-job"
            disabled={busy}
            variant="outline"
            onClick={() => archive.mutate(args)}
          >
            {t("common.archive")}
          </Button>
        ) : null}
        {canExport ? (
          <Button
            data-testid="send-accounting"
            disabled={busy}
            variant="outline"
            onClick={() => setConfirmExport(true)}
          >
            {accountingExportStatus === "pending"
              ? t("jobs.retryAccounting")
              : t("jobs.sendAccounting")}
          </Button>
        ) : null}
      </div>
      {job.status !== "completed" && job.status !== "archived" ? (
        <div className="flex gap-2">
          <Input
            aria-label={t("jobs.reschedule")}
            data-testid="reschedule-at"
            type="datetime-local"
            value={when}
            onChange={(event) => setWhen(event.target.value)}
          />
          <Button
            data-testid="reschedule-job"
            disabled={!when || busy}
            variant="outline"
            onClick={() =>
              reschedule.mutate({
                ...args,
                scheduledAt: new Date(when).toISOString(),
              })
            }
          >
            {t("jobs.reschedule")}
          </Button>
        </div>
      ) : null}
      <AlertDialog.Root open={confirmExport} onOpenChange={setConfirmExport}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-background p-6 shadow-lg">
            <AlertDialog.Title className="text-lg font-semibold">
              {t("jobs.confirmAccountingTitle")}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
              {accountingExportStatus === "pending"
                ? t("jobs.confirmAccountingRetry")
                : t("jobs.confirmAccounting")}
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button variant="outline">{t("common.cancel")}</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  data-testid="confirm-accounting"
                  disabled={busy}
                  onClick={() => accounting.mutate(args)}
                >
                  {t("common.confirm")}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      {reference || job.accountingReference ? (
        <p>
          {t("jobs.accountingReference", {
            reference: reference ?? job.accountingReference,
          })}
        </p>
      ) : null}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("activity.jobHistory")}</h2>
        {activity.isLoading ? (
          <p>{t("common.loading")}</p>
        ) : activity.error ? (
          <p className="text-destructive">
            {translatedActionError(activity.error, t)}
          </p>
        ) : activity.data?.length ? (
          <ActivityList items={activity.data} />
        ) : (
          <p>{t("activity.empty")}</p>
        )}
      </section>
    </div>
  );
}
