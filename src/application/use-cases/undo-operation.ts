/**
 * `undo-operation` (blueprint B9, decision D13).
 *
 * Undo here is semantic, not a snapshot restore: every command recorded the
 * *inverse command* that reverses it (B8), and this use case replays that
 * inverse through the same domain functions any other command uses. So undoing
 * a create archives the resource rather than deleting it, and undoing a
 * transition restores the exact status triple that was recorded — never a
 * status guessed from the action name.
 *
 * The one rule that makes it safe is `canUndo`: the resource must still be at
 * the version the operation left it at. If anyone changed the record since —
 * including the same user through another surface — undo is refused with
 * CONFLICT rather than silently discarding that change. The version is checked
 * twice: here, against what was just read, and again inside the atomic write,
 * which also marks the undone operation in the same batch (B11's `markUndone`)
 * so an operation can never be marked undone by an audit row that was not
 * written.
 *
 * The undo itself is an ordinary operation row (kind `undo`), which is what
 * makes redo possible and what makes an undo visible in the history feed. Its
 * own `inverse` is `null`: an undo is never undone (`canUndo` refuses it as
 * `not-forward`) — `redo-operation` reverses it instead, reading the action and
 * arguments to re-apply from the forward operation this row points at. See
 * `docs/plan/DISCREPANCIES.md` for why B9's `{ type: "redo", … }` inverse is
 * not what is stored.
 */

import type {
  Customer,
  InverseCommand,
  Job,
  Operation,
  ResourceType,
} from "../../domain";
import {
  archiveCustomer,
  archiveJob,
  canUndo,
  restoreCustomer,
  restoreJobSchedule,
  restoreJobStatus,
} from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import {
  mayUndo,
  reopensCompletedJob,
  requireHistoryPermission,
} from "../history-policy";
import type { Dependencies } from "../ports";
import { applyDomain, type UndoRedoResult } from "./command";

const ACTION = "undo-operation";

export interface UndoOperationInput {
  /** Id of the operation to reverse, from `list-recent-activity` or from the
   * `operationId` a command returned. */
  operationId: string;
}

/** B9's four refusals, with the messages B9 fixes. `already-undone` and
 * `conflict` are CONFLICT because the caller can recover by re-reading;
 * `irreversible` and `not-forward` are INVARIANT because no amount of
 * re-reading will make this operation undoable. */
function assertUndoable(op: Operation, currentVersion: number): void {
  const verdict = canUndo(op, currentVersion);
  if (verdict.ok) return;
  switch (verdict.reason) {
    case "already-undone":
      throw new AppError("CONFLICT", "Already undone");
    case "irreversible":
      throw new AppError("INVARIANT", "This operation cannot be undone");
    case "conflict":
      throw new AppError("CONFLICT", "Newer changes exist; undo refused");
    case "not-forward":
      throw new AppError("INVARIANT", "Use redo for an undo operation");
  }
}

/**
 * An operation whose `inverse` does not fit the resource it names — a
 * `restore-customer` recorded against a job, or a missing inverse on an
 * operation `canUndo` accepted — is a corrupt row, not a caller's mistake, so
 * it is `INTERNAL` with the reason withheld (B5).
 */
function inverseMismatch(): AppError {
  return new AppError("INTERNAL", "Unexpected error");
}

/** The customer half of B9 step 4. */
function applyCustomerInverse(
  inverse: InverseCommand | null,
  customer: Customer,
  now: string,
): Customer {
  switch (inverse?.type) {
    case "restore-customer":
      return restoreCustomer(customer, now);
    case "archive-customer":
      return archiveCustomer(customer, now);
    default:
      throw inverseMismatch();
  }
}

/** The job half of B9 step 4. `restore-job-schedule` goes through
 * `restoreJobSchedule`, not `rescheduleJob`, because undo must be able to put
 * back the exact instant it recorded and `rescheduleJob` refuses a move to the
 * instant the job already has. */
