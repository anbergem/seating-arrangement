/**
 * The seven command use cases (blueprint B8), against the in-memory
 * dependencies and the fixed B12 scenario.
 *
 * Every command is checked on five axes, because those are the five ways a
 * command can be wrong: it writes the right resource, it writes the right
 * operation row (the record undo replays, so `versionBefore`/`versionAfter`,
 * `inverse` and `payload` matter as much as the resource does), it refuses a
 * role that may not perform it, it refuses an id from another organization the
 * same way it refuses one that does not exist, and it refuses a stale
 * `expectedVersion`.
 *
 * The in-memory repositories return lists unordered (see
 * `docs/plan/DISCREPANCIES.md`, T08), so nothing here asserts on order.
 */

import { describe, expect, it } from "vitest";

import type { Actor } from "../../../src/application/actor";
import { AppError } from "../../../src/application/errors";
import type { Dependencies } from "../../../src/application/ports";
import { archiveCustomer } from "../../../src/application/use-cases/archive-customer";
import { archiveJob } from "../../../src/application/use-cases/archive-job";
import { isIdempotencyKeyViolation } from "../../../src/application/use-cases/command";
import { completeJob } from "../../../src/application/use-cases/complete-job";
import { createCustomer } from "../../../src/application/use-cases/create-customer";
import { createJob } from "../../../src/application/use-cases/create-job";
import { rescheduleJob } from "../../../src/application/use-cases/reschedule-job";
import { startJob } from "../../../src/application/use-cases/start-job";
import type { Operation } from "../../../src/domain";
import { OPERATION_CLASSIFICATION } from "../../../src/domain";
import {
  createInMemoryDependencies,
  type InMemoryDependencies,
} from "../../fixtures/in-memory";
import {
  seedInMemory,
  ADMIN_EMAIL,
  CUSTOMER_A_ID,
  CUSTOMER_ARCHIVED_ID,
  CUSTOMER_B_ID,
  CUSTOMER_OTHER_ID,
  JOB_ARCHIVED_ID,
  JOB_COMPLETED_ID,
  JOB_IN_PROGRESS_ID,
  JOB_OTHER_ID,
  JOB_SCHEDULED_ID,
  JOB_SCHEDULED_AT,
  MEMBER1_EMAIL,
  MEMBER2_EMAIL,
  ORG_ACME_ID,
  ORG_OTHER_ID,
  OUTSIDER_EMAIL,
  OWNER_EMAIL,
} from "../../fixtures/scenario";

/** The fixed clock every `createInMemoryDependencies()` uses. */
const NOW = "2026-09-06T12:00:00.000Z";

/** An instant no seeded job is scheduled at, so a reschedule to it is always a
 * real move. */
const LATER = "2026-11-11T07:30:00.000Z";

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

