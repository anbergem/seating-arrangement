/**
 * The five read use cases (blueprint B8), against the in-memory dependencies
 * and the fixed B12 scenario.
 *
 * Two things are checked everywhere: that the query returns what `org_acme`
 * has, and that the same query run by `org_other`'s owner sees only
 * `org_other` — never a row, a name or the difference between "no such id"
 * and "not yours".
 */

import { describe, expect, it } from "vitest";

import type { Actor } from "../../../src/application/actor";
import { AppError } from "../../../src/application/errors";
import type {
  Dependencies,
  OperationRepository,
} from "../../../src/application/ports";
import { getCustomer } from "../../../src/application/use-cases/get-customer";
import { getJob } from "../../../src/application/use-cases/get-job";
import { listCustomers } from "../../../src/application/use-cases/list-customers";
import { listJobs } from "../../../src/application/use-cases/list-jobs";
import {
  listRecentActivity,
  DEFAULT_ACTIVITY_LIMIT,
  MAX_ACTIVITY_LIMIT,
} from "../../../src/application/use-cases/list-recent-activity";
import type { Operation } from "../../../src/domain";
import {
  createInMemoryDependencies,
  type InMemoryDependencies,
} from "../../fixtures/in-memory";
import {
  seedInMemory,
  CUSTOMER_A_ID,
  CUSTOMER_A_NAME,
  CUSTOMER_ARCHIVED_ID,
  CUSTOMER_B_ID,
  CUSTOMER_B_NAME,
  CUSTOMER_OTHER_ID,
  JOB_ARCHIVED_ID,
  JOB_ARCHIVED_SCHEDULED_AT,
  JOB_COMPLETED_ID,
  JOB_IN_PROGRESS_ID,
  JOB_IN_PROGRESS_SCHEDULED_AT,
  JOB_OTHER_ID,
  JOB_SCHEDULED_ID,
  ORG_ACME_ID,
  ORG_OTHER_ID,
  OUTSIDER_EMAIL,
  OWNER_EMAIL,
} from "../../fixtures/scenario";

