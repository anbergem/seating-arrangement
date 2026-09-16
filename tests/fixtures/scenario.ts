/**
 * Deterministic seed scenario (blueprint B12).
 *
 * Every id, email, name and timestamp here is a fixed constant: AGENTS.md
 * forbids random test data, so a failing assertion always points at the same
 * fixture, run after run. `buildScenario()` is the single composition every
 * consumer goes through: `seedInMemory` loads it into an in-memory
 * `Dependencies`, and `buildScenarioSql()` renders the same objects as
 * `INSERT OR IGNORE` statements for the Node SQLite file and for D1. The two
 * can therefore not drift. `scripts/seed.mjs` creates the user accounts over
 * HTTP (never SQL); this file never touches `user`-shaped tables.
 *
 * The customer/job/operation objects are produced by calling the real
 * domain functions (`createCustomer`, `createJob`, `startJob`, …) with fixed
 * `now` values instead of being hand-typed, so a version, an `updatedAt`, or
 * an inverse command can never drift from what the domain layer would
 * actually produce for the same sequence of calls.
 *
 * `createCompanyWithMembers`, `createScheduledJob`, `createCompletedJob` and
 * `createForeignOrganizationJob` are the named scenario builders blueprint
 * B12 calls for; `createCustomers`, `createForeignOrganization`,
 * `createInProgressJob` and `createArchivedJob` are the pieces those four
 * compose from, built the same way for the same reason. `buildScenario`
 * composes all of them into the full scenario.
 */

import type { Role } from "../../src/application/authorization";
import {
  archiveJob,
  completeJob,
  createCustomer,
  createJob,
  startJob,
  OPERATION_CLASSIFICATION,
  type Customer,
  type InverseCommand,
  type Job,
  type Operation,
  type OperationClassification,
  type ResourceType,
} from "../../src/domain";
import type { InMemoryDependencies } from "./in-memory";

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export const ORG_ACME_ID = "org_acme";
export const ORG_ACME_NAME = "Acme Services";
export const ORG_OTHER_ID = "org_other";
export const ORG_OTHER_NAME = "Other Company";

/**
 * A row of the framework-owned `organizations` table (F6).
 *
 * Only the columns the framework declares NOT NULL are modelled — see the
 * column inventory above `buildScenarioSql` — because the seed writes exactly
 * those and leaves every nullable column to the framework.
 */
