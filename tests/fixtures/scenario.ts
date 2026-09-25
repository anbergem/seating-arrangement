/**
 * Deterministic seed scenario (blueprint B12).
 *
 * Every id, email, name and timestamp here is a fixed constant: AGENTS.md
 * forbids random test data, so a failing assertion always points at the same
 * fixture, run after run. `buildScenario()` is the single composition every
 * consumer goes through: `seedInMemory` loads it into an in-memory
 * `Dependencies`, and `buildScenarioSql()` renders the same objects as
 * upsert statements for the Node SQLite file and for PostgreSQL. The two
 * can therefore not drift. `scripts/seed.mjs` creates the user accounts over
 * HTTP (never SQL); this file never touches `user`-shaped tables.
 *
 * The event/table/operation objects are produced by calling the real
 * domain functions (`createEvent`, `createSeatingTable`, `labelSeat`, …) with
 * fixed `now` values instead of being hand-typed, so a version, an `updatedAt`, or
 * an inverse command can never drift from what the domain layer would
 * actually produce for the same sequence of calls.
 *
 * `createCompanyWithMembers`, `createForeignOrganization`,
 * `createSeatingArrangement` and `createForeignOrganizationSeating` are the
 * named scenario builders blueprint B12 calls for. `buildScenario` composes
 * all of them into the full scenario.
 */