const acmeOwner: Actor = {
  userEmail: OWNER_EMAIL,
  orgId: ORG_ACME_ID,
  role: "owner",
  caller: "test",
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

function ids(rows: readonly { id: string }[]): string[] {
  return rows.map((row) => row.id).sort();
}

describe("listCustomers", () => {
  it("returns the organization's active customers by default", async () => {
    const deps = seeded();
    const customers = await listCustomers(deps, acmeOwner, {});
    expect(ids(customers)).toEqual([CUSTOMER_A_ID, CUSTOMER_B_ID]);
  });

  it("includes archived customers when asked", async () => {
    const deps = seeded();
    const customers = await listCustomers(deps, acmeOwner, {
      includeArchived: true,
    });
    expect(ids(customers)).toEqual([
      CUSTOMER_A_ID,
      CUSTOMER_ARCHIVED_ID,
      CUSTOMER_B_ID,
    ]);
  });

  it("filters by a case-insensitive name substring", async () => {
    const deps = seeded();
    const customers = await listCustomers(deps, acmeOwner, {
      search: "customer b",
    });
    expect(ids(customers)).toEqual([CUSTOMER_B_ID]);
  });

  it("treats a blank search as no search", async () => {
    const deps = seeded();
    const customers = await listCustomers(deps, acmeOwner, { search: "   " });
    expect(ids(customers)).toEqual([CUSTOMER_A_ID, CUSTOMER_B_ID]);
  });

  it("shows the outsider only the other organization's customers", async () => {
    const deps = seeded();
    const customers = await listCustomers(deps, outsider, {
      includeArchived: true,
    });
    expect(ids(customers)).toEqual([CUSTOMER_OTHER_ID]);
  });
});

describe("getCustomer", () => {
  it("returns the customer", async () => {
    const deps = seeded();
    const customer = await getCustomer(deps, acmeOwner, {
      customerId: CUSTOMER_A_ID,
    });
    expect(customer.name).toBe(CUSTOMER_A_NAME);
  });

  it("returns an archived customer too", async () => {
    const deps = seeded();
    const customer = await getCustomer(deps, acmeOwner, {
      customerId: CUSTOMER_ARCHIVED_ID,
    });
    expect(customer.status).toBe("archived");
  });

  it("is NOT_FOUND for a customer of another organization", async () => {
    const deps = seeded();
    const err = await catchAppError(
      getCustomer(deps, outsider, { customerId: CUSTOMER_A_ID }),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Customer not found");
  });

  it("is NOT_FOUND for an unknown id", async () => {
    const deps = seeded();
    const err = await catchAppError(
      getCustomer(deps, acmeOwner, { customerId: "cus_missing" }),
    );
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("listJobs", () => {
  it("excludes archived jobs by default", async () => {
    const deps = seeded();
    const jobs = await listJobs(deps, acmeOwner, {});
    expect(ids(jobs)).toEqual([
      JOB_COMPLETED_ID,
      JOB_IN_PROGRESS_ID,
      JOB_SCHEDULED_ID,
    ]);
  });

  it("includes archived jobs when asked", async () => {
    const deps = seeded();
    const jobs = await listJobs(deps, acmeOwner, { includeArchived: true });
    expect(ids(jobs)).toEqual([
      JOB_ARCHIVED_ID,
      JOB_COMPLETED_ID,
      JOB_IN_PROGRESS_ID,
      JOB_SCHEDULED_ID,
    ]);
  });

  it("returns archived jobs when status asks for them explicitly", async () => {
    const deps = seeded();
    const jobs = await listJobs(deps, acmeOwner, { status: "archived" });
    expect(ids(jobs)).toEqual([JOB_ARCHIVED_ID]);
  });

  it("filters by status", async () => {
    const deps = seeded();
    const jobs = await listJobs(deps, acmeOwner, { status: "in_progress" });
    expect(ids(jobs)).toEqual([JOB_IN_PROGRESS_ID]);
  });

  it("filters by customer", async () => {
    const deps = seeded();
    const jobs = await listJobs(deps, acmeOwner, { customerId: CUSTOMER_A_ID });
    expect(ids(jobs)).toEqual([JOB_IN_PROGRESS_ID, JOB_SCHEDULED_ID]);
  });

  it("treats the scheduledAt window as half-open: from inclusive", async () => {
    const deps = seeded();
    const jobs = await listJobs(deps, acmeOwner, {
      from: JOB_ARCHIVED_SCHEDULED_AT,
      includeArchived: true,
    });
    expect(ids(jobs)).toEqual([
      JOB_ARCHIVED_ID,
      JOB_IN_PROGRESS_ID,
      JOB_SCHEDULED_ID,
    ]);
  });

  it("treats the scheduledAt window as half-open: to exclusive", async () => {
    const deps = seeded();
    const jobs = await listJobs(deps, acmeOwner, {
      to: JOB_IN_PROGRESS_SCHEDULED_AT,
      includeArchived: true,
    });
    expect(ids(jobs)).toEqual([JOB_ARCHIVED_ID, JOB_COMPLETED_ID]);
  });

  // The assertions above are about the set, not the order: `ids()` sorts.
  // Both repositories now order by `scheduled_at ASC, id ASC` (T11 changed the
  // in-memory one; see DISCREPANCIES, 2026-09-06 T08), and the case below
  // pins that.

  it("returns jobs in scheduled order, like the D1 repository", async () => {
    const deps = seeded();
    const jobs = await listJobs(deps, acmeOwner, { includeArchived: true });
    expect(jobs.map((job) => job.id)).toEqual([
      JOB_COMPLETED_ID,
      JOB_ARCHIVED_ID,
      JOB_IN_PROGRESS_ID,
      JOB_SCHEDULED_ID,
    ]);
  });

  it("shows the outsider only the other organization's jobs", async () => {
    const deps = seeded();
    const jobs = await listJobs(deps, outsider, { includeArchived: true });
    expect(ids(jobs)).toEqual([JOB_OTHER_ID]);
  });
});

describe("getJob", () => {
  it("returns the job and its customer's name", async () => {
    const deps = seeded();
    const result = await getJob(deps, acmeOwner, { jobId: JOB_SCHEDULED_ID });
    expect(result.job.id).toBe(JOB_SCHEDULED_ID);
    expect(result.customerName).toBe(CUSTOMER_A_NAME);
  });

  it("names the customer of a completed job too", async () => {
    const deps = seeded();
    const result = await getJob(deps, acmeOwner, { jobId: JOB_COMPLETED_ID });
    expect(result.customerName).toBe(CUSTOMER_B_NAME);
  });

  it("is NOT_FOUND for a job of another organization", async () => {
    const deps = seeded();
    const err = await catchAppError(
      getJob(deps, outsider, { jobId: JOB_SCHEDULED_ID }),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Job not found");
  });

  it("is NOT_FOUND for an unknown id", async () => {
    const deps = seeded();
    const err = await catchAppError(
      getJob(deps, acmeOwner, { jobId: "job_missing" }),
    );
    expect(err.code).toBe("NOT_FOUND");
  });
});

/** Wraps `deps.operations` so a test can see the `limit` the use case asked
 * the repository for, which is the only observable difference between the
 * default and the clamp on a scenario with ten operations. */
function recordingLimits(deps: InMemoryDependencies): {
  deps: Dependencies;
  limits: number[];
} {
  const limits: number[] = [];
  const operations: OperationRepository = {
    ...deps.operations,
    listRecent: async (orgId, limit) => {
      limits.push(limit);
      return deps.operations.listRecent(orgId, limit);
    },
  };
  return { deps: { ...deps, operations }, limits };
}

describe("listRecentActivity", () => {
  it("returns the organization's operations newest first", async () => {
    const deps = seeded();
    const entries = await listRecentActivity(deps, acmeOwner, {});
    // `op_archive_job_archived` is the only operation at the latest seeded
    // instant, so its position is unambiguous.
    expect(entries[0]?.id).toBe("op_archive_job_archived");
    expect(entries).toHaveLength(10);
    for (const entry of entries) expect(entry.orgId).toBe(ORG_ACME_ID);
  });

  it("marks the complete-job operation on job_completed as undoable", async () => {
    const deps = seeded();
    const entries = await listRecentActivity(deps, acmeOwner, {});
    const completed = entries.find(
      (entry) => entry.id === "op_complete_job_completed",
    );
    expect(completed?.undoable).toBe(true);
    expect(completed?.redoable).toBe(false);
  });

  it("marks a customer's create operation as undoable (compensation)", async () => {
    const deps = seeded();
    const entries = await listRecentActivity(deps, acmeOwner, {});
    for (const id of ["op_create_cus_a", "op_create_cus_b"]) {
      expect(entries.find((entry) => entry.id === id)?.undoable).toBe(true);
    }
  });

  it("marks the archived job's create operation as not undoable", async () => {
    const deps = seeded();
    const entries = await listRecentActivity(deps, acmeOwner, {});
    // The job is at version 2 and the create operation left it at version 1:
    // a newer operation exists, so undoing the create would discard it.
    expect(
      entries.find((entry) => entry.id === "op_create_job_archived")?.undoable,
    ).toBe(false);
    expect(
      entries.find((entry) => entry.id === "op_archive_job_archived")?.undoable,
    ).toBe(true);
  });

  it("marks an undo operation that still describes the current version as redoable", async () => {
    const deps = seeded();
    // What T10's `undoOperation` will write when it undoes
    // `op_complete_job_completed`: the job goes back to `scheduled` at
    // version 3, and the forward operation is marked as undone by this one.
    const job = deps.state.jobs.get(JOB_COMPLETED_ID);
    if (!job) throw new Error("job_completed missing from the scenario");
    deps.state.jobs.set(job.id, {
      ...job,
      status: "scheduled",
      completedAt: null,
      version: 3,
    });
    const forward = deps.state.operations.get("op_complete_job_completed");
    if (!forward) throw new Error("op_complete_job_completed missing");
    deps.state.operations.set(forward.id, {
      ...forward,
      undoneByOperationId: "op_undo_complete",
    });
    const undoOp: Operation = {
      ...forward,
      id: "op_undo_complete",
      kind: "undo",
      action: "undo-operation",
      versionBefore: 2,
      versionAfter: 3,
      relatedOperationId: forward.id,
      undoneByOperationId: null,
      performedAt: "2026-09-04T09:00:00.000Z",
    };
    deps.state.operations.set(undoOp.id, undoOp);

    const entries = await listRecentActivity(deps, acmeOwner, {});
    const undone = entries.find((entry) => entry.id === forward.id);
    expect(undone?.undoable).toBe(false);
    const undo = entries.find((entry) => entry.id === undoOp.id);
    expect(undo?.redoable).toBe(true);
    expect(undo?.undoable).toBe(false);
  });

  it("marks the undo of a create as not redoable", async () => {
    const deps = seeded();
    // The same shape as the test above, but the operation the undo reversed is
    // a create: `redo-operation` refuses those with INVARIANT (a create's undo
    // is a compensation, not something to re-apply), so the flag must not
    // offer it. B9's third redo rule.
    const customer = deps.state.customers.get(CUSTOMER_B_ID);
    if (!customer) throw new Error("cus_b missing from the scenario");
    deps.state.customers.set(customer.id, {
      ...customer,
      status: "archived",
      version: 2,
    });
    const forward = deps.state.operations.get("op_create_cus_b");
    if (!forward) throw new Error("op_create_cus_b missing");
    deps.state.operations.set(forward.id, {
      ...forward,
      undoneByOperationId: "op_undo_create_cus_b",
    });
    const undoOp: Operation = {
      ...forward,
      id: "op_undo_create_cus_b",
      kind: "undo",
      action: "undo-operation",
      versionBefore: 1,
      versionAfter: 2,
      relatedOperationId: forward.id,
      undoneByOperationId: null,
      performedAt: "2026-09-04T09:00:00.000Z",
    };
    deps.state.operations.set(undoOp.id, undoOp);

    const entries = await listRecentActivity(deps, acmeOwner, {});
    const undo = entries.find((entry) => entry.id === undoOp.id);
    // The first two redo rules hold — it is an open undo describing version 2,
    // which is the customer's current version — and only the third fails.
    expect(undo?.versionAfter).toBe(2);
    expect(undo?.redoable).toBe(false);
  });

  it("filters to one resource's history", async () => {
    const deps = seeded();
    const entries = await listRecentActivity(deps, acmeOwner, {
      resourceType: "job",
      resourceId: JOB_ARCHIVED_ID,
    });
    expect(entries.map((entry) => entry.id)).toEqual([
      "op_archive_job_archived",
      "op_create_job_archived",
    ]);
  });

  it("rejects a resourceId without a resourceType", async () => {
    const deps = seeded();
    const err = await catchAppError(
      listRecentActivity(deps, acmeOwner, { resourceId: JOB_ARCHIVED_ID }),
    );
    expect(err.code).toBe("VALIDATION");
  });

  it("honours limit, defaults to 20 and clamps to 100", async () => {
    const seeds = seeded();
    const two = await listRecentActivity(seeds, acmeOwner, { limit: 2 });
    expect(two).toHaveLength(2);

    const recorded = recordingLimits(seeds);
    await listRecentActivity(recorded.deps, acmeOwner, {});
    await listRecentActivity(recorded.deps, acmeOwner, { limit: 500 });
    expect(recorded.limits).toEqual([
      DEFAULT_ACTIVITY_LIMIT,
      MAX_ACTIVITY_LIMIT,
    ]);
  });

  it("shows the outsider only the other organization's operations", async () => {
    const deps = seeded();
    const entries = await listRecentActivity(deps, outsider, {});
    expect(ids(entries)).toEqual([
      "op_create_cus_other",
      "op_create_job_other",
    ]);
  });

  it("returns nothing for a resource of another organization", async () => {
    const deps = seeded();
    const entries = await listRecentActivity(deps, outsider, {
      resourceType: "job",
      resourceId: JOB_SCHEDULED_ID,
    });
    expect(entries).toEqual([]);
  });
});
