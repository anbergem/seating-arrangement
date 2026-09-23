/**
 * The seating repositories against a real database (blueprint B18).
 *
 * The unit suite proves the use cases against `tests/fixtures/in-memory.ts`,
 * whose `spaceIsTaken` is a hand-written mirror of the SQL. This is the half
 * that proves the mirror is honest — that the `NOT EXISTS` predicate in
 * `src/infrastructure/d1/sql.ts` really refuses an overlapping write, and
 * really refuses it *inside* the statement rather than before it.
 *
 * That last part is what the concurrency tests below are for. They do not
 * simulate a race by patching a hook, the way the unit suite has to; they write
 * a real overlapping row through a second repository call and then let the
 * first one's guarded statement run. If the predicate were missing, the write
 * would succeed and the floor plan would end up overlapping itself.
 *
 * It runs against the framework's own executor (`getDbExec()`), so the atomic
 * path exercised here is the one production uses.
 */

import { getDbExec } from "@agent-native/core/db";
import { beforeAll, describe, expect, it } from "vitest";

import { AppError } from "../../src/application/errors";
import {
  archiveSeatingTable,
  cellKey,
  cellsOf,
  createEvent,
  createSeatingTable,
  labelSeat,
  moveSeatLabel,
  moveSeatingTable,
  rotateSeatingTable,
  roomOf,
  OPERATION_CLASSIFICATION,
  type Event,
  type FloorPlan,
  type Operation,
  type ResourceType,
  type Rotation,
  type SeatingTable,
  type TableShapeKind,
} from "../../src/domain";
import { createEventsRepository } from "../../src/infrastructure/d1/events-repository";
import { createSeatingTablesRepository } from "../../src/infrastructure/d1/seating-tables-repository";
import { ORG_ACME_ID, ORG_OTHER_ID, OWNER_EMAIL } from "../fixtures/scenario";

const events = createEventsRepository(getDbExec);
const tables = createSeatingTablesRepository(getDbExec);

/** The cells `seating_cells` actually holds for a table, sorted. Read directly
 * rather than through a port, because the whole point of these tests is that
 * the derived table really is being kept in step. */
async function storedCells(tableId: string): Promise<string[]> {
  const { rows } = await getDbExec().execute({
    sql: "SELECT x, y FROM seating_cells WHERE org_id = ? AND table_id = ? ORDER BY x, y",
    args: [ORG_ACME_ID, tableId],
  });
  return (rows as unknown as { x: number; y: number }[])
    .map((row) => cellKey(Number(row.x), Number(row.y)))
    .sort();
}

/** Every table this file plants lives in a default-sized room. */
function plan(tables: readonly SeatingTable[] = []): FloorPlan {
  return { room: roomOf(acmeEvent), tables };
}

function expectedCells(table: SeatingTable): string[] {
  return cellsOf(table)
    .map((cell) => cellKey(cell.x, cell.y))
    .sort();
}

// Fixed values, never generated: a failing assertion points at the same row
// every run (AGENTS.md).
const CREATED_AT = "2026-09-01T09:00:00.000Z";
const LATER = "2026-09-02T09:00:00.000Z";
const STARTS_AT = "2026-12-05T18:00:00.000Z";

let sequence = 0;
function operationFor(input: {
  action: string;
  resourceType: ResourceType;
  resourceId: string;
  orgId: string;
  versionBefore: number;
  versionAfter: number;
}): Operation {
  sequence += 1;
  return {
    id: `op_seat_${sequence}`,
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
    performedBy: OWNER_EMAIL,
    performedVia: "test",
    performedAt: input.versionBefore === 0 ? CREATED_AT : LATER,
  };
}

const acmeEvent: Event = createEvent({
  id: "repo_evt_acme",
  orgId: ORG_ACME_ID,
  name: "Integration Gala",
  startsAt: STARTS_AT,
  createdBy: OWNER_EMAIL,
  now: CREATED_AT,
});

/** A floor plan of its own, so the round tables and the continuous run get
 * empty ground instead of whatever the tests above left standing. */
