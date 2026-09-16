/** Real-repository undo/redo guarantees from blueprint B9 and D27. */

import { describe, expect, it } from "vitest";

import { archiveCustomer } from "../../src/application/use-cases/archive-customer";
import { completeJob } from "../../src/application/use-cases/complete-job";
import { redoOperation } from "../../src/application/use-cases/redo-operation";
import { rescheduleJob } from "../../src/application/use-cases/reschedule-job";
import { undoOperation } from "../../src/application/use-cases/undo-operation";
import {
  reconcileAccountingExport,
  restoreJobStatus,
  type Operation,
} from "../../src/domain";
import { getDependencies } from "../../src/infrastructure/container";
import {
  ADMIN_EMAIL,
  CUSTOMER_B_ID,
  JOB_COMPLETED_ID,
  JOB_SCHEDULED_ID,
  MEMBER1_EMAIL,
  MEMBER2_EMAIL,
  ORG_ACME_ID,
} from "../fixtures/scenario";

const memberOne = {
  userEmail: MEMBER1_EMAIL,
  orgId: ORG_ACME_ID,
  role: "member" as const,
  caller: "test",
};
const memberTwo = { ...memberOne, userEmail: MEMBER2_EMAIL };
const admin = { ...memberOne, userEmail: ADMIN_EMAIL, role: "admin" as const };

describe("use cases against Node SQLite repositories", () => {
  it("refuses a stale undo after another actor has changed the same job", async () => {
    const deps = getDependencies();
    const rescheduled = await rescheduleJob(deps, memberOne, {
      jobId: JOB_SCHEDULED_ID,
      scheduledAt: "2026-10-03T08:00:00.000Z",
    });
    expect(rescheduled.resource.version).toBe(2);

    const completed = await completeJob(deps, memberTwo, {
      jobId: JOB_SCHEDULED_ID,
      expectedVersion: rescheduled.resource.version,
    });
    expect(completed.resource.version).toBe(3);

    await expect(
      undoOperation(deps, memberOne, { operationId: rescheduled.operationId }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Newer changes exist; undo refused",
    });

    const undoneCompletion = await undoOperation(deps, memberTwo, {
      operationId: completed.operationId,
    });
    expect(undoneCompletion.resource.version).toBe(4);
    expect(undoneCompletion.resource.status).toBe("scheduled");

    await expect(
      undoOperation(deps, memberOne, { operationId: rescheduled.operationId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not let a member redo an admin-only customer archive", async () => {
    const deps = getDependencies();
    const archived = await archiveCustomer(deps, admin, {
      customerId: "cus_b",
    });
    const undone = await undoOperation(deps, admin, {
      operationId: archived.operationId,
    });
    expect(undone.resource.status).toBe("active");

    await expect(
      redoOperation(deps, memberOne, { operationId: undone.operationId }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });

    await expect(
      deps.customers.getById(ORG_ACME_ID, "cus_b"),
    ).resolves.toMatchObject({
      status: "active",
      version: undone.resource.version,
    });
  });

  it("does not reopen a completed job once a durable export is pending", async () => {
    const deps = getDependencies();
    const job = await deps.jobs.getById(ORG_ACME_ID, JOB_COMPLETED_ID);
    expect(job).not.toBeNull();
    if (!job || !job.completedAt)
      throw new Error("fixture job must be completed");

    await deps.accountingExports.createPending({
      expectedVersion: job.version,
      export: {
        orgId: ORG_ACME_ID,
        jobId: job.id,
        idempotencyKey: `test-pending:${job.id}`,
        request: {
          idempotencyKey: `test-pending:${job.id}`,
          orgId: ORG_ACME_ID,
          customer: { id: CUSTOMER_B_ID, name: "Example Customer B" },
          job: { id: job.id, title: job.title, completedAt: job.completedAt },
        },
        status: "pending",
        externalReference: null,
        operationId: null,
        requestedBy: ADMIN_EMAIL,
        requestedAt: "2026-09-06T12:00:00.000Z",
        completedAt: null,
      },
    });

    await expect(
      undoOperation(deps, memberOne, {
        operationId: "op_complete_job_completed",
      }),
    ).rejects.toMatchObject({
      code: "INVARIANT",
      message: "A job with an accounting export cannot be reopened",
    });
    await expect(deps.jobs.getById(ORG_ACME_ID, job.id)).resolves.toMatchObject(
      {
        status: "completed",
        version: job.version,
      },
    );

    const completedOperation = await deps.operations.getById(
      ORG_ACME_ID,
      "op_complete_job_completed",
    );
    expect(completedOperation?.inverse?.type).toBe("restore-job-status");
    if (completedOperation?.inverse?.type !== "restore-job-status") {
      throw new Error("fixture completion must carry a status inverse");
    }
    const restored = restoreJobStatus(
      job,
      completedOperation.inverse.previous,
      "2026-09-06T12:01:00.000Z",
    );
    const guardedUndo: Operation = {
      id: "op_pending_export_guard",
      orgId: ORG_ACME_ID,
      kind: "undo",
      action: "undo-operation",
      resourceType: "job",
      resourceId: job.id,
      classification: "reversible",
      versionBefore: job.version,
      versionAfter: restored.version,
      payload: {},
      inverse: null,
      relatedOperationId: completedOperation.id,
      undoneByOperationId: null,
      performedBy: MEMBER1_EMAIL,
      performedVia: "test",
      performedAt: "2026-09-06T12:01:00.000Z",
    };
    await expect(
      deps.jobs.commit({
        job: restored,
        expectedVersion: job.version,
        operation: guardedUndo,
        markUndone: completedOperation.id,
        requireNoAccountingExport: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(deps.jobs.getById(ORG_ACME_ID, job.id)).resolves.toEqual(job);
    await expect(
      deps.operations.getById(ORG_ACME_ID, guardedUndo.id),
    ).resolves.toBeNull();
    await expect(
      deps.operations.getById(ORG_ACME_ID, completedOperation.id),
    ).resolves.toMatchObject({ undoneByOperationId: null });

    const accepted = await deps.accountingExports.recordAccepted({
      orgId: ORG_ACME_ID,
      jobId: job.id,
      externalReference: "ACC-correct",
    });
    const reconciled = reconcileAccountingExport(
      job,
      "ACC-wrong",
      "2026-09-06T12:02:00.000Z",
    );
    const mismatchedOperation: Operation = {
      ...guardedUndo,
      id: "op_accounting_reference_mismatch",
      kind: "forward",
      action: "send-job-to-accounting",
      classification: "irreversible",
      versionBefore: job.version,
      versionAfter: reconciled.version,
      payload: { externalReference: "ACC-wrong" },
      relatedOperationId: null,
      performedBy: ADMIN_EMAIL,
      performedAt: "2026-09-06T12:02:00.000Z",
    };
    await expect(
      deps.accountingExports.complete({
        export: { ...accepted, externalReference: "ACC-wrong" },
        job: reconciled,
        expectedVersion: job.version,
        operation: mismatchedOperation,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(deps.jobs.getById(ORG_ACME_ID, job.id)).resolves.toEqual(job);
    await expect(
      deps.operations.getById(ORG_ACME_ID, mismatchedOperation.id),
    ).resolves.toBeNull();
    await expect(
      deps.accountingExports.getByJobId(ORG_ACME_ID, job.id),
    ).resolves.toMatchObject({
      status: "pending",
      externalReference: "ACC-correct",
      operationId: null,
    });
  });
});
