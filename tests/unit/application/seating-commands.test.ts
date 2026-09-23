/**
 * The nine event and seating use cases (blueprint B8), against the in-memory
 * dependencies and the fixed B12 scenario.
 *
 * The same five axes as `commands.test.ts` — the right resource, the right
 * operation row, a role that may not, an id from another organization, and a
 * stale `expectedVersion` — plus the one this feature adds: the floor plan's
 * no-overlap rule is enforced by the *write*, not by the read before it, so
 * there is a test that lets somebody else take the space in between and
 * asserts the commit refuses.
 */

import { describe, expect, it } from "vitest";

import type { Actor } from "../../../src/application/actor";
import { AppError } from "../../../src/application/errors";
import { archiveEvent } from "../../../src/application/use-cases/archive-event";
import { archiveSeatingTable } from "../../../src/application/use-cases/archive-seating-table";
import { createEvent } from "../../../src/application/use-cases/create-event";
import { createSeatingTable } from "../../../src/application/use-cases/create-seating-table";
import { getEvent } from "../../../src/application/use-cases/get-event";
import { labelSeat } from "../../../src/application/use-cases/label-seat";
import { listEvents } from "../../../src/application/use-cases/list-events";
import { moveSeat } from "../../../src/application/use-cases/move-seat";
import { moveSeatingTable } from "../../../src/application/use-cases/move-seating-table";
import { reshapeSeatingTable } from "../../../src/application/use-cases/reshape-seating-table";
import { shiftSeats } from "../../../src/application/use-cases/shift-seats";
import {
  archiveEvent as archiveEventDomain,
  findSeat,
} from "../../../src/domain";
import {
  createInMemoryDependencies,
  type InMemoryDependencies,
} from "../../fixtures/in-memory";
import {
  seedInMemory,
  ADMIN_EMAIL,
  EVENT_ARCHIVED_ID,
  EVENT_GALA_ID,
  EVENT_GALA_NAME,
  EVENT_OTHER_ID,
  MEMBER1_EMAIL,
  ORG_ACME_ID,
  OWNER_EMAIL,
  SEAT_LABEL_ADA,
  SEAT_LABEL_GRACE,
  TABLE_HEAD_ID,
  TABLE_OTHER_ID,
  TABLE_SIDE_ID,
} from "../../fixtures/scenario";

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userEmail: MEMBER1_EMAIL,
    orgId: ORG_ACME_ID,
    role: "member",
    caller: "test",
    ...overrides,
  };
}

function deps(ids?: string[]): InMemoryDependencies {
  const dependencies = createInMemoryDependencies(
    ids ? { ids } : {},
  ) as InMemoryDependencies;
  seedInMemory(dependencies);
  return dependencies;
}

describe("listEvents", () => {
  it("leaves archived events out by default and includes them on request", async () => {
    const d = deps();
    const active = await listEvents(d, actor(), {});
    expect(active.map((e) => e.id)).toEqual([EVENT_GALA_ID]);

    const all = await listEvents(d, actor(), { includeArchived: true });
    expect(all.map((e) => e.id).sort()).toEqual(
      [EVENT_ARCHIVED_ID, EVENT_GALA_ID].sort(),
    );
  });

  it("never returns another organization's events", async () => {
    const d = deps();
    const events = await listEvents(d, actor(), { includeArchived: true });
    expect(events.some((e) => e.id === EVENT_OTHER_ID)).toBe(false);
  });
});