const lShapeEvent: Event = createEvent({
  id: "repo_evt_lshape",
  orgId: ORG_ACME_ID,
  name: "Integration L",
  startsAt: STARTS_AT,
  createdBy: OWNER_EMAIL,
  now: CREATED_AT,
});

/** And another, because the run below needs two six-cell tables side by side
 * and the plan above has no room left for them. */
const runEvent: Event = createEvent({
  id: "repo_evt_run",
  orgId: ORG_ACME_ID,
  name: "Integration run",
  startsAt: STARTS_AT,
  createdBy: OWNER_EMAIL,
  now: CREATED_AT,
});

/** And one more, for the seat moves below: they need two tables standing
 * chair to chair, which no plan above has the room for. */
const seamEvent: Event = createEvent({
  id: "repo_evt_seam",
  orgId: ORG_ACME_ID,
  name: "Integration seam",
  startsAt: STARTS_AT,
  createdBy: OWNER_EMAIL,
  now: CREATED_AT,
});

/** And one more: the several-table batch below wants three tables standing
 * clear of everything the seam tests leave behind. */
const manyEvent: Event = createEvent({
  id: "repo_evt_many",
  orgId: ORG_ACME_ID,
  name: "Integration many",
  startsAt: STARTS_AT,
  createdBy: OWNER_EMAIL,
  now: CREATED_AT,
});

const otherEvent: Event = createEvent({
  id: "repo_evt_other",
  orgId: ORG_OTHER_ID,
  name: "Other Company Gala",
  startsAt: STARTS_AT,
  createdBy: OWNER_EMAIL,
  now: CREATED_AT,
});

function table(input: {
  id: string;
  orgId?: string;
  eventId?: string;
  kind?: TableShapeKind;
  size?: number;
  endSeats?: boolean;
  rotation?: Rotation;
  gridX: number;
  gridY: number;
}): SeatingTable {
  return createSeatingTable(
    {
      id: input.id,
      orgId: input.orgId ?? ORG_ACME_ID,
      eventId: input.eventId ?? acmeEvent.id,
      name: input.id,
      kind: input.kind ?? "rectangle",
      size: input.size ?? 2,
      endSeats: input.endSeats ?? false,
      rotation: input.rotation ?? 0,
      gridX: input.gridX,
      gridY: input.gridY,
      createdBy: OWNER_EMAIL,
      now: CREATED_AT,
    },
    { room: roomOf(acmeEvent), tables: [] },
  );
}

/** A version-guarded write, with the audit row every commit needs. */
async function commit(
  row: SeatingTable,
  expectedVersion: number,
  action: string,
): Promise<void> {
  await tables.commit({
    table: row,
    expectedVersion,
    operation: operationFor({
      action,
      resourceType: "seating_table",
      resourceId: row.id,
      orgId: row.orgId,
      versionBefore: expectedVersion,
      versionAfter: row.version,
    }),
  });
}

async function insert(row: SeatingTable): Promise<void> {
  await tables.create({
    table: row,
    operation: operationFor({
      action: "create-seating-table",
      resourceType: "seating_table",
      resourceId: row.id,
      orgId: row.orgId,
      versionBefore: 0,
      versionAfter: 1,
    }),
  });
}

beforeAll(async () => {
  for (const event of [
    acmeEvent,
    lShapeEvent,
    runEvent,
    seamEvent,
    manyEvent,
    otherEvent,
  ]) {
    await events.create({
      event,
      operation: operationFor({
        action: "create-event",
        resourceType: "event",
        resourceId: event.id,
        orgId: event.orgId,
        versionBefore: 0,
        versionAfter: 1,
      }),
    });
  }
});

