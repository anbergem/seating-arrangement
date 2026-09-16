/**
 * `undo-operation` and `redo-operation` (blueprint B9), against the in-memory
 * dependencies and the fixed B12 scenario.
 *
 * Nothing here hand-builds an operation row except where a state is otherwise
 * unreachable (an `irreversible` classification, which no command in this
 * application produces until T27): every case runs the real forward use case
 * first and then undoes the operation id it returned. That is the only way to
 * prove the two halves agree about `inverse`, `payload` and the version pair —
 * an undo that reads a row no command would write proves nothing.
 *
 * The exactness assertion is `toEqual({ ...before, version: … })`: after an
 * undo the resource must equal what it was before the forward command in
 * *every* field, not only the ones the action's name suggests.
 */

import { describe, expect, it } from "vitest";

import type { Actor } from "../../../src/application/actor";
import { AppError } from "../../../src/application/errors";
import { archiveCustomer } from "../../../src/application/use-cases/archive-customer";
import { archiveJob } from "../../../src/application/use-cases/archive-job";
import { completeJob } from "../../../src/application/use-cases/complete-job";
import { createCustomer } from "../../../src/application/use-cases/create-customer";
import { createJob } from "../../../src/application/use-cases/create-job";
import { listRecentActivity } from "../../../src/application/use-cases/list-recent-activity";
import { redoOperation } from "../../../src/application/use-cases/redo-operation";
import { rescheduleJob } from "../../../src/application/use-cases/reschedule-job";
import { startJob } from "../../../src/application/use-cases/start-job";
import { undoOperation } from "../../../src/application/use-cases/undo-operation";
import type { Customer, Job, Operation } from "../../../src/domain";
import {
  createInMemoryDependencies,
  type InMemoryDependencies,
} from "../../fixtures/in-memory";
import {
  seedInMemory,
  ADMIN_EMAIL,
  CUSTOMER_A_ID,
  JOB_COMPLETED_ID,
  JOB_IN_PROGRESS_ID,
  JOB_SCHEDULED_ID,
  MEMBER1_EMAIL,
  MEMBER2_EMAIL,
  ORG_ACME_ID,
  ORG_OTHER_ID,
  OUTSIDER_EMAIL,
  OWNER_EMAIL,
} from "../../fixtures/scenario";

/** The fixed clock every `createInMemoryDependencies()` uses. */
const NOW = "2026-09-06T12:00:00.000Z";

/** Instants no seeded job is scheduled at, so a reschedule to either is
 * always a real move. */
const LATER = "2026-11-11T07:30:00.000Z";
const LATER_STILL = "2026-12-12T07:30:00.000Z";

const acmeOwner: Actor = {
  userEmail: OWNER_EMAIL,
  orgId: ORG_ACME_ID,
  role: "owner",
  caller: "test",
};

const acmeAdmin: Actor = {
  userEmail: ADMIN_EMAIL,
  orgId: ORG_ACME_ID,
  role: "admin",
  caller: "test",
};

/** User A and user B of B9's concurrency example: two members of the same
 * organization, acting on the same job through different surfaces. */
const userA: Actor = {
  userEmail: MEMBER1_EMAIL,
  orgId: ORG_ACME_ID,
  role: "member",
  caller: "http",
};

const userB: Actor = {
  userEmail: MEMBER2_EMAIL,
  orgId: ORG_ACME_ID,
  role: "member",
  caller: "tool",
};

const outsider: Actor = {
  userEmail: OUTSIDER_EMAIL,
  orgId: ORG_OTHER_ID,
  role: "owner",
  caller: "test",
};

function seeded(): InMemoryDependencies {
  const deps = createInMemoryDependencies();
  seedInMemory(deps);
  return deps;
}

async function catchAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error("expected the use case to throw");
}

function operationOf(deps: InMemoryDependencies, id: string): Operation {
  const op = deps.state.operations.get(id);
  if (!op) throw new Error(`no operation "${id}" was written`);
  return op;
}

