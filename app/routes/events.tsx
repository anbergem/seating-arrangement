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
import {
  DEFAULT_LAYOUT_VALUES,
  LayoutPicker,
  type LayoutValues,
} from "@/components/seating/LayoutPicker";
import type { EventSummary } from "@/components/seating/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const schema = z.object({
  name: z.string().min(1),
  startsAt: z.string().min(1),
});
type Values = z.infer<typeof schema>;

export default function EventsRoute() {
  const t = useT();
  const fmt = useFormatters();
  const feedback = useOperationFeedback([
    "list-events",
    "list-recent-activity",
  ]);
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<LayoutValues>(DEFAULT_LAYOUT_VALUES);
  const events = useActionQuery<EventSummary[]>("list-events", {});
  const bootstrap = useActionMutation<
    CommandResult<EventSummary>,
    Record<string, unknown>
  >("bootstrap-event-layout", {
    onSuccess: (result) =>
      void feedback.success(result, t("seating.layoutApplied")),
    onError: (error) => toast.error(translatedActionError(error, t)),
  });
  const create = useActionMutation<CommandResult<EventSummary>, Values>(
    "create-event",
    {
      onSuccess: (result) => {
        setOpen(false);
        void feedback.success(result, t("events.created"));
        // A second operation rather than one: the layout is its own decision
        // and its own Undo, and an event created without one is still an
        // event. If it fails, the event is still there to lay out by hand.
        if (layout.layout !== "none") {
          bootstrap.mutate({
            eventId: result.resource.id,
            layout: layout.layout,
            sections: layout.sections,
            tableLength: layout.tableLength,
            endSeats: true,
          });
        }
        setLayout(DEFAULT_LAYOUT_VALUES);
      },
      onError: (error) => toast.error(translatedActionError(error, t)),
    },
  );
  const { register, handleSubmit, setError, formState } = useForm<Values>();
  const submit = handleSubmit((values) => {
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      setError("name", { message: t("errors.VALIDATION") });
      return;
    }
    create.mutate({
      ...parsed.data,
      startsAt: new Date(parsed.data.startsAt).toISOString(),
    });
  });

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("events.title")}</h1>
          <p className="text-muted-foreground">{t("events.description")}</p>
        </div>
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger asChild>
            <Button data-testid="new-event">{t("events.new")}</Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-background p-6 shadow-lg">
              <Dialog.Title className="text-lg font-semibold">
                {t("events.new")}
              </Dialog.Title>
              <Dialog.Description className="mb-4 text-sm text-muted-foreground">
                {t("events.newDescription")}
              </Dialog.Description>
              <form className="grid gap-3" onSubmit={submit}>
                <Input
                  aria-label={t("events.name")}
                  placeholder={t("events.name")}
                  {...register("name")}
                />
                <Input
                  aria-label={t("events.startsAt")}
                  type="datetime-local"
                  {...register("startsAt")}
                />
                <LayoutPicker
                  value={layout}
                  disabled={create.isPending}
                  allowNone
                  onChange={setLayout}
                />
                {formState.errors.name ? (
                  <p className="text-sm text-destructive">
                    {formState.errors.name.message}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <Dialog.Close asChild>
                    <Button variant="outline" type="button">
                      {t("common.cancel")}
                    </Button>
                  </Dialog.Close>
                  <Button
                    data-testid="create-event"
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

      {events.isLoading ? (
        <p>{t("common.loading")}</p>
      ) : events.error ? (
        <p className="text-destructive">
          {translatedActionError(events.error, t)}
        </p>
      ) : events.data?.length ? (
        <div className="grid gap-3">
          {events.data.map((event) => (
            <Link
              className="rounded-lg border p-4 hover:bg-muted"
              key={event.id}
              to={`/events/${event.id}`}
            >
              <h2 className="font-medium">{event.name}</h2>
              <p className="text-sm text-muted-foreground">
                {fmt.formatDate(event.startsAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
            </Link>
          ))}
        </div>
      ) : (
        <p>{t("events.empty")}</p>
      )}
    </div>
  );
}
