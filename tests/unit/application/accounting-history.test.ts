import { describe, expect, it } from "vitest";

import type { Actor } from "../../../src/application/actor";
import { archiveJob } from "../../../src/application/use-cases/archive-job";
import { completeJob } from "../../../src/application/use-cases/complete-job";
import { listRecentActivity } from "../../../src/application/use-cases/list-recent-activity";
import { sendJobToAccounting } from "../../../src/application/use-cases/send-job-to-accounting";
import { undoOperation } from "../../../src/application/use-cases/undo-operation";
import { createMockAccountingSystem } from "../../../src/infrastructure/mock/mock-accounting";
import { createInMemoryDependencies } from "../../fixtures/in-memory";
import {
  seedInMemory,
  JOB_SCHEDULED_ID,
  ORG_ACME_ID,
  OWNER_EMAIL,
} from "../../fixtures/scenario";

const actor: Actor = {
  userEmail: OWNER_EMAIL,
  orgId: ORG_ACME_ID,
  role: "owner",
  caller: "test",
};
function setup() {
  const accounting = createMockAccountingSystem();
  const deps = createInMemoryDependencies({ accounting });
  seedInMemory(deps);
  return { deps, accounting };
}

describe("history and durable accounting intent", () => {
  it("refuses reopening after response loss and hides Undo, while allowing archive reconciliation", async () => {
    const { deps, accounting } = setup();
    const completed = await completeJob(deps, actor, {
      jobId: JOB_SCHEDULED_ID,
    });
    accounting.failNextCall("response lost", "after-acceptance");
    await expect(
      sendJobToAccounting(deps, actor, { jobId: JOB_SCHEDULED_ID }),
    ).rejects.toMatchObject({ code: "EXTERNAL" });
    await expect(
      undoOperation(deps, actor, { operationId: completed.operationId }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const feed = await listRecentActivity(deps, actor, {
      resourceType: "job",
      resourceId: JOB_SCHEDULED_ID,
    });
    expect(feed.find((op) => op.id === completed.operationId)?.undoable).toBe(
      false,
    );
    const archived = await archiveJob(deps, actor, { jobId: JOB_SCHEDULED_ID });
    const restored = await undoOperation(deps, actor, {
      operationId: archived.operationId,
    });
    expect(restored.resource.status).toBe("completed");
    const exported = await sendJobToAccounting(deps, actor, {
      jobId: JOB_SCHEDULED_ID,
    });
    expect(exported.resource.accountingReference).toBe(
      `ACC-${JOB_SCHEDULED_ID}`,
    );
    expect(accounting.acceptedCount()).toBe(1);
  });

  it("rejects a history commit when an export intent appears after its initial read", async () => {
    const { deps, accounting } = setup();
    const completed = await completeJob(deps, actor, {
      jobId: JOB_SCHEDULED_ID,
    });
    deps.state.beforeJobCommit = async () => {
      accounting.failNextCall("response lost", "after-acceptance");
      await expect(
        sendJobToAccounting(deps, actor, { jobId: JOB_SCHEDULED_ID }),
      ).rejects.toMatchObject({ code: "EXTERNAL" });
    };
    await expect(
      undoOperation(deps, actor, { operationId: completed.operationId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await deps.jobs.getById(actor.orgId, JOB_SCHEDULED_ID))?.status,
    ).toBe("completed");
    expect(
      (await deps.operations.getById(actor.orgId, completed.operationId))
        ?.undoneByOperationId,
    ).toBeNull();
    expect(accounting.acceptedCount()).toBe(1);
  });
});
