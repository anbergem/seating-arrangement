import {
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { useOrgRole } from "@agent-native/core/client/org";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const schema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  phone: z.string().optional(),
});
type Values = z.infer<typeof schema>;
export default function CustomersRoute() {
  const t = useT();
  const feedback = useOperationFeedback([
    "list-customers",
    "get-customer",
    "list-recent-activity",
  ]);
  const { canManageOrg } = useOrgRole();
  const [open, setOpen] = useState(false);
  const customers = useActionQuery<Customer[]>("list-customers", {});
  const changed = (result: CommandResult<Customer>) => {
    void feedback.success(result, t("customers.changed"));
  };
  const create = useActionMutation<CommandResult<Customer>, Values>(
    "create-customer",
    {
      onSuccess: (result) => {
        setOpen(false);
        void feedback.success(result, t("customers.created"));
      },
      onError: (e) => toast.error(translatedActionError(e, t)),
    },
  );
  const archive = useActionMutation<
    CommandResult<Customer>,
    { customerId: string; expectedVersion: number }
  >("archive-customer", {
    onSuccess: changed,
    onError: (e) => toast.error(translatedActionError(e, t)),
  });
  const { register, handleSubmit, setError, formState } = useForm<Values>();
  const submit = handleSubmit((values) => {
    const parsed = schema.safeParse(values);
    if (parsed.success) create.mutate(parsed.data);
    else setError("name", { message: t("errors.VALIDATION") });
  });
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("customers.title")}</h1>
          <p className="text-muted-foreground">{t("customers.description")}</p>
        </div>
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger asChild>
            <Button data-testid="new-customer">{t("customers.new")}</Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-background p-6 shadow-lg">
              <Dialog.Title className="text-lg font-semibold">
                {t("customers.new")}
              </Dialog.Title>
              <Dialog.Description className="mb-4 text-sm text-muted-foreground">
                {t("customers.newDescription")}
              </Dialog.Description>
              <form className="grid gap-3" onSubmit={submit}>
                {/* A placeholder is not a label: it disappears as soon as the
                    field has a value and screen readers may skip it. */}
                <Input
                  aria-label={t("customers.name")}
                  placeholder={t("customers.name")}
                  {...register("name")}
                />
                <Input
                  aria-label={t("customers.email")}
                  placeholder={t("customers.email")}
                  {...register("email")}
                />
                <Input
                  aria-label={t("customers.phone")}
                  placeholder={t("customers.phone")}
                  {...register("phone")}
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
                    data-testid="create-customer"
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
      {customers.isLoading ? (
        <p>{t("common.loading")}</p>
      ) : customers.error ? (
        <p className="text-destructive">
          {translatedActionError(customers.error, t)}
        </p>
      ) : customers.data?.length ? (
        <div className="grid gap-3">
          {customers.data.map((customer) => (
            <div
              className="flex items-center justify-between rounded-lg border p-4"
              key={customer.id}
            >
              <Link to={`/customers/${customer.id}`}>
                <p className="font-medium">{customer.name}</p>
                <p className="text-sm text-muted-foreground">
                  {customer.email}
                </p>
              </Link>
              <div className="flex items-center gap-2">
                <StatusBadge
                  status={customer.status}
                  testId={`customer-status-${customer.id}`}
                />
                {canManageOrg && customer.status === "active" ? (
                  <Button
                    data-testid={`archive-customer-${customer.id}`}
                    disabled={archive.isPending || feedback.busy}
                    variant="outline"
                    onClick={() =>
                      archive.mutate({
                        customerId: customer.id,
                        expectedVersion: customer.version,
                      })
                    }
                  >
                    {t("common.archive")}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p>{t("customers.empty")}</p>
      )}
    </div>
  );
}