describe("getEvent", () => {
  it("returns the event with its active tables", async () => {
    const d = deps();
    const detail = await getEvent(d, actor(), { eventId: EVENT_GALA_ID });
    expect(detail.event.name).toBe(EVENT_GALA_NAME);
    expect(detail.tables.map((t) => t.id)).toEqual([
      TABLE_HEAD_ID,
      TABLE_SIDE_ID,
    ]);
  });

  it("leaves a removed table out of the floor plan", async () => {
    const d = deps();
    await archiveSeatingTable(d, actor(), { tableId: TABLE_SIDE_ID });
    const detail = await getEvent(d, actor(), { eventId: EVENT_GALA_ID });
    expect(detail.tables.map((t) => t.id)).toEqual([TABLE_HEAD_ID]);
  });

  it("reports another organization's event as NOT_FOUND", async () => {
    const d = deps();
    await expect(
      getEvent(d, actor(), { eventId: EVENT_OTHER_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("createEvent", () => {
  it("writes the event and a compensatable create operation", async () => {
    const d = deps(["evt_new", "op_new"]);
    const result = await createEvent(d, actor(), {
      name: "Autumn dinner",
      startsAt: "2026-11-01T18:00:00.000Z",
    });
    expect(result.resource).toMatchObject({
      id: "evt_new",
      orgId: ORG_ACME_ID,
      name: "Autumn dinner",
      status: "active",
      version: 1,
    });
    expect(d.state.operations.get("op_new")).toMatchObject({
      action: "create-event",
      resourceType: "event",
      classification: "compensatable",
      versionBefore: 0,
      versionAfter: 1,
      inverse: { type: "archive-event" },
    });
  });

  it("returns the first event again for a repeated idempotency key", async () => {
    const d = deps(["evt_new", "op_new", "evt_second", "op_second"]);
    const args = {
      name: "Autumn dinner",
      startsAt: "2026-11-01T18:00:00.000Z",
      idempotencyKey: "key-1",
    };
    const first = await createEvent(d, actor(), args);
    const second = await createEvent(d, actor(), args);
    expect(second).toEqual(first);
    expect(d.state.events.has("evt_second")).toBe(false);
  });
});

describe("archiveEvent", () => {
  it("is refused for a member and allowed for an admin", async () => {
    const d = deps();
    await expect(
      archiveEvent(d, actor(), { eventId: EVENT_GALA_ID }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });

    const result = await archiveEvent(
      d,
      actor({ userEmail: ADMIN_EMAIL, role: "admin" }),
      { eventId: EVENT_GALA_ID },
    );
    expect(result.resource.status).toBe("archived");
  });

  it("refuses a stale expectedVersion", async () => {
    const d = deps();
    await expect(
      archiveEvent(d, actor({ role: "admin" }), {
        eventId: EVENT_GALA_ID,
        expectedVersion: 99,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("createSeatingTable", () => {
  it("drops the table into the first free spot when no position is given", async () => {
    const d = deps(["tbl_new", "op_new"]);
    const result = await createSeatingTable(d, actor(), {
      eventId: EVENT_GALA_ID,
      name: "Table 3",
      size: 2,
    });
    // `tbl_head` has end seats, so its bounding box spans columns 0–3 but its
    // top-left corner at (0,0) holds nothing. A two-wide table needs two whole
    // columns though, and `tbl_side` fills 4–7, so the first free spot is 8.
    expect(result.resource).toMatchObject({ gridX: 8, gridY: 0 });
    expect(d.state.operations.get("op_new")).toMatchObject({
      action: "create-seating-table",
      resourceType: "seating_table",
      classification: "compensatable",
      inverse: { type: "archive-seating-table" },
      payload: { gridX: 8, gridY: 0 },
    });
  });

  it("refuses an explicit position that overlaps an existing table", async () => {
    const d = deps(["tbl_new", "op_new"]);
    await expect(
      createSeatingTable(d, actor(), {
        eventId: EVENT_GALA_ID,
        name: "Table 3",
        size: 2,
        gridX: 1,
        gridY: 0,
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  });

  it("refuses one coordinate without the other", async () => {
    const d = deps(["tbl_new", "op_new"]);
    await expect(
      createSeatingTable(d, actor(), {
        eventId: EVENT_GALA_ID,
        name: "Table 3",
        size: 2,
        gridX: 8,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses an archived event and another organization's event alike", async () => {
    const d = deps(["a", "b", "c", "d"]);
    for (const eventId of [EVENT_ARCHIVED_ID, EVENT_OTHER_ID]) {
      await expect(
        createSeatingTable(d, actor(), {
          eventId,
          name: "Table 3",
          size: 2,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
});

describe("moveSeatingTable", () => {
  it("moves the table and records the position it came from", async () => {
    const d = deps(["op_move"]);
    const result = await moveSeatingTable(d, actor(), {
      tableId: TABLE_SIDE_ID,
      gridX: 4,
      gridY: 4,
      expectedVersion: 1,
    });
    expect(result.resource).toMatchObject({ gridX: 4, gridY: 4, version: 2 });
    expect(d.state.operations.get("op_move")).toMatchObject({
      action: "move-seating-table",
      classification: "reversible",
      versionBefore: 1,
      versionAfter: 2,
      payload: { gridX: 4, gridY: 4 },
      inverse: {
        type: "restore-seating-table-position",
        previous: { gridX: 4, gridY: 0 },
      },
    });
  });

  it("refuses a move onto its neighbour", async () => {
    const d = deps(["op_move"]);
    await expect(
      moveSeatingTable(d, actor(), {
        tableId: TABLE_SIDE_ID,
        gridX: 2,
        gridY: 0,
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  });

  /**
   * The reason the guard lives in the SQL. Both callers read a floor plan in
   * which the cell is free; the second write has to lose. Without the
   * predicate inside the statement this test passes the domain check and
   * produces an overlapping plan.
   */
  it("refuses the write when somebody takes the space between the check and the commit", async () => {
    const d = deps(["op_move"]);
    const squatter = d.state.seatingTables.get(TABLE_HEAD_ID);
    d.state.beforeSeatingTableCommit = () => {
      d.state.seatingTables.set(TABLE_HEAD_ID, {
        ...squatter!,
        gridX: 4,
        gridY: 4,
        version: squatter!.version + 1,
      });
    };
    await expect(
      moveSeatingTable(d, actor(), {
        tableId: TABLE_SIDE_ID,
        gridX: 4,
        gridY: 4,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(d.state.seatingTables.get(TABLE_SIDE_ID)?.gridX).toBe(4);
    expect(d.state.seatingTables.get(TABLE_SIDE_ID)?.gridY).toBe(0);
  });

  it("refuses another organization's table as NOT_FOUND, never AUTHORIZATION", async () => {
    const d = deps(["op_move"]);
    await expect(
      moveSeatingTable(d, actor(), {
        tableId: TABLE_OTHER_ID,
        gridX: 8,
        gridY: 4,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a stale expectedVersion", async () => {
    const d = deps(["op_move"]);
    await expect(
      moveSeatingTable(d, actor(), {
        tableId: TABLE_SIDE_ID,
        gridX: 4,
        gridY: 4,
        expectedVersion: 99,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("reshapeSeatingTable", () => {
  it("records the whole previous seat layout as its inverse", async () => {
    const d = deps(["op_reshape"]);
    const before = d.state.seatingTables.get(TABLE_HEAD_ID)!;
    const result = await reshapeSeatingTable(d, actor(), {
      tableId: TABLE_HEAD_ID,
      kind: "rectangle",
      size: 1,
      endSeats: false,
      expectedVersion: before.version,
    });
    expect(result.resource).toMatchObject({
      kind: "rectangle",
      size: 1,
      endSeats: false,
    });
    // Seat 0 is the first along the far side whichever length the table is, so
    // Ada keeps her chair through a shortening.
    expect(findSeat(result.resource, 0)?.label).toBe(SEAT_LABEL_ADA);
    expect(d.state.operations.get("op_reshape")).toMatchObject({
      action: "reshape-seating-table",
      payload: { kind: "rectangle", size: 1, endSeats: false },
      inverse: {
        type: "restore-seating-table-shape",
        previous: {
          kind: "rectangle",
          size: 2,
          endSeats: true,
          seats: before.seats,
        },
      },
    });
  });

  it("refuses a growth that would reach into the neighbour", async () => {
    const d = deps(["op_reshape"]);
    await expect(
      reshapeSeatingTable(d, actor(), {
        tableId: TABLE_HEAD_ID,
        kind: "rectangle",
        size: 6,
        endSeats: true,
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  });
});

describe("labelSeat", () => {
  it("writes the label and records the one it replaced", async () => {
    const d = deps(["op_label"]);
    const before = d.state.seatingTables.get(TABLE_HEAD_ID)!;
    const result = await labelSeat(d, actor(), {
      tableId: TABLE_HEAD_ID,
      seat: 0,
      label: "Katherine Johnson",
      expectedVersion: before.version,
    });
    expect(findSeat(result.resource, 0)?.label).toBe("Katherine Johnson");
    expect(d.state.operations.get("op_label")).toMatchObject({
      action: "label-seat",
      classification: "reversible",
      payload: { seat: 0, label: "Katherine Johnson" },
      inverse: {
        type: "restore-seat-label",
        seat: 0,
        previousLabel: SEAT_LABEL_ADA,
      },
    });
  });

  it("refuses a seat number the table does not have", async () => {
    const d = deps(["op_label"]);
    await expect(
      labelSeat(d, actor(), {
        tableId: TABLE_SIDE_ID,
        seat: 99,
        label: "Nobody",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("moveSeat", () => {
  it("moves a name to another table, writing both rows under one operation", async () => {
    const d = deps(["op_move_seat"]);
    const head = d.state.seatingTables.get(TABLE_HEAD_ID)!;
    const side = d.state.seatingTables.get(TABLE_SIDE_ID)!;
    const result = await moveSeat(d, actor(), {
      fromTableId: TABLE_HEAD_ID,
      fromSeat: 0,
      toTableId: TABLE_SIDE_ID,
      toSeat: 0,
      fromExpectedVersion: head.version,
      toExpectedVersion: side.version,
    });

    expect(findSeat(result.resource, 0)?.label).toBe(SEAT_LABEL_ADA);
    expect(findSeat(d.state.seatingTables.get(TABLE_HEAD_ID)!, 0)?.label).toBe(
      "",
    );
    expect(findSeat(d.state.seatingTables.get(TABLE_SIDE_ID)!, 0)?.label).toBe(
      SEAT_LABEL_ADA,
    );
    // One intent, one row — and the second table's guard rides in the
    // payload, because `versionBefore`/`versionAfter` can only speak for the
    // resource.
    expect(d.state.operations.get("op_move_seat")).toMatchObject({
      action: "move-seat",
      classification: "reversible",
      resourceId: TABLE_SIDE_ID,
      versionBefore: side.version,
      versionAfter: side.version + 1,
      payload: {
        fromTableId: TABLE_HEAD_ID,
        fromSeat: 0,
        toTableId: TABLE_SIDE_ID,
        toSeat: 0,
        label: SEAT_LABEL_ADA,
        others: [
          {
            tableId: TABLE_HEAD_ID,
            versionBefore: head.version,
            versionAfter: head.version + 1,
          },
        ],
      },
      inverse: {
        type: "restore-seat-placement",
        from: { tableId: TABLE_HEAD_ID, seat: 0, label: SEAT_LABEL_ADA },
        to: { tableId: TABLE_SIDE_ID, seat: 0, label: "" },
      },
    });
  });

  it("swaps two names rather than overwriting either", async () => {
    const d = deps(["op_move_seat"]);
    await moveSeat(d, actor(), {
      fromTableId: TABLE_HEAD_ID,
      fromSeat: 0,
      toTableId: TABLE_HEAD_ID,
      toSeat: 1,
    });
    const head = d.state.seatingTables.get(TABLE_HEAD_ID)!;
    expect(findSeat(head, 0)?.label).toBe(SEAT_LABEL_GRACE);
    expect(findSeat(head, 1)?.label).toBe(SEAT_LABEL_ADA);
  });

  it("writes one row and one version for a move within one table", async () => {
    const d = deps(["op_move_seat"]);
    const before = d.state.seatingTables.get(TABLE_HEAD_ID)!;
    await moveSeat(d, actor(), {
      fromTableId: TABLE_HEAD_ID,
      fromSeat: 0,
      toTableId: TABLE_HEAD_ID,
      toSeat: 2,
    });
    // Both halves landed on one object, so the version moved by one and not
    // by two — the arithmetic is the assertion that it was a single write.
    expect(d.state.seatingTables.get(TABLE_HEAD_ID)!.version).toBe(
      before.version + 1,
    );
    expect(d.state.operations.get("op_move_seat")?.payload).toMatchObject({
      others: [],
    });
  });

  it("refuses a pair of tables at two different events", async () => {
    // A floor plan belongs to an event, so two tables at different events have
    // no common floor for the two cells to be compared on.
    const d = deps(["evt_two", "op_event", "tbl_elsewhere", "op_table"]);
    const other = await createEvent(d, actor({ role: "admin" }), {
      name: "Another evening",
      startsAt: "2026-12-01T18:00:00.000Z",
    });
    await createSeatingTable(d, actor(), {
      eventId: other.resource.id,
      name: "Table A",
      size: 2,
      gridX: 0,
      gridY: 0,
    });
    await expect(
      moveSeat(d, actor(), {
        fromTableId: TABLE_HEAD_ID,
        fromSeat: 0,
        toTableId: "tbl_elsewhere",
        toSeat: 0,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("reports a table from another organization as missing, on either side", async () => {
    const d = deps(["op_move_seat"]);
    await expect(
      moveSeat(d, actor(), {
        fromTableId: TABLE_OTHER_ID,
        fromSeat: 0,
        toTableId: TABLE_HEAD_ID,
        toSeat: 2,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      moveSeat(d, actor(), {
        fromTableId: TABLE_HEAD_ID,
        fromSeat: 0,
        toTableId: TABLE_OTHER_ID,
        toSeat: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a stale version on either table", async () => {
    const d = deps(["op_move_seat"]);
    const head = d.state.seatingTables.get(TABLE_HEAD_ID)!;
    const side = d.state.seatingTables.get(TABLE_SIDE_ID)!;
    const args = {
      fromTableId: TABLE_HEAD_ID,
      fromSeat: 0,
      toTableId: TABLE_SIDE_ID,
      toSeat: 0,
    };
    await expect(
      moveSeat(d, actor(), {
        ...args,
        fromExpectedVersion: head.version + 1,
        toExpectedVersion: side.version,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      moveSeat(d, actor(), {
        ...args,
        fromExpectedVersion: head.version,
        toExpectedVersion: side.version + 1,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  /**
   * The same window `moveSeatingTable` has, reached the other way round. The
   * destination chair is empty, so it claims nothing and another table may
   * legally stand in it — right up until somebody is seated there, which is
   * the moment the cell is claimed. Both writers read a plan in which that is
   * fine; the second has to lose.
   */
  it("refuses when a table takes the destination's cell in between", async () => {
    const d = deps(["tbl_third", "op_create", "op_move_seat"]);
    await createSeatingTable(d, actor(), {
      eventId: EVENT_GALA_ID,
      name: "Table 3",
      size: 2,
      endSeats: false,
      gridX: 10,
      gridY: 5,
    });
    d.state.beforeSeatingTableCommit = () => {
      const third = d.state.seatingTables.get("tbl_third")!;
      // Its body now covers the cell seat 7 of the side table sits in.
      d.state.seatingTables.set("tbl_third", {
        ...third,
        gridX: 4,
        gridY: 1,
        version: third.version + 1,
      });
    };
    await expect(
      moveSeat(d, actor(), {
        fromTableId: TABLE_HEAD_ID,
        fromSeat: 0,
        toTableId: TABLE_SIDE_ID,
        toSeat: 7,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Nothing of the move landed: not the half that was leaving either.
    expect(findSeat(d.state.seatingTables.get(TABLE_HEAD_ID)!, 0)?.label).toBe(
      SEAT_LABEL_ADA,
    );
  });
});

describe("shiftSeats", () => {
  it("moves everybody along and stops at the first empty chair", async () => {
    const d = deps(["op_shift"]);
    const before = d.state.seatingTables.get(TABLE_HEAD_ID)!;
    // Ada is on seat 0 and Grace on seat 1; seat 2 is the first free chair.
    const result = await shiftSeats(d, actor(), {
      tableId: TABLE_HEAD_ID,
      seat: 0,
      towardTableId: TABLE_HEAD_ID,
      towardSeat: 1,
      expectedVersion: before.version,
    });

    expect(findSeat(result.resource, 0)?.label).toBe("");
    expect(findSeat(result.resource, 1)?.label).toBe(SEAT_LABEL_ADA);
    expect(findSeat(result.resource, 2)?.label).toBe(SEAT_LABEL_GRACE);
    expect(d.state.operations.get("op_shift")).toMatchObject({
      action: "shift-seats",
      classification: "reversible",
      resourceId: TABLE_HEAD_ID,
      payload: {
        tableId: TABLE_HEAD_ID,
        seat: 0,
        towardTableId: TABLE_HEAD_ID,
        towardSeat: 1,
        others: [],
      },
      inverse: {
        type: "restore-seat-labels",
        seats: [
          { tableId: TABLE_HEAD_ID, seat: 0, label: SEAT_LABEL_ADA },
          { tableId: TABLE_HEAD_ID, seat: 1, label: SEAT_LABEL_GRACE },
          { tableId: TABLE_HEAD_ID, seat: 2, label: "" },
        ],
      },
    });
  });

  it("shifts the other way round the same table", async () => {
    const d = deps(["op_shift"]);
    // Seat 5 is the chair on Ada's other side, round the end of the table.
    const result = await shiftSeats(d, actor(), {
      tableId: TABLE_HEAD_ID,
      seat: 0,
      towardTableId: TABLE_HEAD_ID,
      towardSeat: 5,
    });
    expect(findSeat(result.resource, 0)?.label).toBe("");
    expect(findSeat(result.resource, 5)?.label).toBe(SEAT_LABEL_ADA);
    expect(findSeat(result.resource, 1)?.label).toBe(SEAT_LABEL_GRACE);
  });

  /** The chain follows the furniture, so once two tables are pushed together
   * a shift runs straight off one and on to the next — and then there are two
   * rows to write, under one operation. */
  it("carries on to the next table when the two are pushed together", async () => {
    const d = deps(["op_move", "op_shift"]);
    await moveSeatingTable(d, actor(), {
      tableId: TABLE_SIDE_ID,
      gridX: 3,
      gridY: 0,
    });
    const side = d.state.seatingTables.get(TABLE_SIDE_ID)!;

    await shiftSeats(d, actor(), {
      tableId: TABLE_HEAD_ID,
      seat: 0,
      towardTableId: TABLE_HEAD_ID,
      towardSeat: 1,
    });

    const head = d.state.seatingTables.get(TABLE_HEAD_ID)!;
    expect(findSeat(head, 0)?.label).toBe("");
    expect(findSeat(head, 1)?.label).toBe(SEAT_LABEL_ADA);
    // Grace has gone round on to the next table's first chair.
    expect(findSeat(d.state.seatingTables.get(TABLE_SIDE_ID)!, 0)?.label).toBe(
      SEAT_LABEL_GRACE,
    );
    // One operation, and the second table's guard recorded on it.
    expect(d.state.operations.get("op_shift")).toMatchObject({
      resourceId: TABLE_HEAD_ID,
      payload: {
        others: [
          {
            tableId: TABLE_SIDE_ID,
            versionBefore: side.version,
            versionAfter: side.version + 1,
          },
        ],
      },
    });
  });

  it("turns a full table by one, with nowhere to leave a gap", async () => {
    const d = deps(["op_shift"]);
    const head = d.state.seatingTables.get(TABLE_HEAD_ID)!;
    d.state.seatingTables.set(TABLE_HEAD_ID, {
      ...head,
      seats: head.seats.map((seat, index) =>
        seat.label ? seat : { label: `Guest ${index}` },
      ),
    });

    const result = await shiftSeats(d, actor(), {
      tableId: TABLE_HEAD_ID,
      seat: 0,
      towardTableId: TABLE_HEAD_ID,
      towardSeat: 1,
    });
    // Nobody is dropped and nobody is duplicated, and the chair the shift
    // started from is not freed: there is nowhere for a gap to go.
    expect(result.resource.seats.map((seat) => seat.label).sort()).toEqual(
      d.state.seatingTables
        .get(TABLE_HEAD_ID)!
        .seats.map((seat) => seat.label)
        .sort(),
    );
    expect(findSeat(result.resource, 1)?.label).toBe(SEAT_LABEL_ADA);
    expect(findSeat(result.resource, 0)?.label).not.toBe("");
  });

  it("refuses a chair nobody is sitting in", async () => {
    const d = deps(["op_shift"]);
    await expect(
      shiftSeats(d, actor(), {
        tableId: TABLE_HEAD_ID,
        seat: 3,
        towardTableId: TABLE_HEAD_ID,
        towardSeat: 4,
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  });

  it("refuses a direction that is not the next chair along", async () => {
    const d = deps(["op_shift"]);
    await expect(
      shiftSeats(d, actor(), {
        tableId: TABLE_HEAD_ID,
        seat: 0,
        towardTableId: TABLE_HEAD_ID,
        towardSeat: 3,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses another organization's table as NOT_FOUND", async () => {
    const d = deps(["op_shift"]);
    await expect(
      shiftSeats(d, actor(), {
        tableId: TABLE_OTHER_ID,
        seat: 0,
        towardTableId: TABLE_OTHER_ID,
        towardSeat: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a stale version", async () => {
    const d = deps(["op_shift"]);
    const head = d.state.seatingTables.get(TABLE_HEAD_ID)!;
    await expect(
      shiftSeats(d, actor(), {
        tableId: TABLE_HEAD_ID,
        seat: 0,
        towardTableId: TABLE_HEAD_ID,
        towardSeat: 1,
        expectedVersion: head.version + 1,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("archiveSeatingTable", () => {
  it("removes the table and frees its space for another", async () => {
    const d = deps(["op_archive", "tbl_new", "op_create"]);
    await archiveSeatingTable(d, actor(), { tableId: TABLE_HEAD_ID });
    expect(d.state.operations.get("op_archive")).toMatchObject({
      action: "archive-seating-table",
      inverse: { type: "restore-seating-table" },
    });
    const replacement = await createSeatingTable(d, actor(), {
      eventId: EVENT_GALA_ID,
      name: "Table 3",
      size: 2,
      gridX: 0,
      gridY: 0,
    });
    expect(replacement.resource.gridX).toBe(0);
  });
});

describe("authorization", () => {
  it("refuses a seating write before reading anything", async () => {
    const d = deps();
    // The table id does not exist; the capability check still has to be what
    // answers, or a 403/404 difference would tell an outsider what exists.
    d.state.memberships.set(ORG_ACME_ID, new Map());
    await expect(
      moveSeatingTable(
        d,
        { ...actor(), role: "member" },
        { tableId: "tbl_nope", gridX: 1, gridY: 1 },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("does not let an archived event be the parent of a new table", async () => {
    const d = deps(["tbl_new", "op_new"]);
    const gala = d.state.events.get(EVENT_GALA_ID)!;
    d.state.events.set(
      EVENT_GALA_ID,
      archiveEventDomain(gala, "2026-09-07T00:00:00.000Z"),
    );
    await expect(
      createSeatingTable(d, actor({ userEmail: OWNER_EMAIL, role: "owner" }), {
        eventId: EVENT_GALA_ID,
        name: "Table 3",
        size: 2,
        gridX: 8,
        gridY: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