function jobOf(deps: InMemoryDependencies, id: string): Job {
  const job = deps.state.jobs.get(id);
  if (!job) throw new Error(`no job "${id}" in the scenario`);
  return job;
}

function customerOf(deps: InMemoryDependencies, id: string): Customer {
  const customer = deps.state.customers.get(id);
  if (!customer) throw new Error(`no customer "${id}" in the scenario`);
  return customer;
}

/**
 * The fields every undo row must carry the same way, whichever inverse it
 * applied: `kind`, the action name, the reversible classification, the link
 * back to the operation it reversed, an empty `payload` and no `inverse` of
 * its own (B9 — redo reads what to re-apply from the forward operation), the
 * actor's identity and surface, and the clock's instant.
 */
function expectUndoOperation(
  op: Operation,
  expected: { actor: Actor; forwardId: string; resourceId: string },
): void {
  expect(op.kind).toBe("undo");
  expect(op.action).toBe("undo-operation");
  expect(op.classification).toBe("reversible");
  expect(op.orgId).toBe(expected.actor.orgId);
  expect(op.resourceId).toBe(expected.resourceId);
  expect(op.relatedOperationId).toBe(expected.forwardId);
  expect(op.undoneByOperationId).toBeNull();
  expect(op.payload).toEqual({});
  expect(op.inverse).toBeNull();
  expect(op.performedBy).toBe(expected.actor.userEmail);
  expect(op.performedVia).toBe(expected.actor.caller);
  expect(op.performedAt).toBe(NOW);
}

// ---------------------------------------------------------------------------
// Undo restores exactly what was there
// ---------------------------------------------------------------------------

describe("undoOperation on a job transition", () => {
  it("restores every field start-job changed", async () => {
    const deps = seeded();
    const before = jobOf(deps, JOB_SCHEDULED_ID);
    const forward = await startJob(deps, userA, { jobId: before.id });
    expect(forward.resource.status).toBe("in_progress");

    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });

    expect(undone.resourceType).toBe("job");
    expect(undone.resource).toEqual({
      ...before,
      version: before.version + 2,
      updatedAt: NOW,
    });
    expect(jobOf(deps, before.id)).toEqual(undone.resource);
  });

  it("restores the status, completedAt and archivedAt complete-job changed", async () => {
    const deps = seeded();
    const before = jobOf(deps, JOB_IN_PROGRESS_ID);
    const forward = await completeJob(deps, userA, { jobId: before.id });
    expect(forward.resource.completedAt).toBe(NOW);

    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });

    expect(undone.resource).toEqual({
      ...before,
      version: before.version + 2,
      updatedAt: NOW,
    });
    // The pair that goes with the status, not just the status itself.
    expect((undone.resource as Job).status).toBe("in_progress");
    expect((undone.resource as Job).completedAt).toBeNull();
  });

  it("restores a completed job archive-job archived", async () => {
    const deps = seeded();
    const before = jobOf(deps, JOB_COMPLETED_ID);
    const forward = await archiveJob(deps, userA, { jobId: before.id });
    expect(forward.resource.archivedAt).toBe(NOW);

    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });

    expect(undone.resource).toEqual({
      ...before,
      version: before.version + 2,
      updatedAt: NOW,
    });
    expect((undone.resource as Job).status).toBe("completed");
    expect((undone.resource as Job).archivedAt).toBeNull();
    // The completedAt the job already had is not disturbed by the round trip.
    expect((undone.resource as Job).completedAt).toBe(before.completedAt);
  });

  it("restores the previous instant reschedule-job moved away from", async () => {
    const deps = seeded();
    const before = jobOf(deps, JOB_SCHEDULED_ID);
    const forward = await rescheduleJob(deps, userA, {
      jobId: before.id,
      scheduledAt: LATER,
    });
    expect(forward.resource.scheduledAt).toBe(LATER);

    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });

    expect(undone.resource).toEqual({
      ...before,
      version: before.version + 2,
      updatedAt: NOW,
    });
    expect((undone.resource as Job).scheduledAt).toBe(before.scheduledAt);
  });

  it("writes an undo row that records what it reversed", async () => {
    const deps = seeded();
    const before = jobOf(deps, JOB_SCHEDULED_ID);
    const forward = await completeJob(deps, userA, { jobId: before.id });
    const undone = await undoOperation(deps, userB, {
      operationId: forward.operationId,
    });

    const undoOp = operationOf(deps, undone.operationId);
    expectUndoOperation(undoOp, {
      actor: userB,
      forwardId: forward.operationId,
      resourceId: before.id,
    });
    expect(undoOp.resourceType).toBe("job");
    expect(undoOp.versionBefore).toBe(forward.resource.version);
    expect(undoOp.versionAfter).toBe(forward.resource.version + 1);
    // The forward operation is marked in the same atomic write (B11's
    // `markUndone`), which is what makes a second undo a CONFLICT.
    expect(operationOf(deps, forward.operationId).undoneByOperationId).toBe(
      undoOp.id,
    );
  });
});

