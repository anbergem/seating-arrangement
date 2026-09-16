/**
 * The repositories against a real database (blueprint B18).
 *
 * The unit suite proves the use cases against `tests/fixtures/in-memory.ts`;
 * this proves that the SQL behind the same ports behaves the same way. Only
 * the promises a use case actually relies on are tested here — organization
 * isolation, the version guard, the active-customer guard, idempotency and the
 * role lookup — because everything else is already covered one layer up.
 *
 * It runs against the framework's own executor (`getDbExec()`), not a driver
 * this test constructs, so the atomic-write path exercised here is the one
 * production uses. `global-setup.ts` points that executor at a freshly
 * migrated `data/test-integration.db`.
 */

import { getDbExec } from "@agent-native/core/db";
import { beforeAll, describe, expect, it } from "vitest";

import { AppError } from "../../src/application/errors";
import {
  archiveCustomer,
  createCustomer,
  createJob,
  completeJob,
  OPERATION_CLASSIFICATION,
  type Customer,
  type Job,
  type Operation,
  type ResourceType,
} from "../../src/domain";
import { getDependencies } from "../../src/infrastructure/container";
import { createCustomersRepository } from "../../src/infrastructure/d1/customers-repository";
import { createIdempotencyStore } from "../../src/infrastructure/d1/idempotency-store";
import { createJobsRepository } from "../../src/infrastructure/d1/jobs-repository";
import { createMembershipReader } from "../../src/infrastructure/d1/membership-reader";
import { createOperationsRepository } from "../../src/infrastructure/d1/operations-repository";
import {
  MEMBER1_EMAIL,
  ORG_ACME_ID,
  ORG_OTHER_ID,
  OUTSIDER_EMAIL,
  OWNER_EMAIL,
} from "../fixtures/scenario";
import { FRAMEWORK_TABLE_DDL } from "./framework-tables";

// `getDbExec` is passed as a function, exactly as `container.ts` passes it, so
// the executor is resolved per call rather than captured here.
const customers = createCustomersRepository(getDbExec);
const jobs = createJobsRepository(getDbExec);
const operations = createOperationsRepository(getDbExec);
const idempotency = createIdempotencyStore(getDbExec);
const membership = createMembershipReader(getDbExec);

// Fixed values, never generated: a failing assertion points at the same row
// every run (AGENTS.md).
const CREATED_AT = "2026-09-01T09:00:00.000Z";
const LATER = "2026-09-02T09:00:00.000Z";
const SCHEDULED_AT = "2026-10-01T08:00:00.000Z";

/** The audit row that accompanies a write. Written out rather than produced by
 * a helper in `src/`, because the use cases that will build these for real do
 * not exist until T09 and this test must not depend on them. */
function operationFor(input: {
  id: string;
  orgId: string;
  action: string;
  resourceType: ResourceType;
  resourceId: string;
  versionBefore: number;
  versionAfter: number;
  performedBy: string;
  performedAt: string;
}): Operation {
  return {
    id: input.id,
    orgId: input.orgId,
    kind: "forward",
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    classification: OPERATION_CLASSIFICATION[input.action] ?? "reversible",
    versionBefore: input.versionBefore,
    versionAfter: input.versionAfter,
    payload: { source: "integration-test" },
    inverse: null,
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: input.performedBy,
    performedVia: "test",
    performedAt: input.performedAt,
  };
}

const acmeCustomer: Customer = createCustomer({
  id: "cus_acme",
  orgId: ORG_ACME_ID,
  name: "Example Customer A",
  createdBy: OWNER_EMAIL,
  now: CREATED_AT,
});

const acmeArchivedCustomer: Customer = archiveCustomer(
  createCustomer({
    id: "cus_acme_archived",
    orgId: ORG_ACME_ID,
    name: "Archived Customer",
    createdBy: OWNER_EMAIL,
    now: CREATED_AT,
  }),
  CREATED_AT,
);

const otherCustomer: Customer = createCustomer({
  // Keep repository-isolation rows separate from the SQL scenario loaded for
  // the CLI phase; the scenario intentionally owns `cus_other`.
  id: "repo_cus_other",
  orgId: ORG_OTHER_ID,
  name: "Other Company Customer",
  createdBy: OUTSIDER_EMAIL,
  now: CREATED_AT,
});

const acmeJob: Job = createJob({
  id: "job_acme",
  orgId: ORG_ACME_ID,
  customerId: acmeCustomer.id,
  title: "Scheduled job",
  scheduledAt: SCHEDULED_AT,
  createdBy: OWNER_EMAIL,
  now: CREATED_AT,
});