import type { Role } from "../../src/application/authorization";
import {
  archiveEvent,
  cellsOf,
  createEvent,
  createSeatingTable,
  roomOf,
  labelSeat,
  OPERATION_CLASSIFICATION,
  type Event,
  type InverseCommand,
  type Operation,
  type OperationClassification,
  type ResourceType,
  type SeatingTable,
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
// Events and seating
// ---------------------------------------------------------------------------

/**
 * The instant every other date in this scenario is chosen relative to. Exported
 * because a caller that tells an agent what "today" is has to agree with the
 * rows: `scripts/eval-suite.ts` pins the evals' runtime context to it so a
 * date-relative question resolves the same way on every run.
 */
export const FIXTURE_CLOCK = "2026-09-06T12:00:00.000Z";

export const EVENT_GALA_ID = "evt_gala";
export const EVENT_GALA_NAME = "Spring Gala";
export const EVENT_GALA_STARTS_AT = "2026-10-03T17:00:00.000Z";

export const EVENT_ARCHIVED_ID = "evt_archived";
export const EVENT_ARCHIVED_NAME = "Cancelled Offsite";
export const EVENT_ARCHIVED_STARTS_AT = "2026-11-20T09:00:00.000Z";

export const EVENT_OTHER_ID = "evt_other";
export const EVENT_OTHER_NAME = "Other Company party";
export const EVENT_OTHER_STARTS_AT = "2026-10-09T17:00:00.000Z";

/** A straight table two cells long with a chair at each end, in the top-left
 * corner: six seats, numbered clockwise from 0. */
export const TABLE_HEAD_ID = "tbl_head";
export const TABLE_HEAD_NAME = "Head table";
/** A straight table four cells long with no end chairs, standing immediately to
 * its right — adjacent but not overlapping, which is what makes it useful for
 * the drag tests. */
export const TABLE_SIDE_ID = "tbl_side";
export const TABLE_SIDE_NAME = "Table 2";
export const TABLE_OTHER_ID = "tbl_other";
export const TABLE_OTHER_NAME = "Other Company table";

export const SEAT_LABEL_ADA = "Ada Lovelace";
export const SEAT_LABEL_GRACE = "Grace Hopper";

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

type SeedAction =
  | "create-event"
  | "archive-event"
  | "create-seating-table"
  | "label-seat";

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

function createSeatingTablePayload(
  table: SeatingTable,
): Record<string, unknown> {
  return {
    eventId: table.eventId,
    name: table.name,
    kind: table.kind,
    size: table.size,
    endSeats: table.endSeats,
    rotation: table.rotation,
    gridX: table.gridX,
    gridY: table.gridY,
  };
}

export interface CompanyWithMembers {
  organization: SeedOrganization;
  memberships: readonly SeedMembership[];
}

/** `org_acme` and its four members (blueprint B12). */
export function createCompanyWithMembers(): CompanyWithMembers {
  return {
    organization: {
      id: ORG_ACME_ID,
      name: ORG_ACME_NAME,
      createdBy: OWNER_EMAIL,
      createdAt: SEED_CREATED_AT_MS,
    },
    memberships: SEED_MEMBERSHIPS.filter((m) => m.orgId === ORG_ACME_ID),
  };
}

export interface SeatingScenario {
  events: readonly Event[];
  tables: readonly SeatingTable[];
  operations: readonly Operation[];
}

/**
 * `org_acme`'s two events and the floor plan of the live one (blueprint B12).
 *
 * Built by calling the real domain functions in the order a user would, so the
 * versions, the `updatedAt` values and the recorded inverses are exactly what
 * the application would have produced. `tbl_head` sits at the origin and
 * `tbl_side` immediately to its right: adjacent, not overlapping, which is the
 * arrangement the drag and undo tests need.
 */
export function createSeatingArrangement(): SeatingScenario {
  const gala = createEvent({
    id: EVENT_GALA_ID,
    orgId: ORG_ACME_ID,
    name: EVENT_GALA_NAME,
    startsAt: EVENT_GALA_STARTS_AT,
    createdBy: OWNER_EMAIL,
    now: SEED_CREATED_AT,
  });
  const cancelled = archiveEvent(
    createEvent({
      id: EVENT_ARCHIVED_ID,
      orgId: ORG_ACME_ID,
      name: EVENT_ARCHIVED_NAME,
      startsAt: EVENT_ARCHIVED_STARTS_AT,
      createdBy: OWNER_EMAIL,
      now: SEED_CREATED_AT,
    }),
    SEED_CREATED_AT,
  );

  const head = createSeatingTable(
    {
      id: TABLE_HEAD_ID,
      orgId: ORG_ACME_ID,
      eventId: gala.id,
      name: TABLE_HEAD_NAME,
      size: 2,
      endSeats: true,
      gridX: 0,
      gridY: 0,
      createdBy: OWNER_EMAIL,
      now: SEED_CREATED_AT,
    },
    { room: roomOf(gala), tables: [] },
  );
  // Seats are numbered clockwise from the start of the table's run, so 0 and 1
  // are the first two along its far side.
  const galaPlan = { room: roomOf(gala), tables: [] };
  const headLabelled = labelSeat(
    labelSeat(head, 0, SEAT_LABEL_ADA, galaPlan, SEED_CREATED_AT),
    1,
    SEAT_LABEL_GRACE,
    galaPlan,
    SEED_CREATED_AT,
  );
  const side = createSeatingTable(
    {
      id: TABLE_SIDE_ID,
      orgId: ORG_ACME_ID,
      eventId: gala.id,
      name: TABLE_SIDE_NAME,
      size: 4,
      endSeats: false,
      gridX: 4,
      gridY: 0,
      createdBy: OWNER_EMAIL,
      now: SEED_CREATED_AT,
    },
    { room: roomOf(gala), tables: [headLabelled] },
  );

  const operations = [
    forwardOperation({
      id: "op_create_evt_gala",
      orgId: ORG_ACME_ID,
      action: "create-event",
      resourceType: "event",
      resourceId: gala.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: { name: gala.name, startsAt: gala.startsAt },
      inverse: { type: "archive-event" },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_create_evt_archived",
      orgId: ORG_ACME_ID,
      action: "create-event",
      resourceType: "event",
      resourceId: cancelled.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: { name: cancelled.name, startsAt: cancelled.startsAt },
      inverse: { type: "archive-event" },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_archive_evt_archived",
      orgId: ORG_ACME_ID,
      action: "archive-event",
      resourceType: "event",
      resourceId: cancelled.id,
      versionBefore: 1,
      versionAfter: 2,
      payload: {},
      inverse: { type: "restore-event" },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_create_tbl_head",
      orgId: ORG_ACME_ID,
      action: "create-seating-table",
      resourceType: "seating_table",
      resourceId: head.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: createSeatingTablePayload(head),
      inverse: { type: "archive-seating-table" },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_label_tbl_head_top_0",
      orgId: ORG_ACME_ID,
      action: "label-seat",
      resourceType: "seating_table",
      resourceId: head.id,
      versionBefore: 1,
      versionAfter: 2,
      payload: { seat: 0, label: SEAT_LABEL_ADA },
      inverse: {
        type: "restore-seat-label",
        seat: 0,
        previousLabel: "",
      },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_label_tbl_head_top_1",
      orgId: ORG_ACME_ID,
      action: "label-seat",
      resourceType: "seating_table",
      resourceId: head.id,
      versionBefore: 2,
      versionAfter: 3,
      payload: { seat: 1, label: SEAT_LABEL_GRACE },
      inverse: {
        type: "restore-seat-label",
        seat: 1,
        previousLabel: "",
      },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_create_tbl_side",
      orgId: ORG_ACME_ID,
      action: "create-seating-table",
      resourceType: "seating_table",
      resourceId: side.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: createSeatingTablePayload(side),
      inverse: { type: "archive-seating-table" },
      performedAt: SEED_CREATED_AT,
    }),
  ];

  return {
    events: [gala, cancelled],
    tables: [headLabelled, side],
    operations,
  };
}

/** `org_other`'s event and its one table, which no `org_acme` member may
 * see (blueprint B12). */
export function createForeignOrganizationSeating(): SeatingScenario {
  const event = createEvent({
    id: EVENT_OTHER_ID,
    orgId: ORG_OTHER_ID,
    name: EVENT_OTHER_NAME,
    startsAt: EVENT_OTHER_STARTS_AT,
    createdBy: OUTSIDER_EMAIL,
    now: SEED_CREATED_AT,
  });
  const table = createSeatingTable(
    {
      id: TABLE_OTHER_ID,
      orgId: ORG_OTHER_ID,
      eventId: event.id,
      name: TABLE_OTHER_NAME,
      size: 2,
      endSeats: false,
      gridX: 0,
      gridY: 0,
      createdBy: OUTSIDER_EMAIL,
      now: SEED_CREATED_AT,
    },
    { room: roomOf(event), tables: [] },
  );
  const operations = [
    forwardOperation({
      id: "op_create_evt_other",
      orgId: ORG_OTHER_ID,
      action: "create-event",
      resourceType: "event",
      resourceId: event.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: { name: event.name, startsAt: event.startsAt },
      inverse: { type: "archive-event" },
      performedAt: SEED_CREATED_AT,
    }),
    forwardOperation({
      id: "op_create_tbl_other",
      orgId: ORG_OTHER_ID,
      action: "create-seating-table",
      resourceType: "seating_table",
      resourceId: table.id,
      versionBefore: 0,
      versionAfter: 1,
      payload: createSeatingTablePayload(table),
      inverse: { type: "archive-seating-table" },
      performedAt: SEED_CREATED_AT,
    }),
  ];
  return { events: [event], tables: [table], operations };
}

/** `org_other` and its owner: the organization every isolation test proves is
 * invisible from `org_acme` (blueprint B12). */
export interface ForeignOrganization {
  organization: SeedOrganization;
  memberships: readonly SeedMembership[];
}

export function createForeignOrganization(): ForeignOrganization {
  return {
    organization: {
      id: ORG_OTHER_ID,
      name: ORG_OTHER_NAME,
      createdBy: OUTSIDER_EMAIL,
      createdAt: SEED_CREATED_AT_MS,
    },
    memberships: SEED_MEMBERSHIPS.filter((m) => m.orgId === ORG_OTHER_ID),
  };
}

// ---------------------------------------------------------------------------
// The whole scenario
// ---------------------------------------------------------------------------

export interface Scenario {
  organizations: readonly SeedOrganization[];
  memberships: readonly SeedMembership[];
  events: readonly Event[];
  seatingTables: readonly SeatingTable[];
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
  const foreign = createForeignOrganization();
  const seating = createSeatingArrangement();
  const foreignSeating = createForeignOrganizationSeating();

  return {
    organizations: [company.organization, foreign.organization],
    memberships: [...company.memberships, ...foreign.memberships],
    events: [...seating.events, ...foreignSeating.events],
    seatingTables: [...seating.tables, ...foreignSeating.tables],
    operations: [...seating.operations, ...foreignSeating.operations],
  };
}

/**
 * Loads the full B12 scenario into an `InMemoryDependencies`'s state:
 * memberships, events, seating tables and the operations that created and
 * changed them. Use-case tests call this once per test and then act as one of
 * the seeded users.
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

  for (const event of scenario.events) {
    deps.state.events.set(event.id, event);
  }

  for (const table of scenario.seatingTables) {
    deps.state.seatingTables.set(table.id, table);
  }

  for (const operation of scenario.operations) {
    deps.state.operations.set(operation.id, operation);
  }
}

// ---------------------------------------------------------------------------
// SQL rendering (blueprint B12)
//
// Literal values rather than bound parameters: the scenario is a fixed set of rows
// shared by the seed and the tests, and every string goes through `sqlText`, which is
// the one place a quote is escaped.
//
// `ON CONFLICT DO NOTHING` everywhere makes a second seed run a no-op instead of a
// primary-key failure (T11 step 2's idempotency requirement). It also means a row that
// already exists is left exactly as it is: the seed never overwrites data someone
// changed by hand. It replaced `INSERT OR IGNORE`, which says the same thing in
// SQLite only and is a syntax error in PostgreSQL (T28).
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
  return `INSERT INTO ${table} (${columns}) VALUES (${values.join(", ")}) ON CONFLICT DO NOTHING;`;
}

// The application tables. Column names and their order mirror
// `src/infrastructure/sql/sql.ts`; `migrations/` is the schema they describe.
const EVENT_INSERT_COLUMNS =
  "id, org_id, name, starts_at, room_width, room_height, status, version, created_by, created_at, updated_at";

const SEATING_TABLE_INSERT_COLUMNS =
  "id, org_id, event_id, name, kind, size, end_seats, rotation, grid_x, grid_y, seats, status, version, created_by, created_at, updated_at";

const SEATING_CELL_INSERT_COLUMNS = "org_id, event_id, x, y, table_id";

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
 * organizations, memberships, events, then seating tables (whose foreign key
 * names `events (org_id, id)`), then the operations that reference both.
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

  for (const event of scenario.events) {
    statements.push(
      insertOrIgnore("events", EVENT_INSERT_COLUMNS, [
        sqlText(event.id),
        sqlText(event.orgId),
        sqlText(event.name),
        sqlText(event.startsAt),
        String(event.roomWidth),
        String(event.roomHeight),
        sqlText(event.status),
        String(event.version),
        sqlText(event.createdBy),
        sqlText(event.createdAt),
        sqlText(event.updatedAt),
      ]),
    );
  }

  for (const table of scenario.seatingTables) {
    statements.push(
      insertOrIgnore("seating_tables", SEATING_TABLE_INSERT_COLUMNS, [
        sqlText(table.id),
        sqlText(table.orgId),
        sqlText(table.eventId),
        sqlText(table.name),
        sqlText(table.kind),
        String(table.size),
        table.endSeats ? "1" : "0",
        String(table.rotation),
        String(table.gridX),
        String(table.gridY),
        sqlText(JSON.stringify(table.seats)),
        sqlText(table.status),
        String(table.version),
        sqlText(table.createdBy),
        sqlText(table.createdAt),
        sqlText(table.updatedAt),
      ]),
    );
  }

  // Occupancy is derived, never hand-written: the same `cellsOf` the
  // application uses renders it, so a seeded plan cannot disagree with the rule
  // the `seating_cells` primary key enforces.
  for (const table of scenario.seatingTables) {
    if (table.status !== "active") continue;
    for (const cell of cellsOf(table)) {
      statements.push(
        insertOrIgnore("seating_cells", SEATING_CELL_INSERT_COLUMNS, [
          sqlText(table.orgId),
          sqlText(table.eventId),
          String(cell.x),
          String(cell.y),
          sqlText(table.id),
        ]),
      );
    }
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
 * Child rows first — operations, seating tables, events — so the foreign key
 * from `seating_tables` to `events` holds throughout, then the two
 * framework-owned tables. User accounts are not deleted: the seed did not create them by SQL
 * and does not know which rows the framework's auth tables own.
 */
export function buildScenarioResetSql(): string[] {
  const orgIds = buildScenario()
    .organizations.map((org) => sqlText(org.id))
    .join(", ");

  return [
    `DELETE FROM operations WHERE org_id IN (${orgIds});`,
    `DELETE FROM seating_cells WHERE org_id IN (${orgIds});`,
    `DELETE FROM seating_tables WHERE org_id IN (${orgIds});`,
    `DELETE FROM events WHERE org_id IN (${orgIds});`,
    `DELETE FROM org_members WHERE org_id IN (${orgIds});`,
    `DELETE FROM organizations WHERE id IN (${orgIds});`,
  ];
}
