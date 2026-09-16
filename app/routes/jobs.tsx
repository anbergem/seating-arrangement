import {
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useFormatters, useT } from "@agent-native/core/client/i18n";
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { toast } from "sonner";
import { z } from "zod";

import {
  translatedActionError,
  type CommandResult,
} from "@/components/activity/action-ui";
import { useOperationFeedback } from "@/components/activity/use-operation-feedback";
import type { Customer } from "@/components/customers/types";
import { StatusBadge } from "@/components/jobs/StatusBadge";
import type { Job, JobStatus } from "@/components/jobs/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const schema = z.object({
  customerId: z.string().min(1),
  title: z.string().min(1),
  scheduledAt: z.string().min(1),
});
type Values = z.infer<typeof schema>;

export default function JobsRoute() {
  const t = useT();
  const fmt = useFormatters();
  const feedback = useOperationFeedback(["list-jobs", "list-recent-activity"]);
  const [status, setStatus] = useState<"all" | JobStatus>("all");
  const [open, setOpen] = useState(false);
  const jobs = useActionQuery<Job[]>(
    "list-jobs",
    status === "all" ? {} : { status },
  );
  const customers = useActionQuery<Customer[]>("list-customers", {});
  const create = useActionMutation<CommandResult<Job>, Values>("create-job", {
    onSuccess: (result) => {
      setOpen(false);
      void feedback.success(result, t("jobs.created"));
    },
    onError: (error) => toast.error(translatedActionError(error, t)),
  });
  const { register, handleSubmit, setError, formState } = useForm<Values>();
  const submit = handleSubmit((values) => {
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      setError("title", { message: t("errors.VALIDATION") });
      return;
    }
    create.mutate({
      ...parsed.data,
      scheduledAt: new Date(parsed.data.scheduledAt).toISOString(),
    });
  });
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("jobs.title")}</h1>
          <p className="text-muted-foreground">{t("jobs.description")}</p>
        </div>
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger asChild>
            <Button data-testid="new-job">{t("jobs.new")}</Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(44rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-background p-6 shadow-lg">
              <Dialog.Title className="text-lg font-semibold">
                {t("jobs.new")}
              </Dialog.Title>
              <Dialog.Description className="mb-4 text-sm text-muted-foreground">
                {t("jobs.newDescription")}
              </Dialog.Description>
              <form className="grid gap-3" onSubmit={submit}>
                <select
                  className="rounded-md border bg-background px-3 py-2"
                  aria-label={t("jobs.customer")}
                  {...register("customerId")}
                >
                  <option value="">{t("jobs.chooseCustomer")}</option>
                  {customers.data
                    ?.filter((c) => c.status === "active")
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
                <Input
                  aria-label={t("jobs.name")}
                  placeholder={t("jobs.name")}
                  {...register("title")}
                />
                <Input
                  aria-label={t("jobs.scheduledAt")}
                  type="datetime-local"
                  {...register("scheduledAt")}
                />
                {formState.errors.title ? (
                  <p className="text-sm text-destructive">
                    {formState.errors.title.message}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <Dialog.Close asChild>
                    <Button variant="outline" type="button">
                      {t("common.cancel")}
                    </Button>
                  </Dialog.Close>
                  <Button
                    data-testid="create-job"
                    disabled={create.isPending}
                    type="submit"
                  >
                    {t("common.save")}
                  </Button>
                </div>
              </form>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      <label className="flex items-center gap-2 text-sm">
        {t("jobs.filter")}
        <select
          className="rounded-md border bg-background px-3 py-2"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          {["all", "scheduled", "in_progress", "completed", "archived"].map(
            (value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ),
          )}
        </select>
      </label>
      {jobs.isLoading ? (
        <p>{t("common.loading")}</p>
      ) : jobs.error ? (
        <p className="text-destructive">
          {translatedActionError(jobs.error, t)}
        </p>
      ) : jobs.data?.length ? (
        <div className="grid gap-3">
          {jobs.data.map((job) => (
            <Link
              className="rounded-lg border p-4 hover:bg-muted"
              key={job.id}
              to={`/jobs/${job.id}`}
            >
              <div className="flex justify-between gap-3">
                <div>
                  <h2 className="font-medium">{job.title}</h2>
                  <p className="text-sm text-muted-foreground">
                    {customers.data?.find(
                      (customer) => customer.id === job.customerId,
                    )?.name ?? t("jobs.unknownCustomer")}{" "}
                    ·{" "}
                    {fmt.formatDate(job.scheduledAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </p>
                </div>
                <StatusBadge
                  status={job.status}
                  testId={`job-status-${job.id}`}
                />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <p>{t("jobs.empty")}</p>
      )}
    </div>
  );
}