beforeAll(async () => {
  for (const customer of [acmeCustomer, acmeArchivedCustomer, otherCustomer]) {
    await customers.create({
      customer,
      operation: operationFor({
        id: `op_create_${customer.id}`,
        orgId: customer.orgId,
        action: "create-customer",
        resourceType: "customer",
        resourceId: customer.id,
        versionBefore: 0,
        versionAfter: customer.version,
        performedBy: customer.createdBy,
        performedAt: CREATED_AT,
      }),
    });
  }

  await jobs.create({
    job: acmeJob,
    operation: operationFor({
      id: `op_create_${acmeJob.id}`,
      orgId: acmeJob.orgId,
      action: "create-job",
      resourceType: "job",
      resourceId: acmeJob.id,
      versionBefore: 0,
      versionAfter: acmeJob.version,
      performedBy: acmeJob.createdBy,
      performedAt: CREATED_AT,
    }),
    idempotency: { action: "create-job", key: "idem-job-acme" },
  });
});

describe("organization scoping", () => {
  it("reads a row only through its own organization", async () => {
    await expect(
      customers.getById(ORG_ACME_ID, acmeCustomer.id),
    ).resolves.toMatchObject({
      id: acmeCustomer.id,
      name: "Example Customer A",
    });

    // The other organization's row exists, but not for this caller: a reader
    // must not be able to tell "absent" from "someone else's".
    await expect(
      customers.getById(ORG_ACME_ID, otherCustomer.id),
    ).resolves.toBeNull();
    await expect(
      customers.getById(ORG_OTHER_ID, acmeCustomer.id),
    ).resolves.toBeNull();
    await expect(jobs.getById(ORG_OTHER_ID, acmeJob.id)).resolves.toBeNull();
  });

  it("lists only the caller's organization, filtered", async () => {
    const acme = await customers.list(ORG_ACME_ID, {});
    expect(acme.map((customer) => customer.id)).toEqual(
      expect.arrayContaining([acmeArchivedCustomer.id, acmeCustomer.id]),
    );

    const active = await customers.list(ORG_ACME_ID, { status: "active" });
    expect(active.map((customer) => customer.id)).toContain(acmeCustomer.id);

    const searched = await customers.list(ORG_ACME_ID, {
      search: "customer a",
    });
    expect(searched.map((customer) => customer.id)).toContain(acmeCustomer.id);

    const acmeJobs = await jobs.list(ORG_ACME_ID, { status: "scheduled" });
    expect(acmeJobs.map((job) => job.id)).toContain(acmeJob.id);
    expect((await jobs.list(ORG_OTHER_ID, {})).map((job) => job.orgId)).toEqual(
      expect.arrayContaining([ORG_OTHER_ID]),
    );
  });

  it("round-trips a job through the mappers", async () => {
    const stored = await jobs.getById(ORG_ACME_ID, acmeJob.id);
    expect(stored).toEqual(acmeJob);
  });

  it("reads the audit row written with the resource", async () => {
    const history = await operations.listForResource(
      ORG_ACME_ID,
      "job",
      acmeJob.id,
      10,
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: "create-job",
      kind: "forward",
      classification: "compensatable",
      payload: { source: "integration-test" },
      inverse: null,
    });

    const recent = await operations.listRecent(ORG_ACME_ID, 10);
    expect(recent.map((operation) => operation.resourceId)).toContain(
      acmeJob.id,
    );
    expect(
      (await operations.listRecent(ORG_OTHER_ID, 10)).map(
        (operation) => operation.resourceId,
      ),
    ).toContain(otherCustomer.id);
    await expect(
      operations.getById(ORG_OTHER_ID, `op_create_${acmeJob.id}`),
    ).resolves.toBeNull();
  });
});

