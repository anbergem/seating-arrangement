/**
 * `create-job` (blueprint B8, decision D14).
 *
 * Two preconditions this file does not check itself:
 *
 * - The customer must exist, belong to this organization and still be active.
 *   That is enforced inside the repository's atomic write (B11), because a
 *   check here followed by a write there is a race: D1 cannot hold a
 *   transaction open across the two. The repository reports it as
 *   `NOT_FOUND "Customer not found or archived"`.
 * - The job's `assignedTo`, when given, must be a member of the organization.
 *   That one *is* checked here, through `MembershipReader`: membership lives in
 *   a framework-owned table the job insert cannot join against, and assigning
 *   work to a stranger is a validation problem, not a missing record.
 *
 * Like `create-customer`, this is *compensatable*: its inverse archives the
 * job, because nothing here deletes.
 */

import type { Job, Operation } from "../../domain";
import { createJob as createJobDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import {
  applyDomain,
  isIdempotencyKeyViolation,
  type CommandResult,
} from "./command";

const ACTION = "create-job";

export interface CreateJobInput {
  customerId: string;
  title: string;
  description?: string;
  /** ISO 8601 instant. */
  scheduledAt: string;
  /** Email of the member the job is assigned to. */
  assignedTo?: string;
  /** Repeat the same key to retry safely: the second call returns the job the
   * first one created. */
  idempotencyKey?: string;
}

/** See `create-customer.ts` for why an inconsistent key is `INTERNAL`. */
async function findCompletedCreate(
  deps: Dependencies,
  orgId: string,
  key: string,
): Promise<CommandResult<Job> | null> {
  const resourceId = await deps.idempotency.find(orgId, ACTION, key);
  if (resourceId === null) return null;

  const job = await deps.jobs.getById(orgId, resourceId);
  const created = await deps.operations.findCreateOperation(
    orgId,
    "job",
    resourceId,
  );
  if (!job || !created) {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return { resource: job, operationId: created.id };
}

export async function createJob(
  deps: Dependencies,
  actor: Actor,
  input: CreateJobInput,
): Promise<CommandResult<Job>> {
  requireCapability(actor, "jobs:create");

  const { idempotencyKey, ...payload } = input;

  if (idempotencyKey !== undefined) {
    const existing = await findCompletedCreate(
      deps,
      actor.orgId,
      idempotencyKey,
    );
    if (existing) return existing;
  }

  if (input.assignedTo !== undefined) {
    const isMember = await deps.membership.isMember(
      actor.orgId,
      input.assignedTo,
    );
    if (!isMember) {
      throw new AppError(
        "VALIDATION",
        "Assignee is not a member of this organization",
      );
    }
  }

  const now = deps.clock.now();
  const job = applyDomain(() =>
    createJobDomain({
      id: deps.ids.next(),
      orgId: actor.orgId,
      customerId: input.customerId,
      title: input.title,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      scheduledAt: input.scheduledAt,
      assignedTo: input.assignedTo ?? null,
      createdBy: actor.userEmail,
      now,
    }),
  );

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: ACTION,
    resourceType: "job",
    resourceId: job.id,
    classification: "compensatable",
    versionBefore: 0,
    versionAfter: job.version,
    payload,
    inverse: { type: "archive-job" },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  try {
    await deps.jobs.create({
      job,
      operation,
      ...(idempotencyKey !== undefined
        ? { idempotency: { action: ACTION, key: idempotencyKey } }
        : {}),
    });
  } catch (err) {
    if (idempotencyKey !== undefined && isIdempotencyKeyViolation(err)) {
      const existing = await findCompletedCreate(
        deps,
        actor.orgId,
        idempotencyKey,
      );
      if (existing) return existing;
    }
    throw err;
  }

  return { resource: job, operationId: operation.id };
}
