/**
 * `redo-operation` (blueprint B9, decision D13).
 *
 * Redo is not "restore a snapshot" either: it re-runs the original forward
 * command through the domain, with the arguments that command recorded as its
 * `payload`. The handle it takes is the id of an **undo** operation — redo
 * answers "put back what I just undid" — and it is refused unless the record
 * still stands exactly where that undo left it, which is the same version rule
 * undo obeys.
 *
 * Two refusals are worth naming:
 *
 * - A create is never redone. Its undo was a *compensation* (the resource was
 *   archived, not deleted), so re-running `create-*` would produce a second
 *   resource rather than resurrect the first. B9 calls this INVARIANT.
 * - An undo of a *redo* cannot be redone. B9 lets a redo be undone
 *   (`canUndo` accepts kind `redo`, and the redo row carries the forward
 *   operation's inverse), but the operation such an undo points at is the redo
 *   row, whose action is `redo-operation` and not a domain command. That is
 *   refused with INVARIANT rather than guessed at; see
 *   `docs/plan/DISCREPANCIES.md`.
 */

import type { Customer, Job, Operation, ResourceType } from "../../domain";
import {
  archiveCustomer,
  archiveJob,
  completeJob,
  rescheduleJob,
  startJob,
} from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import { mayRedo, requireHistoryPermission } from "../history-policy";
import type { Dependencies } from "../ports";
import { applyDomain, isCreateOperation, type UndoRedoResult } from "./command";

const ACTION = "redo-operation";

/** The refusal for a forward operation this use case has no way to re-apply:
 * an `irreversible` action (which could never have been undone), or the
 * `redo-operation` row an undo of a redo points at. */
const NOT_REDOABLE_MESSAGE = "This operation cannot be redone";

export interface RedoOperationInput {
  /** Id of the **undo** operation to reverse — not the forward operation it
   * undid. */
  operationId: string;
}

/** B9 step 1. Both refusals are INVARIANT: an operation that is not an undo
 * will never become one, and an undo that has already been redone is a
 * different row's business. */
function assertRedoable(undoOp: Operation): void {
  if (undoOp.kind !== "undo") {
    throw new AppError("INVARIANT", "Only an undo operation can be redone");
  }
  if (undoOp.undoneByOperationId !== null) {
    throw new AppError("INVARIANT", "This undo has already been redone");
  }
}

/** B9 step 2: the resource must still be where the undo left it, or redoing
 * would discard whatever happened since. */
function assertUnchanged(undoOp: Operation, currentVersion: number): void {
  if (currentVersion !== undoOp.versionAfter) {
    throw new AppError("CONFLICT", "Newer changes exist; redo refused");
  }
}

/**
 * B9 step 3: the forward operation the undo reversed, which holds the action
 * and arguments to replay.
 *
 * Its absence is a corrupt row rather than a caller error — an undo always
 * names the operation it undid — so it is `INTERNAL` with the reason withheld
 * (B5). A create is refused here, before anything is written.
 */
async function loadForwardOperation(
  deps: Dependencies,
  actor: Actor,
  undoOp: Operation,
): Promise<Operation> {
  const forward = undoOp.relatedOperationId
    ? await deps.operations.getById(actor.orgId, undoOp.relatedOperationId)
    : null;
  if (!forward) throw new AppError("INTERNAL", "Unexpected error");
  if (isCreateOperation(forward)) {
    throw new AppError("INVARIANT", "A create cannot be redone");
  }
  if (forward.kind !== "forward")
    throw new AppError("INVARIANT", NOT_REDOABLE_MESSAGE);
  requireHistoryPermission(mayRedo(actor, forward));
  return forward;
}

