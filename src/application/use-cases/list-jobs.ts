/**
 * `list-jobs` (blueprint B8).
 *
 * Two behaviours are worth stating out loud because both repositories have to
 * agree on them:
 *
 * - The `scheduledAt` window is half-open — `from` inclusive, `to` exclusive —
 *   so two consecutive days do not both match a job scheduled at midnight.
 * - Archived jobs are excluded unless the caller asks otherwise. "Otherwise"
 *   includes asking for them by name: an explicit `status` filter always wins,
 *   or `status: "archived"` would be a query that can only return nothing.
 */

import type { Job, JobStatus } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import type { Dependencies } from "../ports";

export interface ListJobsInput {
  status?: JobStatus;
  customerId?: string;
  /** ISO 8601 instant. Inclusive lower bound on `scheduledAt`. */
  from?: string;
  /** ISO 8601 instant. Exclusive upper bound on `scheduledAt`. */
  to?: string;
  /** Only meaningful without `status`; `true` keeps archived jobs in the list. */
  includeArchived?: boolean;
}

export async function listJobs(
  deps: Dependencies,
  actor: Actor,
  input: ListJobsInput = {},
): Promise<Job[]> {
  requireCapability(actor, "jobs:read");

  const filter: {
    status?: JobStatus;
    customerId?: string;
    from?: string;
    to?: string;
  } = {};
  if (input.status !== undefined) filter.status = input.status;
  if (input.customerId !== undefined) filter.customerId = input.customerId;
  if (input.from !== undefined) filter.from = input.from;
  if (input.to !== undefined) filter.to = input.to;

  const jobs = await deps.jobs.list(actor.orgId, filter);

  // The port's filter has one `status` slot and no "not archived" predicate,
  // so the default exclusion is applied here rather than pushed into two
  // repository implementations that would have to agree on the SQL for it.
  if (input.status !== undefined || input.includeArchived === true) return jobs;
  return jobs.filter((job) => job.status !== "archived");
}