export interface SeedOrganization {
  id: string;
  name: string;
  createdBy: string;
  /** Epoch milliseconds, not an ISO string: `organizations.created_at` is an
   * INTEGER column (F6). */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Users. Accounts are created over HTTP by `scripts/seed.mjs` (never SQL);
// this is only the membership/role wiring the in-memory `MembershipReader`
// needs.
// ---------------------------------------------------------------------------

export const OWNER_EMAIL = "owner@example.invalid";
export const ADMIN_EMAIL = "admin@example.invalid";
export const MEMBER1_EMAIL = "member1@example.invalid";
export const MEMBER2_EMAIL = "member2@example.invalid";
export const OUTSIDER_EMAIL = "outsider@example.invalid";

export const DEFAULT_SEED_PASSWORD = "Example-Seed-Password-2026";

export interface SeedMembership {
  /** `org_members.id`. A fixed value, like every other id here: the row is
   * written with `INSERT OR IGNORE`, so a re-seed has to collide with the
   * previous run's row rather than add a second membership. */
  id: string;
  orgId: string;
  email: string;
  role: Role;
}

export const SEED_MEMBERSHIPS: readonly SeedMembership[] = [
  {
    id: "mem_acme_owner",
    orgId: ORG_ACME_ID,
    email: OWNER_EMAIL,
    role: "owner",
  },
  {
    id: "mem_acme_admin",
    orgId: ORG_ACME_ID,
    email: ADMIN_EMAIL,
    role: "admin",
  },
  {
    id: "mem_acme_member1",
    orgId: ORG_ACME_ID,
    email: MEMBER1_EMAIL,
    role: "member",
  },
  {
    id: "mem_acme_member2",
    orgId: ORG_ACME_ID,
    email: MEMBER2_EMAIL,
    role: "member",
  },
  {
    id: "mem_other_outsider",
    orgId: ORG_OTHER_ID,
    email: OUTSIDER_EMAIL,
    role: "owner",
  },
];

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const CUSTOMER_A_ID = "cus_a";
export const CUSTOMER_A_NAME = "Example Customer A";
export const CUSTOMER_B_ID = "cus_b";
export const CUSTOMER_B_NAME = "Example Customer B";
export const CUSTOMER_ARCHIVED_ID = "cus_archived";
export const CUSTOMER_ARCHIVED_NAME = "Archived Customer";
export const CUSTOMER_OTHER_ID = "cus_other";
export const CUSTOMER_OTHER_NAME = "Other Company Customer";

// ---------------------------------------------------------------------------
// Jobs. Only `job_scheduled`'s instant is given by B12 directly; the other
// jobs' `scheduledAt` values are fixed, deterministic choices consistent
// with their status (a completed or archived job is scheduled in the past
// relative to `FIXTURE_CLOCK`).
// ---------------------------------------------------------------------------

/**
 * The instant every other date in this scenario is chosen relative to. Exported
 * because a caller that tells an agent what "today" is has to agree with the
 * rows: `scripts/eval-suite.ts` pins the evals' runtime context to it so a
 * date-relative question resolves the same way on every run.
 */
export const FIXTURE_CLOCK = "2026-09-06T12:00:00.000Z";

export const JOB_SCHEDULED_ID = "job_scheduled";
export const JOB_SCHEDULED_TITLE = "Scheduled job";
export const JOB_SCHEDULED_AT = "2026-10-01T08:00:00.000Z";

export const JOB_IN_PROGRESS_ID = "job_in_progress";
export const JOB_IN_PROGRESS_TITLE = "In-progress job";
export const JOB_IN_PROGRESS_SCHEDULED_AT = "2026-09-10T09:00:00.000Z";

export const JOB_COMPLETED_ID = "job_completed";
export const JOB_COMPLETED_TITLE = "Completed job";
export const JOB_COMPLETED_SCHEDULED_AT = "2026-09-05T09:00:00.000Z";

export const JOB_ARCHIVED_ID = "job_archived";
export const JOB_ARCHIVED_TITLE = "Archived job";
export const JOB_ARCHIVED_SCHEDULED_AT = "2026-09-08T09:00:00.000Z";

export const JOB_OTHER_ID = "job_other";
export const JOB_OTHER_TITLE = "Other Company job";
export const JOB_OTHER_SCHEDULED_AT = "2026-10-02T08:00:00.000Z";

// ---------------------------------------------------------------------------
// Timestamps. B12 fixes the create instant for every resource; the
// transition instants are fixed, strictly later values so `listRecent`
// ordering is unambiguous in tests.
// ---------------------------------------------------------------------------

const SEED_CREATED_AT = "2026-09-01T09:00:00.000Z";
/** The same instant as `SEED_CREATED_AT`, in the unit the framework's own
 * `organizations.created_at` and `org_members.joined_at` columns use: epoch
 * milliseconds (F6). Every seeded organization and membership carries it. */
const SEED_CREATED_AT_MS = Date.parse(SEED_CREATED_AT);
const SEED_STARTED_AT = "2026-09-02T09:00:00.000Z";
const SEED_COMPLETED_AT = "2026-09-02T09:00:00.000Z";
const SEED_ARCHIVED_AT = "2026-09-03T09:00:00.000Z";

type SeedAction =
  | "create-customer"
  | "create-job"
  | "start-job"
  | "complete-job"
  | "archive-job";

function classificationFor(action: SeedAction): OperationClassification {
  const found = OPERATION_CLASSIFICATION[action];
  if (!found) {
    throw new Error(`No classification registered for action "${action}"`);
  }
  return found;
}

/** Every seed operation was, in this fiction, performed by the seed script
 * itself while signed in as `owner@example.invalid` (blueprint B12) — even
 * the `org_other` resources, which is why `performedBy` here is always the
 * same constant while each resource's own `createdBy` is its own org's
 * owner. */
function forwardOperation(input: {
  id: string;
  orgId: string;
  action: SeedAction;
  resourceType: ResourceType;
  resourceId: string;
  versionBefore: number;
  versionAfter: number;
  payload: Record<string, unknown>;
  inverse: InverseCommand;
  performedAt: string;
}): Operation {
  return {
    id: input.id,
    orgId: input.orgId,
    kind: "forward",
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    classification: classificationFor(input.action),
    versionBefore: input.versionBefore,
    versionAfter: input.versionAfter,
    payload: input.payload,
    inverse: input.inverse,
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: OWNER_EMAIL,
    performedVia: "seed",
    performedAt: input.performedAt,
  };
}

function createJobPayload(job: Job): Record<string, unknown> {
  return {
    customerId: job.customerId,
    title: job.title,
    description: job.description,
    scheduledAt: job.scheduledAt,
    assignedTo: job.assignedTo,
  };
}

function createCustomerPayload(customer: Customer): Record<string, unknown> {
  return {
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    notes: customer.notes,
  };
}

/** A job's status/completedAt/archivedAt before a transition, the shape
 * `restore-job-status` needs to undo it (blueprint B9). */
function statusBefore(job: Job): InverseCommand {
  return {
    type: "restore-job-status",
    previous: {
      status: job.status,
      completedAt: job.completedAt,
      archivedAt: job.archivedAt,
    },
  };
}

export interface CustomerSet {
  customers: readonly Customer[];
  operations: readonly Operation[];
}

/** `org_acme`'s three customers and their create operations — one of them,
 * `cus_archived`, inserted already archived (blueprint B12 fixes every
 * customer at version 1, so this is not `createCustomer` followed by
 * `archiveCustomer`, which would leave version 2). */
export function createCustomers(): CustomerSet {
  const customerA = createCustomer({
    id: CUSTOMER_A_ID,
    orgId: ORG_ACME_ID,
    name: CUSTOMER_A_NAME,
    createdBy: OWNER_EMAIL,
    now: SEED_CREATED_AT,
  });
  const customerB = createCustomer({
    id: CUSTOMER_B_ID,
    orgId: ORG_ACME_ID,
    name: CUSTOMER_B_NAME,
    createdBy: OWNER_EMAIL,
    now: SEED_CREATED_AT,
  });
  const customerArchived: Customer = {
    ...createCustomer({
      id: CUSTOMER_ARCHIVED_ID,
      orgId: ORG_ACME_ID,
      name: CUSTOMER_ARCHIVED_NAME,
      createdBy: OWNER_EMAIL,
      now: SEED_CREATED_AT,
    }),
    status: "archived",
  };

  const operations: Operation[] = [
    forwardOperation({
      id: "op_create_cus_a",
      orgId: ORG_ACME_ID,
      action: "create-customer",
      resourceType: "customer",
      resourceId: customerA.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: createCustomerPayload(customerA),
      inverse: { type: "archive-customer" },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_create_cus_b",
      orgId: ORG_ACME_ID,
      action: "create-customer",
      resourceType: "customer",
      resourceId: customerB.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: createCustomerPayload(customerB),
      inverse: { type: "archive-customer" },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_create_cus_archived",
      orgId: ORG_ACME_ID,
      action: "create-customer",
      resourceType: "customer",
      resourceId: customerArchived.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: createCustomerPayload(customerArchived),
      inverse: { type: "archive-customer" },
      performedAt: SEED_CREATED_AT,
    }),
  ];

  return { customers: [customerA, customerB, customerArchived], operations };
}

export interface CompanyWithMembers extends CustomerSet {
  organization: SeedOrganization;
  memberships: readonly SeedMembership[];
}

/** `org_acme`, its four members and its three customers (blueprint B12). */
export function createCompanyWithMembers(): CompanyWithMembers {
  return {
    organization: {
      id: ORG_ACME_ID,
      name: ORG_ACME_NAME,
      createdBy: OWNER_EMAIL,
      createdAt: SEED_CREATED_AT_MS,
    },
    memberships: SEED_MEMBERSHIPS.filter((m) => m.orgId === ORG_ACME_ID),
    ...createCustomers(),
  };
}

export interface JobScenario {
  job: Job;
  operations: readonly Operation[];
}

/** `job_scheduled` on `cus_a`, still in its created state (blueprint B12). */
export function createScheduledJob(): JobScenario {
  const job = createJob({
    id: JOB_SCHEDULED_ID,
    orgId: ORG_ACME_ID,
    customerId: CUSTOMER_A_ID,
    title: JOB_SCHEDULED_TITLE,
    scheduledAt: JOB_SCHEDULED_AT,
    assignedTo: MEMBER1_EMAIL,
    createdBy: OWNER_EMAIL,
    now: SEED_CREATED_AT,
  });
  const operations = [
    forwardOperation({
      id: "op_create_job_scheduled",
      orgId: ORG_ACME_ID,
      action: "create-job",
      resourceType: "job",
      resourceId: job.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: createJobPayload(job),
      inverse: { type: "archive-job" },
      performedAt: SEED_CREATED_AT,
    }),
  ];
  return { job, operations };
}

/** `job_in_progress` on `cus_a`: created, then started (blueprint B12:
 * version 1 → 2 via `start-job`). Not one of B12's four named builders, but
 * built the same way and for the same reason: the version, `updatedAt` and
 * inverse must come from the real domain functions, not be hand-typed. */
export function createInProgressJob(): JobScenario {
  const created = createJob({
    id: JOB_IN_PROGRESS_ID,
    orgId: ORG_ACME_ID,
    customerId: CUSTOMER_A_ID,
    title: JOB_IN_PROGRESS_TITLE,
    scheduledAt: JOB_IN_PROGRESS_SCHEDULED_AT,
    createdBy: OWNER_EMAIL,
    now: SEED_CREATED_AT,
  });
  const job = startJob(created, SEED_STARTED_AT);

  const operations = [
    forwardOperation({
      id: "op_create_job_in_progress",
      orgId: ORG_ACME_ID,
      action: "create-job",
      resourceType: "job",
      resourceId: created.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: createJobPayload(created),
      inverse: { type: "archive-job" },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_start_job_in_progress",
      orgId: ORG_ACME_ID,
      action: "start-job",
      resourceType: "job",
      resourceId: created.id,
      versionBefore: 1,
      versionAfter: 2,
      payload: {},
      inverse: statusBefore(created),
      performedAt: SEED_STARTED_AT,
    }),
  ];

  return { job, operations };
}

/** `job_completed` on `cus_b`: created, then completed directly from
 * `scheduled` (blueprint B12: version 1 → 2 via `complete-job`). */
export function createCompletedJob(): JobScenario {
  const created = createJob({
    id: JOB_COMPLETED_ID,
    orgId: ORG_ACME_ID,
    customerId: CUSTOMER_B_ID,
    title: JOB_COMPLETED_TITLE,
    scheduledAt: JOB_COMPLETED_SCHEDULED_AT,
    createdBy: OWNER_EMAIL,
    now: SEED_CREATED_AT,
  });
  const job = completeJob(created, SEED_COMPLETED_AT);

  const operations = [
    forwardOperation({
      id: "op_create_job_completed",
      orgId: ORG_ACME_ID,
      action: "create-job",
      resourceType: "job",
      resourceId: created.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: createJobPayload(created),
      inverse: { type: "archive-job" },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_complete_job_completed",
      orgId: ORG_ACME_ID,
      action: "complete-job",
      resourceType: "job",
      resourceId: created.id,
      versionBefore: 1,
      versionAfter: 2,
      payload: {},
      inverse: statusBefore(created),
      performedAt: SEED_COMPLETED_AT,
    }),
  ];

  return { job, operations };
}

/** `job_archived` on `cus_b`: created, then archived directly from
 * `scheduled` (blueprint B12: version 1 → 2, "create + archive op"). Not
 * one of B12's four named builders, built the same way as
 * `createInProgressJob` above. */
export function createArchivedJob(): JobScenario {
  const created = createJob({
    id: JOB_ARCHIVED_ID,
    orgId: ORG_ACME_ID,
    customerId: CUSTOMER_B_ID,
    title: JOB_ARCHIVED_TITLE,
    scheduledAt: JOB_ARCHIVED_SCHEDULED_AT,
    createdBy: OWNER_EMAIL,
    now: SEED_CREATED_AT,
  });
  const job = archiveJob(created, SEED_ARCHIVED_AT);

  const operations = [
    forwardOperation({
      id: "op_create_job_archived",
      orgId: ORG_ACME_ID,
      action: "create-job",
      resourceType: "job",
      resourceId: created.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: createJobPayload(created),
      inverse: { type: "archive-job" },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_archive_job_archived",
      orgId: ORG_ACME_ID,
      action: "archive-job",
      resourceType: "job",
      resourceId: created.id,
      versionBefore: 1,
      versionAfter: 2,
      payload: {},
      inverse: statusBefore(created),
      performedAt: SEED_ARCHIVED_AT,
    }),
  ];

  return { job, operations };
}

export interface ForeignOrganization {
  organization: SeedOrganization;
  memberships: readonly SeedMembership[];
  customer: Customer;
  operations: readonly Operation[];
}

/** `org_other`, its outsider owner and `cus_other` — the other half of every
 * cross-organization isolation test (blueprint B12). Its own owner, not
 * `org_acme`'s, is the customer's `createdBy`, while the operation row's
 * `performedBy` stays `owner@example.invalid` for every seeded row. */
export function createForeignOrganization(): ForeignOrganization {
  const customer = createCustomer({
    id: CUSTOMER_OTHER_ID,
    orgId: ORG_OTHER_ID,
    name: CUSTOMER_OTHER_NAME,
    createdBy: OUTSIDER_EMAIL,
    now: SEED_CREATED_AT,
  });

  return {
    organization: {
      id: ORG_OTHER_ID,
      name: ORG_OTHER_NAME,
      createdBy: OUTSIDER_EMAIL,
      createdAt: SEED_CREATED_AT_MS,
    },
    memberships: SEED_MEMBERSHIPS.filter((m) => m.orgId === ORG_OTHER_ID),
    customer,
    operations: [
      forwardOperation({
        id: "op_create_cus_other",
        orgId: ORG_OTHER_ID,
        action: "create-customer",
        resourceType: "customer",
        resourceId: customer.id,
        versionBefore: 0,
        versionAfter: 1,
        payload: createCustomerPayload(customer),
        inverse: { type: "archive-customer" },
        performedAt: SEED_CREATED_AT,
      }),
    ],
  };
}

export interface ForeignOrganizationScenario extends ForeignOrganization {
  job: Job;
}

/** `createForeignOrganization()` plus `job_other`, the single job an
 * `org_other` user may see (blueprint B12). */
export function createForeignOrganizationJob(): ForeignOrganizationScenario {
  const organization = createForeignOrganization();
  const job = createJob({
    id: JOB_OTHER_ID,
    orgId: ORG_OTHER_ID,
    customerId: organization.customer.id,
    title: JOB_OTHER_TITLE,
    scheduledAt: JOB_OTHER_SCHEDULED_AT,
    createdBy: OUTSIDER_EMAIL,
    now: SEED_CREATED_AT,
  });

  return {
    ...organization,
    job,
    operations: [
      ...organization.operations,
      forwardOperation({
        id: "op_create_job_other",
        orgId: ORG_OTHER_ID,
        action: "create-job",
        resourceType: "job",
        resourceId: job.id,
        versionBefore: 0,
        versionAfter: 1,
        payload: createJobPayload(job),
        inverse: { type: "archive-job" },
        performedAt: SEED_CREATED_AT,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// The whole scenario
// ---------------------------------------------------------------------------

export interface Scenario {
  organizations: readonly SeedOrganization[];
  memberships: readonly SeedMembership[];
  customers: readonly Customer[];
  jobs: readonly Job[];
  operations: readonly Operation[];
}

/**
 * Every builder above, composed into the flat row sets blueprint B12
 * describes. This is the only composition in the file: `seedInMemory` and
 * `buildScenarioSql` both go through it, so the in-memory fixture and the
 * seeded database cannot disagree about what "the scenario" is.
 */
export function buildScenario(): Scenario {
  const company = createCompanyWithMembers();
  const scheduled = createScheduledJob();
  const inProgress = createInProgressJob();
  const completed = createCompletedJob();
  const archived = createArchivedJob();
  const foreign = createForeignOrganizationJob();

  return {
    organizations: [company.organization, foreign.organization],
    memberships: [...company.memberships, ...foreign.memberships],
    customers: [...company.customers, foreign.customer],
    jobs: [
      scheduled.job,
      inProgress.job,
      completed.job,
      archived.job,
      foreign.job,
    ],
    operations: [
      ...company.operations,
      ...scheduled.operations,
      ...inProgress.operations,
      ...completed.operations,
      ...archived.operations,
      ...foreign.operations,
    ],
  };
}

/**
 * Loads the full B12 scenario into an `InMemoryDependencies`'s state:
 * memberships, customers, jobs and their creating (and, where the table
 * calls for it, transitioning) operations. Use-case tests call this once per
 * test and then act as one of the seeded users.
 *
 * The organizations themselves have no in-memory counterpart: nothing in the
 * application layer reads an organization row, only the membership that
 * points at it.
 */
export function seedInMemory(deps: InMemoryDependencies): void {
  const scenario = buildScenario();

  for (const membership of scenario.memberships) {
    const org =
      deps.state.memberships.get(membership.orgId) ?? new Map<string, Role>();
    org.set(membership.email.toLowerCase(), membership.role);
    deps.state.memberships.set(membership.orgId, org);
  }

  for (const customer of scenario.customers) {
    deps.state.customers.set(customer.id, customer);
  }

  for (const job of scenario.jobs) {
    deps.state.jobs.set(job.id, job);
  }

  for (const operation of scenario.operations) {
    deps.state.operations.set(operation.id, operation);
  }
}

// ---------------------------------------------------------------------------
// SQL rendering (blueprint B12)
//
// Literal values rather than bound parameters, because the two consumers that
// are not `@libsql/client` — `wrangler d1 execute --file` locally and against
// remote D1 — take a `.sql` file and nothing else. Every string therefore goes
// through `sqlText`, which is the one place a quote is escaped.
//
// `INSERT OR IGNORE` everywhere makes a second seed run a no-op instead of a
// primary-key failure (T11 step 2's idempotency requirement). It also means a
// row that already exists is left exactly as it is: the seed never overwrites
// data someone changed by hand.
// ---------------------------------------------------------------------------

/** A single-quoted SQL string literal, or `NULL`. Doubling the quote is the
 * whole escape rule SQLite has for string literals; there is no backslash
 * escape to worry about. */
function sqlText(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.split("'").join("''")}'`;
}

/** The two JSON columns (`operations.payload`, `operations.inverse`) hold
 * JSON text, so the value is serialised and then quoted like any other
 * string. */
function sqlJson(value: object | null): string {
  return value === null ? "NULL" : sqlText(JSON.stringify(value));
}

function insertOrIgnore(
  table: string,
  columns: string,
  values: readonly string[],
): string {
  return `INSERT OR IGNORE INTO ${table} (${columns}) VALUES (${values.join(", ")});`;
}

// The application tables. Column names and their order mirror
// `src/infrastructure/d1/sql.ts`; `migrations/0001_init.sql` is the schema
// they describe. `jobs.accounting_reference`/`accounting_sent_at` are absent
// because migration 0002 (T27) has not added them yet.
const CUSTOMER_INSERT_COLUMNS =
  "id, org_id, name, email, phone, notes, status, version, created_by, created_at, updated_at";
const JOB_INSERT_COLUMNS =
  "id, org_id, customer_id, title, description, status, scheduled_at, assigned_to, completed_at, archived_at, accounting_reference, accounting_sent_at, version, created_by, created_at, updated_at";
const OPERATION_INSERT_COLUMNS =
  "id, org_id, kind, action, resource_type, resource_id, classification, version_before, version_after, payload, inverse, related_operation_id, undone_by_operation_id, performed_by, performed_via, performed_at";

// The framework-owned tables (F6). Column inventory read from
// `node_modules/@agent-native/core/dist/org/migrations.js`:
//
//   organizations (v1001, extended by v1004, v1005, v1013, v1014)
//     NOT NULL: name, created_by, created_at — plus the `id` PRIMARY KEY.
//     Nullable, added later and never written by the seed: allowed_domain,
//     a2a_secret, workspace_url, required_auth_provider.
//   org_members (v1002)
//     NOT NULL: org_id, email, role, joined_at — plus the `id` PRIMARY KEY.
//     No nullable columns. UNIQUE(org_id, email) since v1002 and a UNIQUE
//     index on (org_id, LOWER(email)) since v1010, both of which `INSERT OR
//     IGNORE` turns into a no-op on a re-seed.
//
// `organizations.created_at` and `org_members.joined_at` are INTEGER columns
// holding epoch milliseconds, not the ISO strings the application tables use.
const ORGANIZATION_INSERT_COLUMNS = "id, name, created_by, created_at";
const ORG_MEMBER_INSERT_COLUMNS = "id, org_id, email, role, joined_at";

/**
 * The whole scenario as `INSERT OR IGNORE` statements, in dependency order:
 * organizations, memberships, customers, then jobs (whose foreign key names
 * `customers (org_id, id)`), then the operations that reference both.
 *
 * User accounts are deliberately absent — `scripts/seed.mjs` creates those
 * over HTTP so the framework hashes the password and writes whatever session
 * bookkeeping it owns (B12).
 */
export function buildScenarioSql(): string[] {
  const scenario = buildScenario();
  const statements: string[] = [];

  for (const org of scenario.organizations) {
    statements.push(
      insertOrIgnore("organizations", ORGANIZATION_INSERT_COLUMNS, [
        sqlText(org.id),
        sqlText(org.name),
        sqlText(org.createdBy),
        String(org.createdAt),
      ]),
    );
  }

  for (const membership of scenario.memberships) {
    statements.push(
      insertOrIgnore("org_members", ORG_MEMBER_INSERT_COLUMNS, [
        sqlText(membership.id),
        sqlText(membership.orgId),
        sqlText(membership.email),
        sqlText(membership.role),
        String(SEED_CREATED_AT_MS),
      ]),
    );
  }

  for (const customer of scenario.customers) {
    statements.push(
      insertOrIgnore("customers", CUSTOMER_INSERT_COLUMNS, [
        sqlText(customer.id),
        sqlText(customer.orgId),
        sqlText(customer.name),
        sqlText(customer.email),
        sqlText(customer.phone),
        sqlText(customer.notes),
        sqlText(customer.status),
        String(customer.version),
        sqlText(customer.createdBy),
        sqlText(customer.createdAt),
        sqlText(customer.updatedAt),
      ]),
    );
  }

  for (const job of scenario.jobs) {
    statements.push(
      insertOrIgnore("jobs", JOB_INSERT_COLUMNS, [
        sqlText(job.id),
        sqlText(job.orgId),
        sqlText(job.customerId),
        sqlText(job.title),
        sqlText(job.description),
        sqlText(job.status),
        sqlText(job.scheduledAt),
        sqlText(job.assignedTo),
        sqlText(job.completedAt),
        sqlText(job.archivedAt),
        sqlText(job.accountingReference),
        sqlText(job.accountingSentAt),
        String(job.version),
        sqlText(job.createdBy),
        sqlText(job.createdAt),
        sqlText(job.updatedAt),
      ]),
    );
  }

  for (const operation of scenario.operations) {
    statements.push(
      insertOrIgnore("operations", OPERATION_INSERT_COLUMNS, [
        sqlText(operation.id),
        sqlText(operation.orgId),
        sqlText(operation.kind),
        sqlText(operation.action),
        sqlText(operation.resourceType),
        sqlText(operation.resourceId),
        sqlText(operation.classification),
        String(operation.versionBefore),
        String(operation.versionAfter),
        sqlJson(operation.payload),
        sqlJson(operation.inverse),
        sqlText(operation.relatedOperationId),
        sqlText(operation.undoneByOperationId),
        sqlText(operation.performedBy),
        sqlText(operation.performedVia),
        sqlText(operation.performedAt),
      ]),
    );
  }

  return statements;
}

/**
 * `DELETE` statements that remove everything `buildScenarioSql` wrote, and
 * nothing else: every statement is filtered to the two seeded organization
 * ids, so a database that also holds hand-made rows for another organization
 * keeps them (blueprint B12).
 *
 * Child rows first — operations, jobs, customers — so the foreign key from
 * `jobs` to `customers` holds throughout, then the two framework-owned
 * tables. User accounts are not deleted: the seed did not create them by SQL
 * and does not know which rows the framework's auth tables own.
 */
export function buildScenarioResetSql(): string[] {
  const orgIds = buildScenario()
    .organizations.map((org) => sqlText(org.id))
    .join(", ");

  return [
    `DELETE FROM operations WHERE org_id IN (${orgIds});`,
    `DELETE FROM accounting_exports WHERE org_id IN (${orgIds});`,
    `DELETE FROM jobs WHERE org_id IN (${orgIds});`,
    `DELETE FROM customers WHERE org_id IN (${orgIds});`,
    `DELETE FROM org_members WHERE org_id IN (${orgIds});`,
    `DELETE FROM organizations WHERE id IN (${orgIds});`,
  ];
}