/** The instant a `reschedule-job` recorded as the argument to replay. */
function scheduledAtFrom(payload: Record<string, unknown> | null): string {
  const value = payload?.scheduledAt;
  if (typeof value !== "string") {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return value;
}

/** B9 step 3 for a customer: `archive-customer` is the only customer command
 * that is neither a create nor read-only. */
function reapplyCustomerForward(
  forward: Operation,
  customer: Customer,
  now: string,
): Customer {
  switch (forward.action) {
    case "archive-customer":
      return archiveCustomer(customer, now);
    default:
      throw new AppError("INVARIANT", NOT_REDOABLE_MESSAGE);
  }
}

/** B9 step 3 for a job. `rescheduleJob` is the ordinary domain function, not
 * the undo-only `restoreJobSchedule`: a redo moves the job back off the
 * instant the undo restored, so the "already scheduled at that time" rule is
 * not in the way. */
function reapplyJobForward(forward: Operation, job: Job, now: string): Job {
  switch (forward.action) {
    case "start-job":
      return startJob(job, now);
    case "complete-job":
      return completeJob(job, now);
    case "archive-job":
      return archiveJob(job, now);
    case "reschedule-job":
      return rescheduleJob(job, scheduledAtFrom(forward.payload), now);
    default:
      throw new AppError("INVARIANT", NOT_REDOABLE_MESSAGE);
  }
}

/**
 * The audit row the redo writes about itself (B9 step 4). It carries the
 * *forward* operation's inverse, so the redo can itself be undone: `canUndo`
 * accepts kind `redo`, and applying that inverse puts the record back where
 * the undo had it.
 */
function redoOperationRow(input: {
  id: string;
  actor: Actor;
  undoOp: Operation;
  forward: Operation;
  resourceType: ResourceType;
  resourceId: string;
  versionBefore: number;
  versionAfter: number;
  now: string;
}): Operation {
  return {
    id: input.id,
    orgId: input.actor.orgId,
    kind: "redo",
    action: ACTION,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    classification: "reversible",
    versionBefore: input.versionBefore,
    versionAfter: input.versionAfter,
    // Nothing to replay from here: the arguments a further redo would need
    // stay on the forward operation, the same way an undo row's do.
    payload: {},
    inverse: input.forward.inverse,
    relatedOperationId: input.undoOp.id,
    undoneByOperationId: null,
    performedBy: input.actor.userEmail,
    performedVia: input.actor.caller,
    performedAt: input.now,
  };
}

export async function redoOperation(
  deps: Dependencies,
  actor: Actor,
  input: RedoOperationInput,
): Promise<UndoRedoResult> {
  requireCapability(actor, "history:undo");

  const undoOp = await deps.operations.getById(actor.orgId, input.operationId);
  if (!undoOp) throw new AppError("NOT_FOUND", "Operation not found");
  assertRedoable(undoOp);

  if (undoOp.resourceType === "customer") {
    const customer = await deps.customers.getById(
      actor.orgId,
      undoOp.resourceId,
    );
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found");
    assertUnchanged(undoOp, customer.version);
    const forward = await loadForwardOperation(deps, actor, undoOp);

    const now = deps.clock.now();
    const next = applyDomain(() =>
      reapplyCustomerForward(forward, customer, now),
    );
    const redoOp = redoOperationRow({
      id: deps.ids.next(),
      actor,
      undoOp,
      forward,
      resourceType: "customer",
      resourceId: customer.id,
      versionBefore: customer.version,
      versionAfter: next.version,
      now,
    });

    await deps.customers.commit({
      customer: next,
      expectedVersion: customer.version,
      operation: redoOp,
      markUndone: undoOp.id,
    });

    return { resource: next, operationId: redoOp.id, resourceType: "customer" };
  }

  const job = await deps.jobs.getById(actor.orgId, undoOp.resourceId);
  if (!job) throw new AppError("NOT_FOUND", "Job not found");
  assertUnchanged(undoOp, job.version);
  const forward = await loadForwardOperation(deps, actor, undoOp);

  const now = deps.clock.now();
  const next = applyDomain(() => reapplyJobForward(forward, job, now));
  const redoOp = redoOperationRow({
    id: deps.ids.next(),
    actor,
    undoOp,
    forward,
    resourceType: "job",
    resourceId: job.id,
    versionBefore: job.version,
    versionAfter: next.version,
    now,
  });

  await deps.jobs.commit({
    job: next,
    expectedVersion: job.version,
    operation: redoOp,
    markUndone: undoOp.id,
  });

  return { resource: next, operationId: redoOp.id, resourceType: "job" };
}
