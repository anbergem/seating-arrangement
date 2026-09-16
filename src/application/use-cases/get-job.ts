/**
 * `get-job` (blueprint B8).
 *
 * Returns the job together with its customer's name, because every caller of
 * this use case — the detail screen, the agent, an MCP client — immediately
 * needs it, and a second round trip for one string is waste. The customer is
 * read with the same org scope as the job, so this cannot leak a name across
 * organizations.
 */

import type { Job } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { AccountingExportStatus, Dependencies } from "../ports";

export interface GetJobInput {
  jobId: string;
}

export interface GetJobResult {
  job: Job;
  /** Pending exports remain retryable even after the job is archived. */
  accountingExportStatus: AccountingExportStatus | null;
  /** `null` only when the customer row is gone, which the schema's foreign
   * key makes impossible in the database; the job stays readable either way
   * rather than a missing name turning into a missing job. */
  customerName: string | null;
}

export async function getJob(
  deps: Dependencies,
  actor: Actor,
  input: GetJobInput,
): Promise<GetJobResult> {
  requireCapability(actor, "jobs:read");

  const job = await deps.jobs.getById(actor.orgId, input.jobId);
  if (!job) throw new AppError("NOT_FOUND", "Job not found");

  const customer = await deps.customers.getById(actor.orgId, job.customerId);
  const accountingExport = await deps.accountingExports.getByJobId(
    actor.orgId,
    job.id,
  );
  return {
    job,
    customerName: customer?.name ?? null,
    accountingExportStatus: accountingExport?.status ?? null,
  };
}
