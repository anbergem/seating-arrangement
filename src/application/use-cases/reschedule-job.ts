/**
 * `reschedule-job` (blueprint B8).
 *
 * The only command whose `payload` carries anything: `{ scheduledAt }` is what
 * `redo-operation` (T10) needs to re-apply the move after an undo. The
 * *previous* instant goes the other way, into the inverse, so undo can put the
 * job back where it was.
 *
 * The domain refuses a move to the instant the job already has, and refuses to
 * move a completed or archived job at all.
 */

import type { Job, Operation } from "../../domain";
import { rescheduleJob as rescheduleJobDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";

export interface RescheduleJobInput {
  jobId: string;
  /** ISO 8601 instant to move the job to. */
  scheduledAt: string;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function rescheduleJob(
  deps: Dependencies,
  actor: Actor,
  input: RescheduleJobInput,
): Promise<CommandResult<Job>> {
  requireCapability(actor, "jobs:reschedule");

  const job = await deps.jobs.getById(actor.orgId, input.jobId);
  if (!job) throw new AppError("NOT_FOUND", "Job not found");
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== job.version
  ) {
    throw new AppError("CONFLICT", "The job was changed by someone else");
  }

  const now = deps.clock.now();
  const next = applyDomain(() =>
    rescheduleJobDomain(job, input.scheduledAt, now),
  );

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "reschedule-job",
    resourceType: "job",
    resourceId: job.id,
    classification: "reversible",
    versionBefore: job.version,
    versionAfter: next.version,
    // The instant the caller asked for, not the normalised one: this is the
    // argument a redo replays, and the domain normalises it again anyway.
    payload: { scheduledAt: input.scheduledAt },
    inverse: {
      type: "restore-job-schedule",
      previousScheduledAt: job.scheduledAt,
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
