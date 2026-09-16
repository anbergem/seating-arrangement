/**
 * `start-job` (blueprint B8).
 *
 * Allowed from `scheduled` only; the domain's `JOB_TRANSITIONS` table is what
 * says so, and it throws `INVARIANT` for every other starting status.
 *
 * The recorded inverse is the job's status triple *before* the transition, so
 * undo restores exactly what was there rather than guessing a status from the
 * action name.
 */

import type { Job, Operation } from "../../domain";
import { startJob as startJobDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";

export interface StartJobInput {
  jobId: string;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function startJob(
  deps: Dependencies,
  actor: Actor,
  input: StartJobInput,
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
  const next = applyDomain(() => startJobDomain(job, now));

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "start-job",
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
