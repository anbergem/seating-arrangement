import { describe, expect, it } from "vitest";

import type { Actor } from "../../../src/application/actor";
import { AppError } from "../../../src/application/errors";
import { sendJobToAccounting } from "../../../src/application/use-cases/send-job-to-accounting";
import { archiveJob } from "../../../src/domain";
import {
  createMockAccountingSystem,
  type MockAccountingSystem,
} from "../../../src/infrastructure/mock/mock-accounting";
import {
  createInMemoryDependencies,
  type InMemoryDependencies,
} from "../../fixtures/in-memory";
import {
  ADMIN_EMAIL,
  JOB_COMPLETED_ID,
  JOB_OTHER_ID,
  JOB_SCHEDULED_ID,
  MEMBER1_EMAIL,
  ORG_ACME_ID,
  ORG_OTHER_ID,
  OUTSIDER_EMAIL,
  seedInMemory,
} from "../../fixtures/scenario";

const admin: Actor = {
  userEmail: ADMIN_EMAIL,
  orgId: ORG_ACME_ID,
  role: "admin",
  caller: "test",
};
const member: Actor = {
  userEmail: MEMBER1_EMAIL,
  orgId: ORG_ACME_ID,
  role: "member",
  caller: "test",
};
const outsider: Actor = {
  userEmail: OUTSIDER_EMAIL,
  orgId: ORG_OTHER_ID,
  role: "owner",
  caller: "test",
};

function setup(accounting = createMockAccountingSystem()): {
  deps: InMemoryDependencies;
  accounting: MockAccountingSystem;
} {
  const deps = createInMemoryDependencies({
    ids: ["op-export-1", "op-export-2", "op-export-3"],
    accounting,
  });
  seedInMemory(deps);
  return { deps, accounting };
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected AppError");
}