describe("undoOperation on a customer command", () => {
  it("restores a customer archive-customer archived", async () => {
    const deps = seeded();
    const before = customerOf(deps, CUSTOMER_A_ID);
    const forward = await archiveCustomer(deps, acmeAdmin, {
      customerId: before.id,
    });
    expect(forward.resource.status).toBe("archived");

    const undone = await undoOperation(deps, acmeAdmin, {
      operationId: forward.operationId,
    });

    expect(undone.resourceType).toBe("customer");
    expect(undone.resource).toEqual({
      ...before,
      version: before.version + 2,
      updatedAt: NOW,
    });
    expect(customerOf(deps, before.id).status).toBe("active");
  });
});

describe("undoOperation on a create", () => {
  it("archives the customer a create-customer created", async () => {
    const deps = seeded();
    const forward = await createCustomer(deps, acmeOwner, {
      name: "Example Customer C",
    });
    expect(forward.resource.status).toBe("active");

    const undone = await undoOperation(deps, acmeOwner, {
      operationId: forward.operationId,
    });

    // Compensation, not deletion: nothing in this application deletes.
    expect(undone.resource).toMatchObject({
      id: forward.resource.id,
      status: "archived",
      version: 2,
    });
    expect(deps.state.customers.get(forward.resource.id)?.status).toBe(
      "archived",
    );
  });

  it("archives the job a create-job created", async () => {
    const deps = seeded();
    const forward = await createJob(deps, acmeOwner, {
      customerId: CUSTOMER_A_ID,
      title: "Example Job",
      scheduledAt: LATER,
    });

    const undone = await undoOperation(deps, acmeOwner, {
      operationId: forward.operationId,
    });

    expect(undone.resource).toMatchObject({
      id: forward.resource.id,
      status: "archived",
      archivedAt: NOW,
      version: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// The four refusals (B9 step 3)
// ---------------------------------------------------------------------------

describe("undoOperation refusals", () => {
  it("is NOT_FOUND for an operation that does not exist", async () => {
    const deps = seeded();
    const err = await catchAppError(
      undoOperation(deps, acmeOwner, { operationId: "op_missing" }),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Operation not found");
  });

  it("is NOT_FOUND for an operation of another organization", async () => {
    const deps = seeded();
    // The row exists, but not for this caller: an outsider must not be able to
    // tell "no such operation" from "not yours".
    const err = await catchAppError(
      undoOperation(deps, outsider, { operationId: "op_create_cus_a" }),
    );
    expect(err.code).toBe("NOT_FOUND");
  });

  it("refuses a second undo with CONFLICT Already undone", async () => {
    const deps = seeded();
    const forward = await completeJob(deps, userA, {
      jobId: JOB_SCHEDULED_ID,
    });
    await undoOperation(deps, userA, { operationId: forward.operationId });

    const err = await catchAppError(
      undoOperation(deps, userA, { operationId: forward.operationId }),
    );
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("Already undone");
  });

  it("refuses an irreversible operation with INVARIANT", async () => {
    const deps = seeded();
    const forward = await completeJob(deps, userA, {
      jobId: JOB_SCHEDULED_ID,
    });
    // No command writes an `irreversible` classification before T27's
    // `send-job-to-accounting`, so the state is set directly.
    const op = operationOf(deps, forward.operationId);
    deps.state.operations.set(op.id, {
      ...op,
      classification: "irreversible",
    });

    const err = await catchAppError(
      undoOperation(deps, userA, { operationId: op.id }),
    );
    expect(err.code).toBe("INVARIANT");
    expect(err.message).toBe("This operation cannot be undone");
  });

  it("refuses to undo an undo, and says to use redo instead", async () => {
    const deps = seeded();
    const forward = await completeJob(deps, userA, {
      jobId: JOB_SCHEDULED_ID,
    });
    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });

    const err = await catchAppError(
      undoOperation(deps, userA, { operationId: undone.operationId }),
    );
    expect(err.code).toBe("INVARIANT");
    expect(err.message).toBe("Use redo for an undo operation");
  });

  it("refuses when the record has moved on since", async () => {
    const deps = seeded();
    const forward = await startJob(deps, userA, { jobId: JOB_SCHEDULED_ID });
    await rescheduleJob(deps, userB, {
      jobId: JOB_SCHEDULED_ID,
      scheduledAt: LATER,
    });

    const err = await catchAppError(
      undoOperation(deps, userA, { operationId: forward.operationId }),
    );
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("Newer changes exist; undo refused");
    // Nothing was written: the job keeps both the transition and the move.
    expect(jobOf(deps, JOB_SCHEDULED_ID)).toMatchObject({
      status: "in_progress",
      scheduledAt: LATER,
      version: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// B9's concurrency example, which is the whole point of the version rule
// ---------------------------------------------------------------------------

describe("two users on one job (B9)", () => {
  it("refuses A's undo while B's change stands, and again after B undoes", async () => {
    const deps = seeded();
    // B9's example starts the job at version 12; the seeded job is at 1, so
    // the version is set directly rather than by twelve pointless commands.
    const job = jobOf(deps, JOB_SCHEDULED_ID);
    deps.state.jobs.set(job.id, { ...job, version: 12 });

    // The example's literal order — complete, then reschedule — cannot happen:
    // the domain refuses to reschedule a completed job (see
    // `docs/plan/DISCREPANCIES.md`). The order is therefore A reschedules and
    // B completes, which keeps every version and every outcome the example
    // states.
    const completedFirst = await completeJob(deps, userA, { jobId: job.id });
    const refused = await catchAppError(
      rescheduleJob(deps, userB, { jobId: job.id, scheduledAt: LATER }),
    );
    expect(refused.code).toBe("INVARIANT");
    expect(completedFirst.resource.version).toBe(13);

    // Back to version 12 and run the sequence in the order the domain allows.
    deps.state.jobs.set(job.id, { ...job, version: 12 });

    const op1 = await rescheduleJob(deps, userA, {
      jobId: job.id,
      scheduledAt: LATER,
    });
    expect(op1.resource.version).toBe(13);

    const op2 = await completeJob(deps, userB, { jobId: job.id });
    expect(op2.resource.version).toBe(14);

    // A undoes its own operation: refused, because undoing the move would
    // discard B's completion.
    const first = await catchAppError(
      undoOperation(deps, userA, { operationId: op1.operationId }),
    );
    expect(first.code).toBe("CONFLICT");
    expect(first.message).toBe("Newer changes exist; undo refused");

    // B undoes the newest operation: allowed, and the job reaches version 15.
    const bUndo = await undoOperation(deps, userB, {
      operationId: op2.operationId,
    });
    expect(bUndo.resource.version).toBe(15);
    expect(bUndo.resource).toMatchObject({
      status: "scheduled",
      completedAt: null,
      scheduledAt: LATER,
    });

    // A tries again: still refused. The undo did not restore version 13, it
    // moved forward to 15 — history is append-only, so an operation's window
    // never reopens.
    const second = await catchAppError(
      undoOperation(deps, userA, { operationId: op1.operationId }),
    );
    expect(second.code).toBe("CONFLICT");
    expect(second.message).toBe("Newer changes exist; undo refused");
  });
});

// ---------------------------------------------------------------------------
// Redo
// ---------------------------------------------------------------------------

describe("redoOperation", () => {
  it("re-applies the forward command and marks the undo", async () => {
    const deps = seeded();
    const forward = await completeJob(deps, userA, {
      jobId: JOB_SCHEDULED_ID,
    });
    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });
    expect((undone.resource as Job).status).toBe("scheduled");

    const redone = await redoOperation(deps, userB, {
      operationId: undone.operationId,
    });

    expect(redone.resourceType).toBe("job");
    expect(redone.resource).toMatchObject({
      status: "completed",
      completedAt: NOW,
      version: 4,
    });
    expect(jobOf(deps, JOB_SCHEDULED_ID)).toEqual(redone.resource);

    const redoOp = operationOf(deps, redone.operationId);
    expect(redoOp.kind).toBe("redo");
    expect(redoOp.action).toBe("redo-operation");
    expect(redoOp.classification).toBe("reversible");
    expect(redoOp.relatedOperationId).toBe(undone.operationId);
    expect(redoOp.versionBefore).toBe(3);
    expect(redoOp.versionAfter).toBe(4);
    expect(redoOp.payload).toEqual({});
    // It carries the forward operation's inverse, which is what lets the redo
    // itself be undone (`canUndo` accepts kind `redo`).
    expect(redoOp.inverse).toEqual(
      operationOf(deps, forward.operationId).inverse,
    );
    expect(redoOp.performedBy).toBe(userB.userEmail);
    expect(redoOp.performedVia).toBe(userB.caller);
    expect(operationOf(deps, undone.operationId).undoneByOperationId).toBe(
      redoOp.id,
    );
  });

  it("replays a reschedule with the instant the original call asked for", async () => {
    const deps = seeded();
    const before = jobOf(deps, JOB_SCHEDULED_ID);
    const forward = await rescheduleJob(deps, userA, {
      jobId: before.id,
      scheduledAt: LATER,
    });
    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });
    expect((undone.resource as Job).scheduledAt).toBe(before.scheduledAt);

    const redone = await redoOperation(deps, userA, {
      operationId: undone.operationId,
    });

    // The argument came from the forward operation's `payload`, which is the
    // only place it is recorded.
    expect(redone.resource).toMatchObject({
      scheduledAt: LATER,
      version: 4,
    });
  });

  it("undoes a redo, because a redo is itself an undoable operation", async () => {
    const deps = seeded();
    const before = jobOf(deps, JOB_SCHEDULED_ID);
    const forward = await completeJob(deps, userA, { jobId: before.id });
    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });
    const redone = await redoOperation(deps, userA, {
      operationId: undone.operationId,
    });

    const undoneAgain = await undoOperation(deps, userA, {
      operationId: redone.operationId,
    });

    expect(undoneAgain.resource).toEqual({
      ...before,
      version: before.version + 4,
      updatedAt: NOW,
    });
    expect(operationOf(deps, redone.operationId).undoneByOperationId).toBe(
      undoneAgain.operationId,
    );
  });

  it("refuses to redo the undo of a redo, rather than guessing", async () => {
    const deps = seeded();
    const forward = await completeJob(deps, userA, {
      jobId: JOB_SCHEDULED_ID,
    });
    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });
    const redone = await redoOperation(deps, userA, {
      operationId: undone.operationId,
    });
    const undoneAgain = await undoOperation(deps, userA, {
      operationId: redone.operationId,
    });

    // The operation that undo pointed at is the *redo* row, whose action is
    // `redo-operation` and not a domain command; B9's algorithm has no rule
    // for it (see `docs/plan/DISCREPANCIES.md`).
    const err = await catchAppError(
      redoOperation(deps, userA, { operationId: undoneAgain.operationId }),
    );
    expect(err.code).toBe("INVARIANT");
    expect(err.message).toBe("This operation cannot be redone");
  });

  it("refuses when the record moved on after the undo", async () => {
    const deps = seeded();
    const forward = await rescheduleJob(deps, userA, {
      jobId: JOB_SCHEDULED_ID,
      scheduledAt: LATER,
    });
    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });
    await rescheduleJob(deps, userB, {
      jobId: JOB_SCHEDULED_ID,
      scheduledAt: LATER_STILL,
    });

    const err = await catchAppError(
      redoOperation(deps, userA, { operationId: undone.operationId }),
    );
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("Newer changes exist; redo refused");
    expect(jobOf(deps, JOB_SCHEDULED_ID).scheduledAt).toBe(LATER_STILL);
  });

  it("refuses to redo the undo of a create", async () => {
    const deps = seeded();
    const forward = await createCustomer(deps, acmeOwner, {
      name: "Example Customer C",
    });
    const undone = await undoOperation(deps, acmeOwner, {
      operationId: forward.operationId,
    });

    const err = await catchAppError(
      redoOperation(deps, acmeOwner, { operationId: undone.operationId }),
    );
    expect(err.code).toBe("INVARIANT");
    expect(err.message).toBe("A create cannot be redone");
    // Refused before anything was written: the customer stays archived.
    expect(deps.state.customers.get(forward.resource.id)?.version).toBe(2);
  });

  it("refuses a forward operation id with INVARIANT", async () => {
    const deps = seeded();
    const forward = await completeJob(deps, userA, {
      jobId: JOB_SCHEDULED_ID,
    });

    const err = await catchAppError(
      redoOperation(deps, userA, { operationId: forward.operationId }),
    );
    expect(err.code).toBe("INVARIANT");
    expect(err.message).toBe("Only an undo operation can be redone");
  });

  it("refuses an undo that has already been redone", async () => {
    const deps = seeded();
    const forward = await completeJob(deps, userA, {
      jobId: JOB_SCHEDULED_ID,
    });
    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });
    await redoOperation(deps, userA, { operationId: undone.operationId });

    const err = await catchAppError(
      redoOperation(deps, userA, { operationId: undone.operationId }),
    );
    expect(err.code).toBe("INVARIANT");
    expect(err.message).toBe("This undo has already been redone");
  });

  it("is NOT_FOUND for an operation of another organization", async () => {
    const deps = seeded();
    const err = await catchAppError(
      redoOperation(deps, outsider, { operationId: "op_create_cus_a" }),
    );
    expect(err.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// What the history feed then shows (B9's `undoable` / `redoable`)
// ---------------------------------------------------------------------------

describe("undo and redo in the activity feed", () => {
  it("does not let a member undo or redo an admin's customer archive", async () => {
    const deps = seeded();
    const archived = await archiveCustomer(deps, acmeAdmin, {
      customerId: CUSTOMER_A_ID,
    });
    await expect(
      undoOperation(deps, userA, { operationId: archived.operationId }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });
    const undone = await undoOperation(deps, acmeAdmin, {
      operationId: archived.operationId,
    });
    await expect(
      redoOperation(deps, userA, { operationId: undone.operationId }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });
    expect(customerOf(deps, CUSTOMER_A_ID).status).toBe("active");
    const activity = await listRecentActivity(deps, userA);
    expect(activity.find((op) => op.id === undone.operationId)?.redoable).toBe(
      false,
    );
    const redone = await redoOperation(deps, acmeOwner, {
      operationId: undone.operationId,
    });
    expect(redone.resource.status).toBe("archived");
  });

  it("lets members compensate their own customer creation but not a coworker's", async () => {
    const deps = seeded();
    const created = await createCustomer(deps, userA, {
      name: "Example new customer",
    });
    await expect(
      undoOperation(deps, userB, { operationId: created.operationId }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });
    const activity = await listRecentActivity(deps, userB);
    expect(activity.find((op) => op.id === created.operationId)?.undoable).toBe(
      false,
    );
    expect(
      (await undoOperation(deps, userA, { operationId: created.operationId }))
        .resource.status,
    ).toBe("archived");
  });

  it("rechecks the actor's current role even when they performed the original archive", async () => {
    const deps = seeded();
    const archived = await archiveCustomer(deps, acmeAdmin, {
      customerId: CUSTOMER_A_ID,
    });
    const undone = await undoOperation(deps, acmeAdmin, {
      operationId: archived.operationId,
    });
    await expect(
      redoOperation(
        deps,
        { ...acmeAdmin, role: "member" },
        { operationId: undone.operationId },
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });
  });

  it("lists the undo and redo rows with their kind, and offers the right button", async () => {
    const deps = seeded();
    const forward = await completeJob(deps, userA, {
      jobId: JOB_SCHEDULED_ID,
    });
    const undone = await undoOperation(deps, userA, {
      operationId: forward.operationId,
    });

    const afterUndo = await listRecentActivity(deps, acmeOwner, {
      resourceType: "job",
      resourceId: JOB_SCHEDULED_ID,
    });
    const undoEntry = afterUndo.find(
      (entry) => entry.id === undone.operationId,
    );
    expect(undoEntry?.kind).toBe("undo");
    expect(undoEntry?.action).toBe("undo-operation");
    // The undo is the newest operation and it reversed a transition, so redo
    // is offered and undo is not.
    expect(undoEntry?.redoable).toBe(true);
    expect(undoEntry?.undoable).toBe(false);
    expect(
      afterUndo.find((entry) => entry.id === forward.operationId)?.undoable,
    ).toBe(false);

    const redone = await redoOperation(deps, userA, {
      operationId: undone.operationId,
    });

    const afterRedo = await listRecentActivity(deps, acmeOwner, {
      resourceType: "job",
      resourceId: JOB_SCHEDULED_ID,
    });
    const redoEntry = afterRedo.find(
      (entry) => entry.id === redone.operationId,
    );
    expect(redoEntry?.kind).toBe("redo");
    expect(redoEntry?.action).toBe("redo-operation");
    // A redo can be undone (B9), and the undo it reversed can no longer be
    // redone.
    expect(redoEntry?.undoable).toBe(true);
    expect(redoEntry?.redoable).toBe(false);
    expect(
      afterRedo.find((entry) => entry.id === undone.operationId)?.redoable,
    ).toBe(false);
  });

  it("does not offer redo for the undo of a create", async () => {
    const deps = seeded();
    const forward = await createCustomer(deps, acmeOwner, {
      name: "Example Customer C",
    });
    const undone = await undoOperation(deps, acmeOwner, {
      operationId: forward.operationId,
    });

    const entries = await listRecentActivity(deps, acmeOwner, {
      resourceType: "customer",
      resourceId: forward.resource.id,
    });
    const undoEntry = entries.find((entry) => entry.id === undone.operationId);
    expect(undoEntry?.kind).toBe("undo");
    // `redoOperation` would refuse it with INVARIANT, so the flag says no.
    expect(undoEntry?.redoable).toBe(false);
  });
});
