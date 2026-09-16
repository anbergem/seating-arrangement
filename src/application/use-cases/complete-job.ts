/**
 * `complete-job` (blueprint B8, B16).
 *
 * Allowed from `scheduled` or `in_progress`: work can be finished without
 * having been marked started, which is what field crews actually do.
 *
 * This is the command the specification names as the one that must be
 * undoable, so the inverse it records — the status triple as it was, including
 * the `completedAt` it is about to set — is the shape `undo-operation` (T10)
 * replays through `restoreJobStatus`.
 */

import type { Job, Operation } from "../../domain";
import { completeJob as completeJobDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";

export interface CompleteJobInput {
  jobId: string;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function completeJob(
  deps: Dependencies,
  actor: Actor,
  input: CompleteJobInput,
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
  const next = applyDomain(() => completeJobDomain(job, now));

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "complete-job",
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