describe("sendJobToAccounting", () => {
  it("persists the intent, sends once, and atomically completes the job and audit", async () => {
    const { deps, accounting } = setup();
    const before = deps.state.jobs.get(JOB_COMPLETED_ID)!;
    const result = await sendJobToAccounting(deps, admin, {
      jobId: JOB_COMPLETED_ID,
      expectedVersion: before.version,
    });

    expect(result.externalReference).toBe("ACC-job_completed");
    expect(result.resource.version).toBe(before.version + 1);
    expect(result.resource.accountingReference).toBe("ACC-job_completed");
    expect(accounting.acceptedCount()).toBe(1);
    const request = deps.state.accountingExports.get(
      `${ORG_ACME_ID} ${JOB_COMPLETED_ID}`,
    );
    expect(request).toMatchObject({
      status: "completed",
      operationId: result.operationId,
      externalReference: "ACC-job_completed",
      idempotencyKey: "job:job_completed",
    });
    expect(request?.request.job.title).toBe("Completed job");
    expect(deps.state.operations.get(result.operationId)).toMatchObject({
      classification: "irreversible",
      inverse: null,
      payload: {
        externalReference: "ACC-job_completed",
        idempotencyKey: "job:job_completed",
      },
    });

    const replay = await sendJobToAccounting(deps, admin, {
      jobId: JOB_COMPLETED_ID,
    });
    expect(replay.operationId).toBe(result.operationId);
    expect(accounting.callCount()).toBe(1);
  });

  it("enforces role, eligibility, and organization scope", async () => {
    const { deps } = setup();
    expect(
      (
        await errorOf(
          sendJobToAccounting(deps, member, { jobId: JOB_COMPLETED_ID }),
        )
      ).code,
    ).toBe("AUTHORIZATION");
    expect(
      (
        await errorOf(
          sendJobToAccounting(deps, admin, { jobId: JOB_SCHEDULED_ID }),
        )
      ).code,
    ).toBe("INVARIANT");
    expect(
      (await errorOf(sendJobToAccounting(deps, admin, { jobId: JOB_OTHER_ID })))
        .code,
    ).toBe("NOT_FOUND");
    expect(
      (
        await errorOf(
          sendJobToAccounting(deps, outsider, { jobId: JOB_COMPLETED_ID }),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });

  it("keeps a durable pending request when the vendor fails before acceptance", async () => {
    const { deps, accounting } = setup();
    accounting.failNextCall("temporary outage");
    const error = await errorOf(
      sendJobToAccounting(deps, admin, { jobId: JOB_COMPLETED_ID }),
    );
    expect(error.code).toBe("EXTERNAL");
    expect(
      deps.state.accountingExports.get(`${ORG_ACME_ID} ${JOB_COMPLETED_ID}`)
        ?.status,
    ).toBe("pending");
    expect(
      deps.state.jobs.get(JOB_COMPLETED_ID)?.accountingReference,
    ).toBeNull();
  });

  it("reconciles response loss after vendor acceptance", async () => {
    const { deps, accounting } = setup();
    accounting.failNextCall("response lost", "after-acceptance");
    expect(
      (
        await errorOf(
          sendJobToAccounting(deps, admin, { jobId: JOB_COMPLETED_ID }),
        )
      ).code,
    ).toBe("EXTERNAL");
    expect(accounting.acceptedCount()).toBe(1);
    const result = await sendJobToAccounting(deps, admin, {
      jobId: JOB_COMPLETED_ID,
    });
    expect(result.externalReference).toBe("ACC-job_completed");
    expect(accounting.acceptedCount()).toBe(1);
    expect(accounting.callCount()).toBe(2);
  });

  it("shares one immutable request and completed operation across concurrent calls", async () => {
    const { deps, accounting } = setup();
    const [first, second] = await Promise.all([
      sendJobToAccounting(deps, admin, { jobId: JOB_COMPLETED_ID }),
      sendJobToAccounting(deps, admin, { jobId: JOB_COMPLETED_ID }),
    ]);
    expect(second.operationId).toBe(first.operationId);
    expect(second.externalReference).toBe(first.externalReference);
    expect(accounting.acceptedCount()).toBe(1);
    expect(
      [...deps.state.operations.values()].filter(
        (op) => op.action === "send-job-to-accounting",
      ),
    ).toHaveLength(1);
  });

  it("recreates dependencies around persisted intent and the same vendor", async () => {
    const { deps, accounting } = setup();
    accounting.failNextCall("response lost", "after-acceptance");
    await errorOf(
      sendJobToAccounting(deps, admin, { jobId: JOB_COMPLETED_ID }),
    );
    const restarted = createInMemoryDependencies({
      state: deps.state,
      accounting,
      ids: ["op-after-restart"],
    });
    const result = await sendJobToAccounting(restarted, admin, {
      jobId: JOB_COMPLETED_ID,
    });
    expect(result.operationId).toBe("op-after-restart");
    expect(accounting.acceptedCount()).toBe(1);
  });

  it("leaves vendor identity pending on a local conflict, then preserves an intervening archive", async () => {
    const { deps, accounting } = setup();
    deps.state.beforeJobCommit = () => {
      const current = deps.state.jobs.get(JOB_COMPLETED_ID)!;
      deps.state.jobs.set(
        JOB_COMPLETED_ID,
        archiveJob(current, "2026-09-06T12:01:00.000Z"),
      );
    };
    expect(
      (
        await errorOf(
          sendJobToAccounting(deps, admin, { jobId: JOB_COMPLETED_ID }),
        )
      ).code,
    ).toBe("CONFLICT");
    const pending = deps.state.accountingExports.get(
      `${ORG_ACME_ID} ${JOB_COMPLETED_ID}`,
    )!;
    expect(pending.externalReference).toBe("ACC-job_completed");
    expect(pending.status).toBe("pending");

    const result = await sendJobToAccounting(deps, admin, {
      jobId: JOB_COMPLETED_ID,
    });
    expect(result.resource.status).toBe("archived");
    expect(result.resource.archivedAt).toBe("2026-09-06T12:01:00.000Z");
    expect(result.resource.accountingReference).toBe("ACC-job_completed");
    expect(accounting.callCount()).toBe(2);
  });

  it("does not mutate the job or audit log when the completion guard refuses", async () => {
    const { deps } = setup();
    const original = deps.state.jobs.get(JOB_COMPLETED_ID)!;
    deps.state.beforeJobCommit = () => {
      const pending = deps.state.accountingExports.get(
        `${ORG_ACME_ID} ${JOB_COMPLETED_ID}`,
      )!;
      deps.state.accountingExports.set(`${ORG_ACME_ID} ${JOB_COMPLETED_ID}`, {
        ...pending,
        externalReference: "ACC-different",
      });
    };
    expect(
      (
        await errorOf(
          sendJobToAccounting(deps, admin, { jobId: JOB_COMPLETED_ID }),
        )
      ).code,
    ).toBe("CONFLICT");
    expect(deps.state.jobs.get(JOB_COMPLETED_ID)).toEqual(original);
    expect(
      [...deps.state.operations.values()].some(
        (op) => op.action === "send-job-to-accounting",
      ),
    ).toBe(false);
  });
});