describe("commit", () => {
  it("applies a change and its audit row as one unit", async () => {
    const completed = completeJob(acmeJob, LATER);
    await jobs.commit({
      job: completed,
      expectedVersion: acmeJob.version,
      operation: operationFor({
        id: "op_complete_job_acme",
        orgId: ORG_ACME_ID,
        action: "complete-job",
        resourceType: "job",
        resourceId: acmeJob.id,
        versionBefore: acmeJob.version,
        versionAfter: completed.version,
        performedBy: MEMBER1_EMAIL,
        performedAt: LATER,
      }),
    });

    await expect(jobs.getById(ORG_ACME_ID, acmeJob.id)).resolves.toMatchObject({
      status: "completed",
      version: completed.version,
      completedAt: LATER,
    });
    await expect(
      operations.listForResource(ORG_ACME_ID, "job", acmeJob.id, 10),
    ).resolves.toHaveLength(2);
  });

  it("refuses a stale version and writes nothing at all", async () => {
    const current = await jobs.getById(ORG_ACME_ID, acmeJob.id);
    expect(current).not.toBeNull();

    // `acmeJob` is the version before the commit above: exactly what a second
    // caller would hold after reading the job and losing the race.
    const stale = completeJob(acmeJob, LATER);
    const attempt = jobs.commit({
      job: stale,
      expectedVersion: acmeJob.version,
      operation: operationFor({
        id: "op_stale_job_acme",
        orgId: ORG_ACME_ID,
        action: "complete-job",
        resourceType: "job",
        resourceId: acmeJob.id,
        versionBefore: acmeJob.version,
        versionAfter: stale.version,
        performedBy: MEMBER1_EMAIL,
        performedAt: LATER,
      }),
      markUndone: `op_create_${acmeJob.id}`,
    });

    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The record was changed by someone else",
    });

    // The guard on the operation insert is what makes the whole batch a no-op:
    // the audit row for the refused write must not exist.
    await expect(
      operations.getById(ORG_ACME_ID, "op_stale_job_acme"),
    ).resolves.toBeNull();
    await expect(jobs.getById(ORG_ACME_ID, acmeJob.id)).resolves.toEqual(
      current,
    );
    // Nor may the batch mark an earlier operation undone by an audit row it
    // never wrote.
    await expect(
      operations.getById(ORG_ACME_ID, `op_create_${acmeJob.id}`),
    ).resolves.toMatchObject({ undoneByOperationId: null });
  });

  it("refuses a commit aimed at another organization's row", async () => {
    const attempt = customers.commit({
      customer: { ...acmeCustomer, orgId: ORG_OTHER_ID, version: 2 },
      expectedVersion: acmeCustomer.version,
      operation: operationFor({
        id: "op_cross_org_customer",
        orgId: ORG_OTHER_ID,
        action: "archive-customer",
        resourceType: "customer",
        resourceId: acmeCustomer.id,
        versionBefore: 1,
        versionAfter: 2,
        performedBy: OUTSIDER_EMAIL,
        performedAt: LATER,
      }),
    });

    await expect(attempt).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      customers.getById(ORG_ACME_ID, acmeCustomer.id),
    ).resolves.toEqual(acmeCustomer);
  });

  it("marks the operation it reverses in the same batch", async () => {
    const archived = archiveCustomer(acmeCustomer, LATER);
    await customers.commit({
      customer: archived,
      expectedVersion: acmeCustomer.version,
      operation: operationFor({
        id: "op_archive_cus_acme",
        orgId: ORG_ACME_ID,
        action: "archive-customer",
        resourceType: "customer",
        resourceId: acmeCustomer.id,
        versionBefore: acmeCustomer.version,
        versionAfter: archived.version,
        performedBy: OWNER_EMAIL,
        performedAt: LATER,
      }),
      markUndone: `op_create_${acmeCustomer.id}`,
    });

    await expect(
      customers.getById(ORG_ACME_ID, acmeCustomer.id),
    ).resolves.toMatchObject({ status: "archived", version: archived.version });
    await expect(
      operations.getById(ORG_ACME_ID, `op_create_${acmeCustomer.id}`),
    ).resolves.toMatchObject({
      undoneByOperationId: "op_archive_cus_acme",
    });
  });
});