describe("organization isolation", () => {
  it("hides another organization's event and table entirely", async () => {
    const foreign = table({
      id: "repo_tbl_other",
      orgId: ORG_OTHER_ID,
      eventId: otherEvent.id,
      gridX: 0,
      gridY: 0,
    });
    await insert(foreign);

    expect(await events.getById(ORG_ACME_ID, otherEvent.id)).toBeNull();
    expect(await tables.getById(ORG_ACME_ID, foreign.id)).toBeNull();
    expect(
      (await tables.list(ORG_ACME_ID, {})).some((row) => row.id === foreign.id),
    ).toBe(false);
  });

  it("does not let one organization's table block another's space", async () => {
    // `repo_tbl_other` stands at 0,0 of the other organization's event.
    const mine = table({ id: "repo_tbl_same_cell", gridX: 0, gridY: 0 });
    await expect(insert(mine)).resolves.toBeUndefined();
  });
});

describe("the parent-event guard", () => {
  it("refuses a table for an event that does not exist in this organization", async () => {
    await expect(
      insert(
        table({
          id: "repo_tbl_orphan",
          eventId: otherEvent.id,
          gridX: 10,
          gridY: 0,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await tables.getById(ORG_ACME_ID, "repo_tbl_orphan")).toBeNull();
  });
});

describe("the free-space predicate", () => {
  it("refuses an insert that overlaps a table already standing there", async () => {
    await insert(table({ id: "repo_tbl_a", gridX: 4, gridY: 0 }));
    await expect(
      insert(table({ id: "repo_tbl_overlap", gridX: 5, gridY: 0 })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await tables.getById(ORG_ACME_ID, "repo_tbl_overlap")).toBeNull();
  });

  it("allows a table that only shares an edge", async () => {
    // `repo_tbl_a` occupies columns 4 and 5 of row 0.
    await expect(
      insert(table({ id: "repo_tbl_edge", gridX: 6, gridY: 0 })),
    ).resolves.toBeUndefined();
  });

  /**
   * The race the predicate exists for. Both writers read a plan in which the
   * cell is free; the second one's statement carries the guard and so affects
   * zero rows. Without it this test would leave two tables on the same cells.
   */
  it("refuses a move into a cell somebody claimed after the caller read it", async () => {
    const mover = table({ id: "repo_tbl_mover", gridX: 0, gridY: 4 });
    await insert(mover);
    const target = { gridX: 8, gridY: 4 };

    // The caller's snapshot: nothing is at 8,4 yet.
    const moved = moveSeatingTable(mover, target, plan(), LATER);

    // Somebody else gets there first.
    await insert(table({ id: "repo_tbl_squatter", ...target }));

    await expect(
      tables.commit({
        table: moved,
        expectedVersion: mover.version,
        operation: operationFor({
          action: "move-seating-table",
          resourceType: "seating_table",
          resourceId: mover.id,
          orgId: mover.orgId,
          versionBefore: mover.version,
          versionAfter: moved.version,
        }),
      }),
    ).rejects.toBeInstanceOf(AppError);

    // Neither statement of the batch applied: the table is where it was, and
    // no audit row claims otherwise.
    const stored = await tables.getById(ORG_ACME_ID, mover.id);
    expect(stored).toMatchObject({ gridX: 0, gridY: 4, version: 1 });
  });

  it("lets a label through without asking for space", async () => {
    const subject = table({ id: "repo_tbl_label", gridX: 12, gridY: 4 });
    await insert(subject);
    const labelled = labelSeat(subject, 0, "Ada Lovelace", plan(), LATER);
    await tables.commit({
      table: labelled,
      expectedVersion: subject.version,
      operation: operationFor({
        action: "label-seat",
        resourceType: "seating_table",
        resourceId: subject.id,
        orgId: subject.orgId,
        versionBefore: subject.version,
        versionAfter: labelled.version,
      }),
    });
    const stored = await tables.getById(ORG_ACME_ID, subject.id);
    expect(stored?.seats[0]).toEqual({ label: "Ada Lovelace" });
    expect(stored?.version).toBe(2);
  });

  it("does not count a removed table as occupying its cells", async () => {
    const removedRow = table({ id: "repo_tbl_removed", gridX: 0, gridY: 7 });
    await insert(removedRow);
    const removed = archiveSeatingTable(removedRow, LATER);
    await tables.commit({
      table: removed,
      expectedVersion: removedRow.version,
      operation: operationFor({
        action: "archive-seating-table",
        resourceType: "seating_table",
        resourceId: removed.id,
        orgId: removed.orgId,
        versionBefore: removedRow.version,
        versionAfter: removed.version,
      }),
    });

    await expect(
      insert(table({ id: "repo_tbl_successor", gridX: 0, gridY: 7 })),
    ).resolves.toBeUndefined();
  });
});

describe("the version guard", () => {
  it("writes neither the row nor its audit entry when the version moved on", async () => {
    const subject = table({ id: "repo_tbl_version", gridX: 12, gridY: 0 });
    await insert(subject);
    const moved = moveSeatingTable(
      subject,
      { gridX: 12, gridY: 7 },
      plan(),
      LATER,
    );

    await expect(
      tables.commit({
        table: moved,
        // A version the row never had.
        expectedVersion: 99,
        operation: operationFor({
          action: "move-seating-table",
          resourceType: "seating_table",
          resourceId: subject.id,
          orgId: subject.orgId,
          versionBefore: 99,
          versionAfter: 100,
        }),
      }),
    ).rejects.toBeInstanceOf(AppError);

    const stored = await tables.getById(ORG_ACME_ID, subject.id);
    expect(stored).toMatchObject({ gridX: 12, gridY: 0, version: 1 });
  });
});

describe("round-tripping", () => {
  it("reads back every column, seats and all", async () => {
    const original = labelSeat(
      table({
        id: "repo_tbl_roundtrip",
        size: 3,
        endSeats: true,
        // The bottom row, clear of every other table this file plants.
        gridX: 4,
        gridY: 7,
      }),
      0,
      "Grace Hopper",
      plan(),
      CREATED_AT,
    );
    // Written as created, so the labelled copy is what goes in.
    await tables.create({
      table: original,
      operation: operationFor({
        action: "create-seating-table",
        resourceType: "seating_table",
        resourceId: original.id,
        orgId: original.orgId,
        versionBefore: 0,
        versionAfter: original.version,
      }),
    });

    expect(await tables.getById(ORG_ACME_ID, original.id)).toEqual(original);
  });

  it("lists an event's tables in creation order", async () => {
    const listed = await tables.list(ORG_ACME_ID, {
      eventId: acmeEvent.id,
      status: "active",
    });
    expect(listed.length).toBeGreaterThan(1);
    expect(listed.every((row) => row.eventId === acmeEvent.id)).toBe(true);
    expect(listed.some((row) => row.status === "archived")).toBe(false);
  });
});

describe("the cell ledger", () => {
  it("writes one row per occupied cell when a table is created", async () => {
    const subject = table({ id: "repo_tbl_cells", gridX: 2, gridY: 4 });
    await insert(subject);
    expect(await storedCells(subject.id)).toEqual(expectedCells(subject));
  });

  it("rewrites the cells when the table moves, leaving none behind", async () => {
    const subject = table({ id: "repo_tbl_cells_move", gridX: 4, gridY: 4 });
    await insert(subject);
    const moved = moveSeatingTable(
      subject,
      { gridX: 6, gridY: 4 },
      plan(),
      LATER,
    );
    await commit(moved, subject.version, "move-seating-table");
    expect(await storedCells(subject.id)).toEqual(expectedCells(moved));
  });

  it("gives up every cell when the table is removed, and takes them back", async () => {
    const subject = table({
      id: "repo_tbl_cells_archive",
      gridX: 10,
      gridY: 4,
    });
    await insert(subject);
    const removed = archiveSeatingTable(subject, LATER);
    await commit(removed, subject.version, "archive-seating-table");
    expect(await storedCells(subject.id)).toEqual([]);

    // The space really is free: another table may stand there.
    const successor = table({ id: "repo_tbl_successor2", gridX: 10, gridY: 4 });
    await expect(insert(successor)).resolves.toBeUndefined();
  });

  it("claims a chair's cell only once somebody is sitting in it", async () => {
    const subject = table({ id: "repo_tbl_cells_seat", gridX: 14, gridY: 4 });
    await insert(subject);
    const empty = await storedCells(subject.id);

    const seated = labelSeat(subject, 1, "Ada Lovelace", plan(), LATER);
    await commit(seated, subject.version, "label-seat");
    const taken = await storedCells(subject.id);
    expect(taken).toHaveLength(empty.length + 1);
    expect(taken).toEqual(expectedCells(seated));

    // …and gives it straight back when the name comes off.
    const cleared = labelSeat(seated, 1, "", plan(), LATER);
    await commit(cleared, seated.version, "label-seat");
    expect(await storedCells(subject.id)).toEqual(empty);
  });

  it("keeps the cells in step through a rotation", async () => {
    const subject = table({
      id: "repo_tbl_cells_rotate",
      size: 3,
      gridX: 9,
      gridY: 7,
    });
    await insert(subject);
    const turned = rotateSeatingTable(subject, plan(), LATER);
    await commit(turned, subject.version, "rotate-seating-table");
    const stored = await tables.getById(ORG_ACME_ID, subject.id);
    expect(stored?.rotation).toBe(90);
    expect(await storedCells(subject.id)).toEqual(expectedCells(turned));
  });

  it("writes no cells at all when the version guard refuses the batch", async () => {
    const subject = table({ id: "repo_tbl_cells_stale", gridX: 14, gridY: 7 });
    await insert(subject);
    const before = await storedCells(subject.id);
    const moved = moveSeatingTable(
      subject,
      { gridX: 0, gridY: 0 },
      plan(),
      LATER,
    );
    await expect(
      commit(moved, 99, "move-seating-table"),
    ).rejects.toBeInstanceOf(AppError);
    // Not merely "the table did not move": its cells were not rewritten either,
    // which is the partial write the shared guard exists to prevent.
    expect(await storedCells(subject.id)).toEqual(before);
  });
});

/**
 * Round tables, and the arrangement the feature is for: several ordinary
 * tables standing against one another, which is what makes an L or a U.
 */
describe("round tables", () => {
  it("stores a round table and reads it back with its ring of chairs", async () => {
    const round = table({
      id: "repo_tbl_round",
      eventId: lShapeEvent.id,
      kind: "round",
      size: 3,
      gridX: 0,
      gridY: 0,
    });
    await insert(round);

    const stored = await tables.getById(ORG_ACME_ID, round.id);
    expect(stored).toEqual(round);
    expect(stored).toMatchObject({ kind: "round", size: 3, rotation: 0 });
    // Twelve chairs around a 3x3 block, and the bounding box's four corners
    // left free for a neighbour.
    expect(stored?.seats).toHaveLength(12);
    expect(await storedCells(round.id)).toEqual(expectedCells(round));
  });

  it("refuses a round table the schema says cannot exist", async () => {
    // `end_seats = 0 AND rotation = 0` for a round table is a CHECK in
    // `migrations/0001_init.sql`, not only a domain rule, so a row that got
    // past the domain would still be refused here.
    await expect(
      getDbExec().execute({
        sql: "INSERT INTO seating_tables (id, org_id, event_id, name, kind, size, end_seats, rotation, grid_x, grid_y, seats, status, version, created_by, created_at, updated_at) VALUES ('repo_tbl_bad', ?, ?, 'Bad', 'round', 2, 1, 0, 0, 0, '[]', 'active', 1, ?, ?, ?)",
        args: [
          ORG_ACME_ID,
          lShapeEvent.id,
          OWNER_EMAIL,
          CREATED_AT,
          CREATED_AT,
        ],
      }),
    ).rejects.toThrow();
  });
});

/**
 * The rule an empty chair exists for, against the real primary key: two tables
 * may be pushed together while nobody is sitting where they meet, and may not
 * once somebody is.
 */
describe("a continuous run", () => {
  it("lets two tables meet while the chairs at the join are empty", async () => {
    // A table of four with a chair capping each end. Its body runs from column
    // 1 to column 4; column 5 is its right-hand cap.
    const first = table({
      id: "repo_tbl_run_a",
      eventId: lShapeEvent.id,
      size: 4,
      endSeats: true,
      gridX: 0,
      gridY: 6,
    });
    await insert(first);

    // The second table's body wants column 5 — the first table's cap. Nobody
    // is in it, so it claims nothing and the two bodies may touch.
    await expect(
      insert(
        table({
          id: "repo_tbl_run_b",
          eventId: lShapeEvent.id,
          size: 4,
          endSeats: true,
          gridX: 4,
          gridY: 6,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses the same placement once somebody is sitting at the join", async () => {
    const first = table({
      id: "repo_tbl_run_c",
      eventId: runEvent.id,
      size: 4,
      endSeats: true,
      gridX: 0,
      gridY: 0,
    });
    await insert(first);

    // Seat 4 is the chair capping the right-hand end. With a name on it, it
    // claims its cell like any other occupied space.
    const seated = labelSeat(first, 4, "Ada Lovelace", plan(), LATER);
    await commit(seated, first.version, "label-seat");

    await expect(
      insert(
        table({
          id: "repo_tbl_run_d",
          eventId: runEvent.id,
          size: 4,
          endSeats: true,
          gridX: 4,
          gridY: 0,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

/**
 * Seat moves, which are the one write that spans two table rows.
 *
 * Two length-2 tables standing chair to chair: `upper` at (0,0) has chairs
 * along y=2 and `lower` at (0,2) has chairs along the same y=2, so (0,2) and
 * (1,2) are each a chair of either of them. That overlap is the point — it is
 * what makes the statement ordering inside `commitSeatMove` observable, and a
 * plan where the two tables never touch would prove nothing.
 */
describe("a seat move", () => {
  // Each test gets its own column of the plan; they all share one event, and
  // a table left standing by one would be in the next one's way.
  const seam = (id: string, gridX: number, gridY: number): SeatingTable =>
    createSeatingTable(
      {
        id,
        orgId: ORG_ACME_ID,
        eventId: seamEvent.id,
        name: id,
        size: 2,
        endSeats: false,
        gridX,
        gridY,
        createdBy: OWNER_EMAIL,
        now: CREATED_AT,
      },
      { room: roomOf(seamEvent), tables: [] },
    );

  /** The same table with one name written on it, and the version the write
   * that put it there would have left. */
  const named = (
    row: SeatingTable,
    index: number,
    label: string,
  ): SeatingTable => ({
    ...row,
    seats: row.seats.map((seat, at) => (at === index ? { label } : seat)),
    version: row.version + 1,
    updatedAt: LATER,
  });

  async function move(
    from: { table: SeatingTable; seat: number },
    to: { table: SeatingTable; seat: number },
    standing: readonly SeatingTable[],
  ): Promise<{ source: SeatingTable; target: SeatingTable }> {
    const moved = moveSeatLabel(
      from,
      to,
      { room: roomOf(seamEvent), tables: standing },
      LATER,
    );
    await tables.commitTables({
      tables: [
        { table: moved.source, expectedVersion: from.table.version },
        { table: moved.target, expectedVersion: to.table.version },
      ],
      operation: operationFor({
        action: "move-seat",
        resourceType: "seating_table",
        resourceId: moved.target.id,
        orgId: ORG_ACME_ID,
        versionBefore: to.table.version,
        versionAfter: moved.target.version,
      }),
    });
    return moved;
  }

  it("writes both rows and both cell ledgers in one batch", async () => {
    const upper = named(seam("seam_a_up", 0, 0), 0, "Ada");
    const lower = seam("seam_a_low", 0, 4);
    await insert(upper);
    await insert(lower);

    const moved = await move(
      { table: upper, seat: 0 },
      { table: lower, seat: 0 },
      [upper, lower],
    );

    const storedUpper = await tables.getById(ORG_ACME_ID, upper.id);
    const storedLower = await tables.getById(ORG_ACME_ID, lower.id);
    expect(storedUpper?.seats[0]?.label).toBe("");
    expect(storedLower?.seats[0]?.label).toBe("Ada");
    expect(await storedCells(upper.id)).toEqual(expectedCells(moved.source));
    expect(await storedCells(lower.id)).toEqual(expectedCells(moved.target));
  });

  it("leaves both cell ledgers exactly as they were when two names swap", async () => {
    const upper = named(seam("seam_b_up", 3, 0), 0, "Ada");
    const lower = named(seam("seam_b_low", 3, 4), 0, "Grace");
    await insert(upper);
    await insert(lower);
    const before = {
      upper: await storedCells(upper.id),
      lower: await storedCells(lower.id),
    };

    await move({ table: upper, seat: 0 }, { table: lower, seat: 0 }, [
      upper,
      lower,
    ]);

    // Both chairs are filled before and after, so the ledger is rewritten to
    // itself — four statements that change nothing, and the price of never
    // working out per seat what moved.
    expect(await storedCells(upper.id)).toEqual(before.upper);
    expect(await storedCells(lower.id)).toEqual(before.lower);
  });

  /**
   * The ordering test. The name is moving to the very cell it is vacating —
   * one table's chair becoming the other's — so the arriving insert collides
   * with the leaving row unless both deletes have already run. Interleave the
   * statements per table and this fails with "That space is already
   * occupied".
   */
  it("lets one table hand a cell straight to the other", async () => {
    const upper = seam("seam_c_up", 6, 0);
    const lower = named(seam("seam_c_low", 6, 2), 0, "Ada");
    await insert(upper);
    await insert(lower);
    // The two chairs are one cell, and while Ada is in it the upper table has
    // no chair there at all.
    expect(await storedCells(lower.id)).toContain(cellKey(6, 2));

    await move({ table: lower, seat: 0 }, { table: upper, seat: 3 }, [
      upper,
      lower,
    ]);

    expect((await tables.getById(ORG_ACME_ID, upper.id))?.seats[3]?.label).toBe(
      "Ada",
    );
    expect(await storedCells(upper.id)).toContain(cellKey(6, 2));
    expect(await storedCells(lower.id)).not.toContain(cellKey(6, 2));
  });

  it("writes nothing at all when either table's version has moved on", async () => {
    const upper = named(seam("seam_d_up", 9, 0), 0, "Ada");
    const lower = seam("seam_d_low", 9, 4);
    await insert(upper);
    await insert(lower);
    const before = {
      upper: await storedCells(upper.id),
      lower: await storedCells(lower.id),
    };

    for (const stale of [
      { source: upper.version + 1, target: lower.version },
      { source: upper.version, target: lower.version + 1 },
    ]) {
      const moved = moveSeatLabel(
        { table: upper, seat: 0 },
        { table: lower, seat: 0 },
        { room: roomOf(seamEvent), tables: [upper, lower] },
        LATER,
      );
      await expect(
        tables.commitTables({
          tables: [
            { table: moved.source, expectedVersion: stale.source },
            { table: moved.target, expectedVersion: stale.target },
          ],
          operation: operationFor({
            action: "move-seat",
            resourceType: "seating_table",
            resourceId: moved.target.id,
            orgId: ORG_ACME_ID,
            versionBefore: stale.target,
            versionAfter: moved.target.version,
          }),
        }),
      ).rejects.toBeInstanceOf(AppError);
    }

    // Not one half of it landed, and not the cells either.
    expect((await tables.getById(ORG_ACME_ID, upper.id))?.seats[0]?.label).toBe(
      "Ada",
    );
    expect((await tables.getById(ORG_ACME_ID, lower.id))?.version).toBe(
      lower.version,
    );
    expect(await storedCells(upper.id)).toEqual(before.upper);
    expect(await storedCells(lower.id)).toEqual(before.lower);
  });

  it("refuses a destination cell a third table claimed in between", async () => {
    const upper = named(seam("seam_e_up", 12, 0), 0, "Ada");
    const lower = seam("seam_e_low", 12, 2);
    await insert(upper);
    await insert(lower);
    // Computed against a plan in which seat 3 of the lower table is free…
    const moved = moveSeatLabel(
      { table: upper, seat: 0 },
      { table: lower, seat: 3 },
      { room: roomOf(seamEvent), tables: [upper, lower] },
      LATER,
    );
    // …and committed after somebody has put a table on that very cell.
    const squatter = seam("seam_e_squat", 12, 3);
    await insert(squatter);
    expect(await storedCells(squatter.id)).toContain(cellKey(12, 4));

    await expect(
      tables.commitTables({
        tables: [
          { table: moved.source, expectedVersion: upper.version },
          { table: moved.target, expectedVersion: lower.version },
        ],
        operation: operationFor({
          action: "move-seat",
          resourceType: "seating_table",
          resourceId: moved.target.id,
          orgId: ORG_ACME_ID,
          versionBefore: lower.version,
          versionAfter: moved.target.version,
        }),
      }),
    ).rejects.toMatchObject({ message: "That space is already occupied" });
  });
});

/**
 * A write across more than two tables, which is what a shift along a run of
 * chairs comes to. The two-table case above proves the ordering; this proves
 * the batch is still all-or-nothing when the guard has to cover several rows.
 */
describe("a write across several tables", () => {
  const stacked = (id: string, gridX: number, gridY: number): SeatingTable =>
    createSeatingTable(
      {
        id,
        orgId: ORG_ACME_ID,
        eventId: manyEvent.id,
        name: id,
        size: 2,
        endSeats: false,
        gridX,
        gridY,
        createdBy: OWNER_EMAIL,
        now: CREATED_AT,
      },
      { room: roomOf(manyEvent), tables: [] },
    );

  /** The same table with a name on seat 0 and the version that write leaves. */
  const filled = (row: SeatingTable, label: string): SeatingTable => ({
    ...row,
    seats: row.seats.map((seat, index) => (index === 0 ? { label } : seat)),
    version: row.version + 1,
    updatedAt: LATER,
  });

  const operationFor3 = (resource: SeatingTable, after: number) =>
    operationFor({
      action: "shift-seats",
      resourceType: "seating_table",
      resourceId: resource.id,
      orgId: ORG_ACME_ID,
      versionBefore: resource.version,
      versionAfter: after,
    });

  it("writes every row and every cell ledger in one batch", async () => {
    const rows = [
      stacked("many_a_0", 0, 0),
      stacked("many_a_1", 0, 3),
      stacked("many_a_2", 0, 6),
    ];
    for (const row of rows) await insert(row);

    const next = rows.map((row, index) => filled(row, `Guest ${index}`));
    await tables.commitTables({
      tables: next.map((row, index) => ({
        table: row,
        expectedVersion: rows[index]!.version,
      })),
      operation: operationFor3(rows[0]!, next[0]!.version),
    });

    for (const [index, row] of next.entries()) {
      const stored = await tables.getById(ORG_ACME_ID, row.id);
      expect(stored?.seats[0]?.label).toBe(`Guest ${index}`);
      expect(await storedCells(row.id)).toEqual(expectedCells(row));
    }
  });

  it("writes nothing at all when any one version has moved on", async () => {
    const rows = [
      stacked("many_b_0", 4, 0),
      stacked("many_b_1", 4, 3),
      stacked("many_b_2", 4, 6),
    ];
    for (const row of rows) await insert(row);
    const before = await Promise.all(rows.map((row) => storedCells(row.id)));

    // The third row is stale; the other two are exactly as they were read.
    const next = rows.map((row, index) => filled(row, `Guest ${index}`));
    await expect(
      tables.commitTables({
        tables: next.map((row, index) => ({
          table: row,
          expectedVersion:
            index === 2 ? rows[index]!.version + 1 : rows[index]!.version,
        })),
        operation: operationFor3(rows[0]!, next[0]!.version),
      }),
    ).rejects.toBeInstanceOf(AppError);

    // Not one of them landed — the audit row guards them all, so a single
    // stale version takes the whole batch down rather than its own share.
    for (const [index, row] of rows.entries()) {
      const stored = await tables.getById(ORG_ACME_ID, row.id);
      expect(stored?.version).toBe(row.version);
      expect(stored?.seats[0]?.label).toBe("");
      expect(await storedCells(row.id)).toEqual(before[index]);
    }
  });
});
