import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { Link, useParams } from "react-router";

import { translatedActionError } from "@/components/activity/action-ui";
import type { Customer } from "@/components/customers/types";
import { StatusBadge } from "@/components/jobs/StatusBadge";
import type { Job } from "@/components/jobs/types";
export default function CustomerDetailRoute() {
  const { id = "" } = useParams();
  const t = useT();
  const customer = useActionQuery<Customer>("get-customer", { customerId: id });
  const jobs = useActionQuery<Job[]>("list-jobs", {
    customerId: id,
    includeArchived: true,
  });
  if (customer.isLoading)
    return <div className="p-6">{t("common.loading")}</div>;
  if (!customer.data || customer.error)
    return (
      <div className="p-6 text-destructive">
        {translatedActionError(customer.error, t)}
      </div>
    );
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div className="flex justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{customer.data.name}</h1>
          <p className="text-muted-foreground">
            {customer.data.email} · {customer.data.phone}
          </p>
        </div>
        <StatusBadge status={customer.data.status} testId="customer-status" />
      </div>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("customers.jobs")}</h2>
        {jobs.data?.length ? (
          jobs.data.map((job) => (
            <Link
              className="block rounded-lg border p-4"
              key={job.id}
              to={`/jobs/${job.id}`}
            >
              {job.title}
            </Link>
          ))
        ) : (
          <p>{t("jobs.empty")}</p>
        )}
      </section>
    </div>
  );
}