function applyJobInverse(
  inverse: InverseCommand | null,
  job: Job,
  now: string,
): Job {
  switch (inverse?.type) {
    case "restore-job-status":
      return restoreJobStatus(job, inverse.previous, now);
    case "restore-job-schedule":
      return restoreJobSchedule(job, inverse.previousScheduledAt, now);
    case "archive-job":
      return archiveJob(job, now);
    default:
      throw inverseMismatch();
  }
}

/** The audit row the undo writes about itself (B9 step 5). `payload` is `{}`
 * rather than `null` because there is nothing to replay from it: redo reads
 * the action and its arguments from the forward operation at
 * `relatedOperationId`. */
function undoOperationRow(input: {
  id: string;
  actor: Actor;
  undone: Operation;
  resourceType: ResourceType;
  resourceId: string;
  versionBefore: number;
  versionAfter: number;
  now: string;
}): Operation {
  return {
    id: input.id,
    orgId: input.actor.orgId,
    kind: "undo",
    action: ACTION,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    classification: "reversible",
    versionBefore: input.versionBefore,
    versionAfter: input.versionAfter,
    payload: {},
    inverse: null,
    relatedOperationId: input.undone.id,
    undoneByOperationId: null,
    performedBy: input.actor.userEmail,
    performedVia: input.actor.caller,
    performedAt: input.now,
  };
}

export async function undoOperation(
  deps: Dependencies,
  actor: Actor,
  input: UndoOperationInput,
): Promise<UndoRedoResult> {
  requireCapability(actor, "history:undo");

  // Scoped by organization like every other read, so an operation id from
  // another organization is indistinguishable from one that does not exist.
  const op = await deps.operations.getById(actor.orgId, input.operationId);
  if (!op) throw new AppError("NOT_FOUND", "Operation not found");

  if (op.resourceType === "customer") {
    const customer = await deps.customers.getById(actor.orgId, op.resourceId);
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found");
    assertUndoable(op, customer.version);
    requireHistoryPermission(mayUndo(actor, op));

    const now = deps.clock.now();
    const restored = applyDomain(() =>
      applyCustomerInverse(op.inverse, customer, now),
    );
    const undoOp = undoOperationRow({
      id: deps.ids.next(),
      actor,
      undone: op,
      resourceType: "customer",
      resourceId: customer.id,
      versionBefore: customer.version,
      versionAfter: restored.version,
      now,
    });

    await deps.customers.commit({
      customer: restored,
      expectedVersion: customer.version,
      operation: undoOp,
      markUndone: op.id,
    });

    return {
      resource: restored,
      operationId: undoOp.id,
      resourceType: "customer",
    };
  }

  const job = await deps.jobs.getById(actor.orgId, op.resourceId);
  if (!job) throw new AppError("NOT_FOUND", "Job not found");
  assertUndoable(op, job.version);
  requireHistoryPermission(mayUndo(actor, op));
  const requireNoAccountingExport = reopensCompletedJob(op);
  if (
    requireNoAccountingExport &&
    (job.accountingReference !== null ||
      (await deps.accountingExports.getByJobId(actor.orgId, job.id)))
  ) {
    throw new AppError(
      "INVARIANT",
      "A job with an accounting export cannot be reopened",
    );
  }

  const now = deps.clock.now();
  const restored = applyDomain(() => applyJobInverse(op.inverse, job, now));
  const undoOp = undoOperationRow({
    id: deps.ids.next(),
    actor,
    undone: op,
    resourceType: "job",
    resourceId: job.id,
    versionBefore: job.version,
    versionAfter: restored.version,
    now,
  });

  await deps.jobs.commit({
    job: restored,
    requireNoAccountingExport,
    expectedVersion: job.version,
    operation: undoOp,
    markUndone: op.id,
  });

  return { resource: restored, operationId: undoOp.id, resourceType: "job" };
}