const acmeMember: Actor = {
  userEmail: MEMBER1_EMAIL,
  orgId: ORG_ACME_ID,
  role: "member",
  caller: "http",
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

/** The operation a command says it wrote, read back out of the store. */
function operationOf(deps: InMemoryDependencies, id: string): Operation {
  const op = deps.state.operations.get(id);
  if (!op) throw new Error(`no operation "${id}" was written`);
  return op;
}

/**
 * The fields every forward operation must carry the same way, whichever
 * command wrote it: the classification registered for the action, the actor's
 * identity and surface, the clock's instant, and no undo/redo linkage yet.
 */
function expectForwardOperation(
  op: Operation,
  expected: { action: string; actor: Actor; resourceId: string },
): void {
  expect(op.kind).toBe("forward");
  expect(op.action).toBe(expected.action);
  expect(op.orgId).toBe(expected.actor.orgId);
  expect(op.resourceId).toBe(expected.resourceId);
  expect(op.classification).toBe(OPERATION_CLASSIFICATION[expected.action]);
  expect(op.performedBy).toBe(expected.actor.userEmail);
  expect(op.performedVia).toBe(expected.actor.caller);
  expect(op.performedAt).toBe(NOW);
  expect(op.relatedOperationId).toBeNull();
  expect(op.undoneByOperationId).toBeNull();
}

// ---------------------------------------------------------------------------
// create-customer
// ---------------------------------------------------------------------------

describe("createCustomer", () => {
  it("creates an active customer at version 1 and records a compensatable operation", async () => {
    const deps = seeded();
    const result = await createCustomer(deps, acmeMember, {
      name: "Example Customer C",
      email: "c@example.invalid",
      phone: "555-0100",
      notes: "Prefers mornings",
    });

    expect(result.resource.name).toBe("Example Customer C");
    expect(result.resource.email).toBe("c@example.invalid");
    expect(result.resource.status).toBe("active");
    expect(result.resource.version).toBe(1);
    expect(result.resource.orgId).toBe(ORG_ACME_ID);
    expect(result.resource.createdBy).toBe(MEMBER1_EMAIL);
    expect(result.resource.createdAt).toBe(NOW);

    const op = operationOf(deps, result.operationId);
    expectForwardOperation(op, {
      action: "create-customer",
      actor: acmeMember,
      resourceId: result.resource.id,
    });
    expect(op.resourceType).toBe("customer");
    expect(op.versionBefore).toBe(0);
    expect(op.versionAfter).toBe(1);
    expect(op.inverse).toEqual({ type: "archive-customer" });
    expect(op.payload).toEqual({
      name: "Example Customer C",
      email: "c@example.invalid",
      phone: "555-0100",
      notes: "Prefers mornings",
    });
  });

  it("rejects a name the domain will not accept", async () => {
    const deps = seeded();
    const err = await catchAppError(
      createCustomer(deps, acmeMember, { name: "   " }),
    );
    expect(err.code).toBe("VALIDATION");
  });

  it("returns the first customer and writes no second operation when the key repeats", async () => {
    const deps = seeded();
    const first = await createCustomer(deps, acmeOwner, {
      name: "Example Customer C",
      idempotencyKey: "key-customer-1",
    });
    const operationsAfterFirst = deps.state.operations.size;
    const customersAfterFirst = deps.state.customers.size;

    const second = await createCustomer(deps, acmeOwner, {
      name: "Example Customer C",
      idempotencyKey: "key-customer-1",
    });

    expect(second.resource.id).toBe(first.resource.id);
    expect(second.operationId).toBe(first.operationId);
    expect(deps.state.operations.size).toBe(operationsAfterFirst);
    expect(deps.state.customers.size).toBe(customersAfterFirst);
  });

  it("still finds the create operation when newer operations exist", async () => {
    const deps = seeded();
    const first = await createCustomer(deps, acmeOwner, {
      name: "Example Customer C",
      idempotencyKey: "key-customer-busy",
    });
    // Two more operations on the same customer, so the create is no longer the
    // newest row for its resource — the case the replay reads through
    // `findCreateOperation` rather than through a page of recent operations.
    const archived = await archiveCustomer(deps, acmeOwner, {
      customerId: first.resource.id,
    });
    expect(archived.operationId).not.toBe(first.operationId);

    const replay = await createCustomer(deps, acmeOwner, {
      name: "Example Customer C",
      idempotencyKey: "key-customer-busy",
    });

    expect(replay.resource.id).toBe(first.resource.id);
    // The *create's* id, not the newest operation's.
    expect(replay.operationId).toBe(first.operationId);
    expect(operationOf(deps, replay.operationId).versionBefore).toBe(0);
  });

  it("keeps the key scoped to its action and organization", async () => {
    const deps = seeded();
    const first = await createCustomer(deps, acmeOwner, {
      name: "Example Customer C",
      idempotencyKey: "shared-key",
    });
    const customersAfterFirst = deps.state.customers.size;

    // Same key, different organization: a separate row entirely.
    const other = await createCustomer(deps, outsider, {
      name: "Other Company Customer B",
      idempotencyKey: "shared-key",
    });
    expect(other.resource.orgId).toBe(ORG_OTHER_ID);
    expect(other.resource.id).not.toBe(first.resource.id);
    expect(deps.state.customers.size).toBe(customersAfterFirst + 1);
  });

  it("answers with the winner's customer when its own write loses the key race", async () => {
    const deps = seeded();
    const winner = await createCustomer(deps, acmeOwner, {
      name: "Example Customer C",
      idempotencyKey: "key-race",
    });

    // The loser passes the lookup before the winner's key has landed, then
    // its own atomic batch is rolled back by the primary key on
    // `idempotency_keys`.
    let lookups = 0;
    const losing: Dependencies = {
      ...deps,
      idempotency: {
        find: async (orgId, action, key) => {
          lookups += 1;
          if (lookups === 1) return null;
          return deps.idempotency.find(orgId, action, key);
        },
      },
      customers: {
        ...deps.customers,
        create: async () => {
          throw new Error(
            "SQLITE_CONSTRAINT_PRIMARYKEY: UNIQUE constraint failed: idempotency_keys.org_id, idempotency_keys.action, idempotency_keys.key",
          );
        },
      },
    };

    const loser = await createCustomer(losing, acmeOwner, {
      name: "Example Customer C",
      idempotencyKey: "key-race",
    });

    expect(loser.resource.id).toBe(winner.resource.id);
    expect(loser.operationId).toBe(winner.operationId);
    expect(lookups).toBe(2);
  });

  it("rethrows a create failure that is not a duplicate key", async () => {
    const deps = seeded();
    const failing: Dependencies = {
      ...deps,
      idempotency: { find: async () => null },
      customers: {
        ...deps.customers,
        create: async () => {
          throw new AppError(
            "CONFLICT",
            "The record was changed by someone else",
          );
        },
      },
    };

    const err = await catchAppError(
      createCustomer(failing, acmeOwner, {
        name: "Example Customer C",
        idempotencyKey: "key-doomed",
      }),
    );
    expect(err.code).toBe("CONFLICT");
  });
});

describe("isIdempotencyKeyViolation", () => {
  it("recognises the messages the drivers produce", () => {
    expect(
      isIdempotencyKeyViolation(
        new Error(
          "SQLITE_CONSTRAINT_PRIMARYKEY: UNIQUE constraint failed: idempotency_keys.org_id, idempotency_keys.action, idempotency_keys.key",
        ),
      ),
    ).toBe(true);
    expect(
      isIdempotencyKeyViolation(new Error("PRIMARY KEY constraint failed")),
    ).toBe(true);
    expect(
      isIdempotencyKeyViolation(new AppError("NOT_FOUND", "Job not found")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// archive-customer — the admin-only demonstration (B6)
// ---------------------------------------------------------------------------

describe("archiveCustomer", () => {
  it("archives the customer, bumps the version and records a reversible operation", async () => {
    const deps = seeded();
    const result = await archiveCustomer(deps, acmeAdmin, {
      customerId: CUSTOMER_A_ID,
    });

    expect(result.resource.status).toBe("archived");
    expect(result.resource.version).toBe(2);
    expect(result.resource.updatedAt).toBe(NOW);
    expect(deps.state.customers.get(CUSTOMER_A_ID)?.status).toBe("archived");

    const op = operationOf(deps, result.operationId);
    expectForwardOperation(op, {
      action: "archive-customer",
      actor: acmeAdmin,
      resourceId: CUSTOMER_A_ID,
    });
    expect(op.resourceType).toBe("customer");
    expect(op.versionBefore).toBe(1);
    expect(op.versionAfter).toBe(2);
    expect(op.inverse).toEqual({ type: "restore-customer" });
    expect(op.payload).toEqual({});
  });

  it("lets an owner archive too", async () => {
    const deps = seeded();
    const result = await archiveCustomer(deps, acmeOwner, {
      customerId: CUSTOMER_B_ID,
    });
    expect(result.resource.status).toBe("archived");
  });

  it("refuses a member before touching anything", async () => {
    const deps = seeded();
    const operationsBefore = deps.state.operations.size;

    const err = await catchAppError(
      archiveCustomer(deps, acmeMember, { customerId: CUSTOMER_A_ID }),
    );
    expect(err.code).toBe("AUTHORIZATION");
    expect(err.message).toBe("Role member may not customers:archive");
    expect(deps.state.customers.get(CUSTOMER_A_ID)?.status).toBe("active");
    expect(deps.state.operations.size).toBe(operationsBefore);
  });

  it("reports a customer of another organization as not found", async () => {
    const deps = seeded();
    const err = await catchAppError(
      archiveCustomer(deps, acmeOwner, { customerId: CUSTOMER_OTHER_ID }),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Customer not found");
  });

  it("refuses a stale expectedVersion", async () => {
    const deps = seeded();
    const err = await catchAppError(
      archiveCustomer(deps, acmeOwner, {
        customerId: CUSTOMER_A_ID,
        expectedVersion: 7,
      }),
    );
    expect(err.code).toBe("CONFLICT");
    expect(deps.state.customers.get(CUSTOMER_A_ID)?.status).toBe("active");
  });

  it("accepts a matching expectedVersion", async () => {
    const deps = seeded();
    const result = await archiveCustomer(deps, acmeOwner, {
      customerId: CUSTOMER_A_ID,
      expectedVersion: 1,
    });
    expect(result.resource.version).toBe(2);
  });

  it("refuses a customer that is already archived", async () => {
    const deps = seeded();
    const err = await catchAppError(
      archiveCustomer(deps, acmeOwner, { customerId: CUSTOMER_ARCHIVED_ID }),
    );
    expect(err.code).toBe("INVARIANT");
  });
});

// ---------------------------------------------------------------------------
// create-job
// ---------------------------------------------------------------------------

describe("createJob", () => {
  it("creates a scheduled job at version 1 and records a compensatable operation", async () => {
    const deps = seeded();
    const result = await createJob(deps, acmeMember, {
      customerId: CUSTOMER_A_ID,
      title: "Example Job",
      description: "Replace the filter",
      scheduledAt: LATER,
      assignedTo: MEMBER2_EMAIL,
    });

    expect(result.resource.title).toBe("Example Job");
    expect(result.resource.status).toBe("scheduled");
    expect(result.resource.scheduledAt).toBe(LATER);
    expect(result.resource.assignedTo).toBe(MEMBER2_EMAIL);
    expect(result.resource.version).toBe(1);
    expect(result.resource.createdBy).toBe(MEMBER1_EMAIL);

    const op = operationOf(deps, result.operationId);
    expectForwardOperation(op, {
      action: "create-job",
      actor: acmeMember,
      resourceId: result.resource.id,
    });
    expect(op.resourceType).toBe("job");
    expect(op.versionBefore).toBe(0);
    expect(op.versionAfter).toBe(1);
    expect(op.inverse).toEqual({ type: "archive-job" });
    expect(op.payload).toEqual({
      customerId: CUSTOMER_A_ID,
      title: "Example Job",
      description: "Replace the filter",
      scheduledAt: LATER,
      assignedTo: MEMBER2_EMAIL,
    });
  });

  it("leaves an unassigned job unassigned", async () => {
    const deps = seeded();
    const result = await createJob(deps, acmeOwner, {
      customerId: CUSTOMER_A_ID,
      title: "Example Job",
      scheduledAt: LATER,
    });
    expect(result.resource.assignedTo).toBeNull();
    expect(result.resource.description).toBe("");
  });

  it("refuses an assignee who is not a member of the organization", async () => {
    const deps = seeded();
    const jobsBefore = deps.state.jobs.size;

    const err = await catchAppError(
      createJob(deps, acmeOwner, {
        customerId: CUSTOMER_A_ID,
        title: "Example Job",
        scheduledAt: LATER,
        assignedTo: OUTSIDER_EMAIL,
      }),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toBe("Assignee is not a member of this organization");
    expect(deps.state.jobs.size).toBe(jobsBefore);
  });

  it("refuses an archived customer", async () => {
    const deps = seeded();
    const err = await catchAppError(
      createJob(deps, acmeOwner, {
        customerId: CUSTOMER_ARCHIVED_ID,
        title: "Example Job",
        scheduledAt: LATER,
      }),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Customer not found or archived");
  });

  it("refuses a customer of another organization", async () => {
    const deps = seeded();
    const err = await catchAppError(
      createJob(deps, acmeOwner, {
        customerId: CUSTOMER_OTHER_ID,
        title: "Example Job",
        scheduledAt: LATER,
      }),
    );
    expect(err.code).toBe("NOT_FOUND");
  });

  it("returns the first job and writes no second operation when the key repeats", async () => {
    const deps = seeded();
    const first = await createJob(deps, acmeOwner, {
      customerId: CUSTOMER_A_ID,
      title: "Example Job",
      scheduledAt: LATER,
      idempotencyKey: "key-job-1",
    });
    const operationsAfterFirst = deps.state.operations.size;
    const jobsAfterFirst = deps.state.jobs.size;

    const second = await createJob(deps, acmeOwner, {
      customerId: CUSTOMER_A_ID,
      title: "Example Job",
      scheduledAt: LATER,
      idempotencyKey: "key-job-1",
    });

    expect(second.resource.id).toBe(first.resource.id);
    expect(second.operationId).toBe(first.operationId);
    expect(deps.state.operations.size).toBe(operationsAfterFirst);
    expect(deps.state.jobs.size).toBe(jobsAfterFirst);
  });

  it("answers with the winner's job when its own write loses the key race", async () => {
    const deps = seeded();
    const winner = await createJob(deps, acmeOwner, {
      customerId: CUSTOMER_A_ID,
      title: "Example Job",
      scheduledAt: LATER,
      idempotencyKey: "key-job-race",
    });

    let lookups = 0;
    const losing: Dependencies = {
      ...deps,
      idempotency: {
        find: async (orgId, action, key) => {
          lookups += 1;
          if (lookups === 1) return null;
          return deps.idempotency.find(orgId, action, key);
        },
      },
      jobs: {
        ...deps.jobs,
        create: async () => {
          throw new Error(
            "SQLITE_CONSTRAINT_PRIMARYKEY: UNIQUE constraint failed: idempotency_keys.org_id, idempotency_keys.action, idempotency_keys.key",
          );
        },
      },
    };

    const loser = await createJob(losing, acmeOwner, {
      customerId: CUSTOMER_A_ID,
      title: "Example Job",
      scheduledAt: LATER,
      idempotencyKey: "key-job-race",
    });

    expect(loser.resource.id).toBe(winner.resource.id);
    expect(loser.operationId).toBe(winner.operationId);
  });
});

// ---------------------------------------------------------------------------
// reschedule-job
// ---------------------------------------------------------------------------

describe("rescheduleJob", () => {
  it("moves the job and records the previous instant as the inverse", async () => {
    const deps = seeded();
    const result = await rescheduleJob(deps, acmeMember, {
      jobId: JOB_SCHEDULED_ID,
      scheduledAt: LATER,
    });

    expect(result.resource.scheduledAt).toBe(LATER);
    expect(result.resource.version).toBe(2);
    expect(result.resource.updatedAt).toBe(NOW);

    const op = operationOf(deps, result.operationId);
    expectForwardOperation(op, {
      action: "reschedule-job",
      actor: acmeMember,
      resourceId: JOB_SCHEDULED_ID,
    });
    expect(op.resourceType).toBe("job");
    expect(op.versionBefore).toBe(1);
    expect(op.versionAfter).toBe(2);
    expect(op.inverse).toEqual({
      type: "restore-job-schedule",
      previousScheduledAt: JOB_SCHEDULED_AT,
    });
    expect(op.payload).toEqual({ scheduledAt: LATER });
  });

  it("reports a job of another organization as not found", async () => {
    const deps = seeded();
    const err = await catchAppError(
      rescheduleJob(deps, acmeOwner, {
        jobId: JOB_OTHER_ID,
        scheduledAt: LATER,
      }),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Job not found");
  });

  it("refuses a stale expectedVersion", async () => {
    const deps = seeded();
    const err = await catchAppError(
      rescheduleJob(deps, acmeOwner, {
        jobId: JOB_SCHEDULED_ID,
        scheduledAt: LATER,
        expectedVersion: 9,
      }),
    );
    expect(err.code).toBe("CONFLICT");
    expect(deps.state.jobs.get(JOB_SCHEDULED_ID)?.scheduledAt).toBe(
      JOB_SCHEDULED_AT,
    );
  });

  it("refuses an archived job", async () => {
    const deps = seeded();
    const err = await catchAppError(
      rescheduleJob(deps, acmeOwner, {
        jobId: JOB_ARCHIVED_ID,
        scheduledAt: LATER,
      }),
    );
    expect(err.code).toBe("INVARIANT");
  });
});

// ---------------------------------------------------------------------------
// start-job
// ---------------------------------------------------------------------------

describe("startJob", () => {
  it("moves a scheduled job to in_progress and records the previous status", async () => {
    const deps = seeded();
    const result = await startJob(deps, acmeMember, {
      jobId: JOB_SCHEDULED_ID,
    });

    expect(result.resource.status).toBe("in_progress");
    expect(result.resource.version).toBe(2);

    const op = operationOf(deps, result.operationId);
    expectForwardOperation(op, {
      action: "start-job",
      actor: acmeMember,
      resourceId: JOB_SCHEDULED_ID,
    });
    expect(op.versionBefore).toBe(1);
    expect(op.versionAfter).toBe(2);
    expect(op.inverse).toEqual({
      type: "restore-job-status",
      previous: { status: "scheduled", completedAt: null, archivedAt: null },
    });
    expect(op.payload).toEqual({});
  });

  it("refuses a job that is already in progress", async () => {
    const deps = seeded();
    const err = await catchAppError(
      startJob(deps, acmeOwner, { jobId: JOB_IN_PROGRESS_ID }),
    );
    expect(err.code).toBe("INVARIANT");
    expect(err.message).toBe("Cannot start a job that is in_progress");
  });

  it("reports a job of another organization as not found", async () => {
    const deps = seeded();
    const err = await catchAppError(
      startJob(deps, acmeOwner, { jobId: JOB_OTHER_ID }),
    );
    expect(err.code).toBe("NOT_FOUND");
  });

  it("refuses a stale expectedVersion", async () => {
    const deps = seeded();
    const err = await catchAppError(
      startJob(deps, acmeOwner, {
        jobId: JOB_SCHEDULED_ID,
        expectedVersion: 4,
      }),
    );
    expect(err.code).toBe("CONFLICT");
    expect(deps.state.jobs.get(JOB_SCHEDULED_ID)?.status).toBe("scheduled");
  });
});

// ---------------------------------------------------------------------------
// complete-job
// ---------------------------------------------------------------------------

describe("completeJob", () => {
  it("completes an in-progress job, stamps completedAt and records the previous status", async () => {
    const deps = seeded();
    const result = await completeJob(deps, acmeMember, {
      jobId: JOB_IN_PROGRESS_ID,
    });

    expect(result.resource.status).toBe("completed");
    expect(result.resource.completedAt).toBe(NOW);
    expect(result.resource.version).toBe(3);

    const op = operationOf(deps, result.operationId);
    expectForwardOperation(op, {
      action: "complete-job",
      actor: acmeMember,
      resourceId: JOB_IN_PROGRESS_ID,
    });
    expect(op.versionBefore).toBe(2);
    expect(op.versionAfter).toBe(3);
    expect(op.inverse).toEqual({
      type: "restore-job-status",
      previous: { status: "in_progress", completedAt: null, archivedAt: null },
    });
    expect(op.payload).toEqual({});
  });

  it("completes a job that was never started", async () => {
    const deps = seeded();
    const result = await completeJob(deps, acmeOwner, {
      jobId: JOB_SCHEDULED_ID,
    });
    expect(result.resource.status).toBe("completed");
    expect(result.resource.version).toBe(2);
  });

  it("refuses an archived job", async () => {
    const deps = seeded();
    const err = await catchAppError(
      completeJob(deps, acmeOwner, { jobId: JOB_ARCHIVED_ID }),
    );
    expect(err.code).toBe("INVARIANT");
    expect(err.message).toBe("Cannot complete a job that is archived");
    expect(deps.state.jobs.get(JOB_ARCHIVED_ID)?.status).toBe("archived");
  });

  it("reports a job of another organization as not found", async () => {
    const deps = seeded();
    const err = await catchAppError(
      completeJob(deps, acmeOwner, { jobId: JOB_OTHER_ID }),
    );
    expect(err.code).toBe("NOT_FOUND");
  });

  it("refuses a stale expectedVersion", async () => {
    const deps = seeded();
    const err = await catchAppError(
      completeJob(deps, acmeOwner, {
        jobId: JOB_IN_PROGRESS_ID,
        expectedVersion: 1,
      }),
    );
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("The job was changed by someone else");
  });
});

// ---------------------------------------------------------------------------
// archive-job
// ---------------------------------------------------------------------------

describe("archiveJob", () => {
  it("archives a completed job, stamps archivedAt and keeps its completion in the inverse", async () => {
    const deps = seeded();
    const completedBefore = deps.state.jobs.get(JOB_COMPLETED_ID);
    const result = await archiveJob(deps, acmeMember, {
      jobId: JOB_COMPLETED_ID,
    });

    expect(result.resource.status).toBe("archived");
    expect(result.resource.archivedAt).toBe(NOW);
    expect(result.resource.version).toBe(3);

    const op = operationOf(deps, result.operationId);
    expectForwardOperation(op, {
      action: "archive-job",
      actor: acmeMember,
      resourceId: JOB_COMPLETED_ID,
    });
    expect(op.versionBefore).toBe(2);
    expect(op.versionAfter).toBe(3);
    expect(op.inverse).toEqual({
      type: "restore-job-status",
      previous: {
        status: "completed",
        completedAt: completedBefore?.completedAt,
        archivedAt: null,
      },
    });
    expect(op.payload).toEqual({});
  });

  it("archives a scheduled job too", async () => {
    const deps = seeded();
    const result = await archiveJob(deps, acmeOwner, {
      jobId: JOB_SCHEDULED_ID,
    });
    expect(result.resource.status).toBe("archived");
  });

  it("refuses a job that is already archived", async () => {
    const deps = seeded();
    const err = await catchAppError(
      archiveJob(deps, acmeOwner, { jobId: JOB_ARCHIVED_ID }),
    );
    expect(err.code).toBe("INVARIANT");
  });

  it("reports a job of another organization as not found", async () => {
    const deps = seeded();
    const err = await catchAppError(
      archiveJob(deps, acmeOwner, { jobId: JOB_OTHER_ID }),
    );
    expect(err.code).toBe("NOT_FOUND");
  });

  it("refuses a stale expectedVersion", async () => {
    const deps = seeded();
    const err = await catchAppError(
      archiveJob(deps, acmeOwner, {
        jobId: JOB_COMPLETED_ID,
        expectedVersion: 1,
      }),
    );
    expect(err.code).toBe("CONFLICT");
    expect(deps.state.jobs.get(JOB_COMPLETED_ID)?.status).toBe("completed");
  });
});
