/**
 * `archive-job` (blueprint B8).
 *
 * Allowed from every status except `archived` — archiving is how a job leaves
 * the working set from any point in its life, and it is the closest thing to a
 * delete this application has. Still reversible: the inverse restores the
 * status triple the job had, so undo puts a wrongly archived job back into
 * `scheduled`, `in_progress` or `completed` exactly as it was.
 *
 * The capability is `jobs:transition`, the same one `start-job` and
 * `complete-job` use: archiving a job is a status change, not the
 * administrative act that archiving a *customer* is (B6).
 */

import type { Job, Operation } from "../../domain";
import { archiveJob as archiveJobDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";

export interface ArchiveJobInput {
  jobId: string;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function archiveJob(
  deps: Dependencies,
  actor: Actor,
  input: ArchiveJobInput,
): Promise<CommandResult<Job>> {
  requireCapability(actor, "jobs:transition");

  const job = await deps.jobs.getById(actor.orgId, input.jobId);
  if (!job) throw new AppError("NOT_FOUND", "Job not found");
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== job.version
  ) {
    throw new AppError("CONFLICT", "The job was changed by someone else");
  }

  const now = deps.clock.now();
  const next = applyDomain(() => archiveJobDomain(job, now));

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "archive-job",
    resourceType: "job",
    resourceId: job.id,
    classification: "reversible",
    versionBefore: job.version,
    versionAfter: next.version,
    payload: {},
    inverse: {
      type: "restore-job-status",
      previous: {
        status: job.status,
        completedAt: job.completedAt,
        archivedAt: job.archivedAt,
      },
    },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  await deps.jobs.commit({
    job: next,
    expectedVersion: job.version,
    operation,
  });

  return { resource: next, operationId: operation.id };
}