describe("create", () => {
  it("refuses a job for an archived customer and leaves no rows", async () => {
    const job = createJob({
      id: "job_for_archived",
      orgId: ORG_ACME_ID,
      customerId: acmeArchivedCustomer.id,
      title: "Job for an archived customer",
      scheduledAt: SCHEDULED_AT,
      createdBy: OWNER_EMAIL,
      now: LATER,
    });

    const attempt = jobs.create({
      job,
      operation: operationFor({
        id: "op_create_job_for_archived",
        orgId: ORG_ACME_ID,
        action: "create-job",
        resourceType: "job",
        resourceId: job.id,
        versionBefore: 0,
        versionAfter: 1,
        performedBy: OWNER_EMAIL,
        performedAt: LATER,
      }),
      idempotency: { action: "create-job", key: "idem-job-for-archived" },
    });

    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Customer not found or archived",
    });

    await expect(jobs.getById(ORG_ACME_ID, job.id)).resolves.toBeNull();
    await expect(
      operations.getById(ORG_ACME_ID, "op_create_job_for_archived"),
    ).resolves.toBeNull();
    // The key must not survive a create that did not happen, or the caller's
    // retry would be answered with an id that names nothing.
    await expect(
      idempotency.find(ORG_ACME_ID, "create-job", "idem-job-for-archived"),
    ).resolves.toBeNull();
  });

  it("refuses a job for a customer in another organization", async () => {
    const job = createJob({
      id: "job_cross_org",
      orgId: ORG_ACME_ID,
      customerId: otherCustomer.id,
      title: "Job for another organization's customer",
      scheduledAt: SCHEDULED_AT,
      createdBy: OWNER_EMAIL,
      now: LATER,
    });

    await expect(
      jobs.create({
        job,
        operation: operationFor({
          id: "op_create_job_cross_org",
          orgId: ORG_ACME_ID,
          action: "create-job",
          resourceType: "job",
          resourceId: job.id,
          versionBefore: 0,
          versionAfter: 1,
          performedBy: OWNER_EMAIL,
          performedAt: LATER,
        }),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("findCreateOperation", () => {
  it("finds the create operation of a resource that has moved on since", async () => {
    // By now `job_acme` also carries `op_complete_job_acme`, so the create is
    // not the newest row for its resource — which is the whole reason this
    // statement exists rather than a page of `listForResource` (B7).
    const history = await operations.listForResource(
      ORG_ACME_ID,
      "job",
      acmeJob.id,
      10,
    );
    expect(history.length).toBeGreaterThan(1);
    expect(history[0]?.id).not.toBe(`op_create_${acmeJob.id}`);

    await expect(
      operations.findCreateOperation(ORG_ACME_ID, "job", acmeJob.id),
    ).resolves.toMatchObject({
      id: `op_create_${acmeJob.id}`,
      kind: "forward",
      versionBefore: 0,
    });
    await expect(
      operations.findCreateOperation(ORG_ACME_ID, "customer", acmeCustomer.id),
    ).resolves.toMatchObject({ id: `op_create_${acmeCustomer.id}` });
  });

  it("is null for another organization, another type, and an unknown id", async () => {
    await expect(
      operations.findCreateOperation(ORG_OTHER_ID, "job", acmeJob.id),
    ).resolves.toBeNull();
    await expect(
      operations.findCreateOperation(ORG_ACME_ID, "customer", acmeJob.id),
    ).resolves.toBeNull();
    await expect(
      operations.findCreateOperation(ORG_ACME_ID, "job", "job_missing"),
    ).resolves.toBeNull();
  });
});

describe("idempotency keys", () => {
  it("finds the resource a key already created, in that organization only", async () => {
    await expect(
      idempotency.find(ORG_ACME_ID, "create-job", "idem-job-acme"),
    ).resolves.toBe(acmeJob.id);

    await expect(
      idempotency.find(ORG_OTHER_ID, "create-job", "idem-job-acme"),
    ).resolves.toBeNull();
    await expect(
      idempotency.find(ORG_ACME_ID, "create-customer", "idem-job-acme"),
    ).resolves.toBeNull();
    await expect(
      idempotency.find(ORG_ACME_ID, "create-job", "never-used"),
    ).resolves.toBeNull();
  });
});

describe("membership reader", () => {
  beforeAll(async () => {
    const exec = getDbExec();
    for (const sql of FRAMEWORK_TABLE_DDL) await exec.execute(sql);
  });

  it("resolves a seeded role", async () => {
    await expect(membership.getRole(ORG_ACME_ID, MEMBER1_EMAIL)).resolves.toBe(
      "member",
    );
    await expect(membership.isMember(ORG_ACME_ID, MEMBER1_EMAIL)).resolves.toBe(
      true,
    );
  });

  it("reports no membership in another organization", async () => {
    await expect(
      membership.getRole(ORG_OTHER_ID, MEMBER1_EMAIL),
    ).resolves.toBeNull();
    await expect(
      membership.isMember(ORG_ACME_ID, OUTSIDER_EMAIL),
    ).resolves.toBe(false);
  });
});

describe("container", () => {
  it("wires the same adapters T08 will call through `runAppAction`", async () => {
    const dependencies = getDependencies();
    // Memoised: the repositories are built once, and only the executor inside
    // their methods is per-request.
    expect(getDependencies()).toBe(dependencies);

    await expect(
      dependencies.customers.getById(ORG_ACME_ID, acmeCustomer.id),
    ).resolves.toMatchObject({ id: acmeCustomer.id });
    await expect(
      dependencies.membership.getRole(ORG_ACME_ID, MEMBER1_EMAIL),
    ).resolves.toBe("member");
    expect(dependencies.clock.now()).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(dependencies.ids.next()).not.toBe(dependencies.ids.next());
  });
});
