import { describe, expect, it } from "vitest";

import {
  archiveSeatingTable,
  buildSeats,
  cellKey,
  cellsAt,
  cellsOf,
  createSeatingTable,
  DomainError,
  findSeat,
  firstFreePlacement,
  fitsAt,
  footprintSize,
  isWithinRoom,
  labelSeat,
  layoutOf,
  moveSeatingTable,
  occupiedCellKeys,
  removeSeat,
  reshapeSeatingTable,
  restoreSeat,
  restoreSeatingTable,
  restoreSeatingTablePosition,
  restoreSeatingTableRotation,
  restoreSeatingTableShape,
  restoreSeatLabel,
  restoreSeatPresence,
  rotatedPlacement,
  rotateSeatingTable,
  seatCount,
  seatOffset,
  DEFAULT_ROOM_HEIGHT,
  DEFAULT_ROOM_WIDTH,
  MAX_ROUND_DIAMETER,
  MAX_TABLE_LENGTH,
  normalizeShape,
  type FloorPlan,
  type NewSeatingTableInput,
  type SeatingTable,
  type TableShape,
} from "../../../src/domain";

const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";

/** The default room, since these tests are about tables rather than floors. */
const ROOM = { width: DEFAULT_ROOM_WIDTH, height: DEFAULT_ROOM_HEIGHT };

function plan(tables: readonly SeatingTable[] = []): FloorPlan {
  return { room: ROOM, tables };
}

function baseInput(
  overrides: Partial<NewSeatingTableInput> = {},
): NewSeatingTableInput {
  return {
    id: "tbl_1",
    orgId: "org_1",
    eventId: "evt_1",
    name: "Table 1",
    size: 2,
    endSeats: false,
    gridX: 0,
    gridY: 0,
    createdBy: "owner@example.invalid",
    now,
    ...overrides,
  };
}

function table(overrides: Partial<NewSeatingTableInput> = {}): SeatingTable {
  return createSeatingTable(baseInput(overrides), plan());
}

function shape(overrides: Partial<TableShape> = {}): TableShape {
  return normalizeShape({
    kind: "rectangle",
    size: 2,
    endSeats: false,
    rotation: 0,
    ...overrides,
  });
}

/** The cells a table holds, as a sorted, comparable list. */
function cells(subject: SeatingTable): string[] {
  return cellsOf(subject)
    .map((cell) => cellKey(cell.x, cell.y))
    .sort();
}

/**
 * A shape drawn as text, so a failing assertion shows the actual furniture:
 * `#` is the table body and a digit or letter is that seat's number.
 */
function picture(subject: TableShape): string {
  const layout = layoutOf(subject);
  const grid = Array.from({ length: layout.height }, () =>
    Array.from({ length: layout.width }, () => "."),
  );
  for (const cell of layout.body) grid[cell.y]![cell.x] = "#";
  layout.seats.forEach((cell, index) => {
    grid[cell.y]![cell.x] =
      index < 9 ? String(index + 1) : String.fromCharCode(97 + index - 9);
  });
  return grid.map((row) => row.join("")).join("\n");
}

describe("shapes", () => {
  it("draws a rectangle with a seat on each side of every body cell", () => {
    expect(picture(shape({ size: 4 }))).toBe(
      ["1234", "####", "8765"].join("\n"),
    );
    expect(seatCount(shape({ size: 4 }))).toBe(8);
  });

  it("caps each end of the run when endSeats is on", () => {
    expect(picture(shape({ size: 4, endSeats: true }))).toBe(
      [".1234.", "a####5", ".9876."].join("\n"),
    );
    expect(seatCount(shape({ size: 4, endSeats: true }))).toBe(10);
  });

  /**
   * A round table is a square block of cells with chairs all the way around,
   * which is where its seat count comes from: nothing states it.
   */
  it("draws a round table with chairs on all four sides", () => {
    expect(picture(shape({ kind: "round", size: 2 }))).toBe(
      [".12.", "8##3", "7##4", ".65."].join("\n"),
    );
    expect(picture(shape({ kind: "round", size: 3 }))).toBe(
      [".123.", "c###4", "b###5", "a###6", ".987."].join("\n"),
    );
  });

  it("seats four chairs per cell of diameter", () => {
    for (const size of [1, 2, 3, MAX_ROUND_DIAMETER]) {
      expect(seatCount(shape({ kind: "round", size }))).toBe(4 * size);
    }
  });

  /** A round table has no ends to cap and no direction to face, so neither
   * field can hold a value that means nothing. */
  it("normalises away end seats and rotation for a round table", () => {
    const round = shape({
      kind: "round",
      size: 3,
      endSeats: true,
      rotation: 90,
    });
    expect(round).toMatchObject({ endSeats: false, rotation: 0 });
    expect(seatCount(round)).toBe(12);
  });

  it("turns a rectangle in quarter turns, keeping every seat number", () => {
    const flat = shape({ size: 4, endSeats: true });
    const turned = { ...flat, rotation: 90 as const };
    expect(footprintSize(flat)).toEqual({ width: 6, height: 3 });
    expect(footprintSize(turned)).toEqual({ width: 3, height: 6 });
    expect(picture(turned)).toBe(
      [".a.", "9#1", "8#2", "7#3", "6#4", ".5."].join("\n"),
    );
    // The ring is built unrotated and turned afterwards, so seat 1 is the same
    // chair at every angle — turning a table never moves a guest.
    expect(seatCount(turned)).toBe(seatCount(flat));
  });

  it("keeps a table inside the room by its bounding box", () => {
    const wide = shape({ size: MAX_TABLE_LENGTH, endSeats: true });
    expect(isWithinRoom(wide, ROOM.width - 10, ROOM.height - 3, ROOM)).toBe(
      true,
    );
    expect(isWithinRoom(wide, ROOM.width - 9, 0, ROOM)).toBe(false);
    expect(isWithinRoom(wide, 0, -1, ROOM)).toBe(false);
  });

  /** Rooms belong to events, so the same table is legal in one and not in
   * another. */
  it("measures against the room it is given, not a constant", () => {
    const wide = shape({ size: 6, endSeats: true });
    expect(isWithinRoom(wide, 0, 0, { width: 8, height: 3 })).toBe(true);
    expect(isWithinRoom(wide, 0, 0, { width: 7, height: 3 })).toBe(false);
  });

  it("rejects a size its kind does not allow", () => {
    expect(() => table({ size: 0 })).toThrow(DomainError);
    expect(() => table({ size: 9 })).toThrow(DomainError);
    expect(() => table({ size: 2.5 })).toThrow(DomainError);
    // A round table stops well short of a rectangle's run: past four cells
    // across, nobody can reach the middle.
    expect(() => table({ kind: "round", size: 5 })).toThrow(
      `A round table's diameter must be a whole number of cells between 1 and ${MAX_ROUND_DIAMETER}`,
    );
    expect(table({ kind: "round", size: MAX_ROUND_DIAMETER }).kind).toBe(
      "round",
    );
  });
});

describe("seats", () => {
  it("starts every seat present and unlabelled", () => {
    expect(buildSeats(shape({ size: 2 }))).toEqual([
      { label: "", present: true },
      { label: "", present: true },
      { label: "", present: true },
      { label: "", present: true },
    ]);
  });

  it("carries labels and presence over by number", () => {
    const before = buildSeats(shape({ size: 4 })).map((seat, index) => ({
      label: `seat-${index}`,
      present: index !== 2,
    }));
    const after = buildSeats(shape({ size: 3 }), before);
    expect(after[0]).toEqual({ label: "seat-0", present: true });
    expect(after[2]).toEqual({ label: "seat-2", present: false });
    expect(after).toHaveLength(seatCount(shape({ size: 3 })));
  });

  it("puts each seat where the layout says", () => {
    const rectangle = shape({ size: 2 });
    expect(seatOffset(rectangle, 0)).toEqual({ column: 0, row: 0 });
    expect(seatOffset(rectangle, 2)).toEqual({ column: 1, row: 2 });
    expect(seatOffset(rectangle, 99)).toBeNull();
  });
});

describe("occupancy", () => {
  it("holds its body and every seat that is present", () => {
    expect(cells(table())).toEqual(
      ["0,0", "0,1", "0,2", "1,0", "1,1", "1,2"].sort(),
    );
  });

  it("leaves the corners of the bounding box free when it has end seats", () => {
    const withEnds = table({ size: 2, endSeats: true });
    expect(footprintSize(withEnds)).toEqual({ width: 4, height: 3 });
    expect(cells(withEnds)).toHaveLength(8);
    for (const corner of ["0,0", "3,0", "0,2", "3,2"]) {
      expect(cells(withEnds)).not.toContain(corner);
    }
  });

  it("leaves the corners of a round table free for a neighbour", () => {
    const round = table({ kind: "round", size: 2 });
    // Four body cells and eight chairs, out of a 4x4 bounding box: nobody
    // sits at a corner, so those four cells belong to nobody and a neighbour
    // may stand in them.
    expect(cells(round)).toHaveLength(12);
    for (const corner of ["0,0", "3,0", "0,3", "3,3"]) {
      expect(cells(round)).not.toContain(corner);
    }
  });

  it("frees a cell when a seat is taken away", () => {
    const full = table();
    const trimmed = removeSeat(full, 2, later);
    expect(cells(trimmed)).toHaveLength(cells(full).length - 1);
  });

  it("counts nothing for an archived table, or for itself", () => {
    expect(occupiedCellKeys([archiveSeatingTable(table(), later)]).size).toBe(
      0,
    );
    const subject = table();
    expect(occupiedCellKeys([subject], subject.id).size).toBe(0);
  });

  it("lets two tables share an edge but not a cell", () => {
    const left = table();
    const taken = occupiedCellKeys([left], "other");
    expect(fitsAt(left, left.seats, 2, 0, taken, ROOM)).toBe(true);
    expect(fitsAt(left, left.seats, 1, 0, taken, ROOM)).toBe(false);
  });

  it("finds the first free spot, scanning rows then columns", () => {
    const seats = buildSeats(shape());
    expect(firstFreePlacement(shape(), seats, new Set(), ROOM)).toEqual({
      gridX: 0,
      gridY: 0,
    });
    expect(
      firstFreePlacement(shape(), seats, occupiedCellKeys([table()]), ROOM),
    ).toEqual({ gridX: 2, gridY: 0 });
  });

  it("returns null when the room is full", () => {
    const wall = new Set<string>();
    for (let x = 0; x < ROOM.width; x += 1) {
      for (let y = 0; y < ROOM.height; y += 1) wall.add(cellKey(x, y));
    }
    expect(
      firstFreePlacement(shape(), buildSeats(shape()), wall, ROOM),
    ).toBeNull();
  });

  it("answers for a position the table is not standing in", () => {
    const subject = table();
    expect(
      cellsAt(subject, subject.seats, 5, 5)
        .map((cell) => cellKey(cell.x, cell.y))
        .sort(),
    ).toEqual(["5,5", "5,6", "5,7", "6,5", "6,6", "6,7"].sort());
  });
});

describe("createSeatingTable", () => {
  it("creates an active table at version 1 with its seats", () => {
    expect(table({ size: 2, endSeats: true })).toEqual<SeatingTable>({
      id: "tbl_1",
      orgId: "org_1",
      eventId: "evt_1",
      name: "Table 1",
      kind: "rectangle",
      size: 2,
      endSeats: true,
      rotation: 0,
      gridX: 0,
      gridY: 0,
      seats: buildSeats(shape({ size: 2, endSeats: true })),
      status: "active",
      version: 1,
      createdBy: "owner@example.invalid",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("creates a round table directly", () => {
    const round = table({ kind: "round", size: 3 });
    expect(round).toMatchObject({ kind: "round", size: 3, rotation: 0 });
    expect(round.seats).toHaveLength(12);
  });

  it("rejects a blank name and a fractional cell", () => {
    expect(() => table({ name: "  " })).toThrow(DomainError);
    expect(() => table({ gridX: 1.5 })).toThrow(
      "Table position must be whole, non-negative grid coordinates",
    );
  });

  it("refuses a placement outside the room or on another table's cell", () => {
    expect(() => table({ gridX: ROOM.width - 1, size: 4 })).toThrow(
      `A table must stay inside the ${ROOM.width} by ${ROOM.height} room`,
    );
    expect(() =>
      createSeatingTable(baseInput({ id: "tbl_2" }), plan([table()])),
    ).toThrow("Tables may not overlap");
  });
});

describe("moveSeatingTable", () => {
  it("moves to a free spot and bumps the version once", () => {
    expect(
      moveSeatingTable(table(), { gridX: 4, gridY: 3 }, plan(), later),
    ).toMatchObject({ gridX: 4, gridY: 3, version: 2, updatedAt: later });
  });

  it("refuses a move onto an active neighbour but allows one onto an archived table", () => {
    const neighbour = table({ id: "tbl_2", gridX: 4, gridY: 0 });
    const subject = table();
    expect(() =>
      moveSeatingTable(
        subject,
        { gridX: 4, gridY: 0 },
        plan([neighbour]),
        later,
      ),
    ).toThrow("Tables may not overlap");
    expect(
      moveSeatingTable(
        subject,
        { gridX: 4, gridY: 0 },
        plan([archiveSeatingTable(neighbour, later)]),
        later,
      ),
    ).toMatchObject({ gridX: 4, gridY: 0 });
  });

  it("may move into a cell a neighbour has given up", () => {
    const neighbour = removeSeat(
      table({ id: "tbl_2", size: 4, gridX: 4, gridY: 0 }),
      // Clockwise from the far side, so seat 4 is the near-side cell at 4,2.
      4,
      later,
    );
    const freed = cellsOf(neighbour).map((cell) => cellKey(cell.x, cell.y));
    expect(freed).not.toContain("7,2");
    const subject = table({ size: 1, gridX: 0, gridY: 6 });
    expect(
      moveSeatingTable(
        subject,
        { gridX: 7, gridY: 2 },
        plan([neighbour]),
        later,
      ),
    ).toMatchObject({ gridX: 7, gridY: 2 });
  });

  it("refuses a move off the grid, a no-op, and a removed table", () => {
    expect(() =>
      moveSeatingTable(table(), { gridX: ROOM.width, gridY: 0 }, plan(), later),
    ).toThrow(DomainError);
    expect(() =>
      moveSeatingTable(table(), { gridX: 0, gridY: 0 }, plan(), later),
    ).toThrow("The table is already in that spot");
    expect(() =>
      moveSeatingTable(
        archiveSeatingTable(table(), later),
        { gridX: 4, gridY: 3 },
        plan(),
        later,
      ),
    ).toThrow("Cannot move a table that has been removed");
  });
});

describe("rotateSeatingTable", () => {
  it("turns the table without moving anybody out of their seat", () => {
    const seated = labelSeat(
      table({ size: 4, gridX: 4, gridY: 3 }),
      0,
      "Ada Lovelace",
      later,
    );
    const turned = rotateSeatingTable(seated, plan(), later);
    expect(turned.rotation).toBe(90);
    expect(footprintSize(turned)).toEqual({ width: 3, height: 4 });
    // Same seat number, same person; only where it is drawn has changed.
    expect(findSeat(turned, 0)?.label).toBe("Ada Lovelace");
    expect(turned.seats).toEqual(seated.seats);
    expect(turned.version).toBe(seated.version + 1);
  });

  it("pivots about its centre rather than its corner", () => {
    expect(
      rotatedPlacement(table({ size: 8, gridX: 2, gridY: 3 }), ROOM),
    ).toMatchObject({ gridX: 4, gridY: 1, rotation: 90 });
  });

  it("nudges a table by the edge back inside the room", () => {
    const turned = rotateSeatingTable(
      table({ size: 8, gridX: 0, gridY: 0 }),
      plan(),
      later,
    );
    expect(isWithinRoom(turned, turned.gridX, turned.gridY, ROOM)).toBe(true);
    expect(turned.gridY).toBe(0);
  });

  it("comes back to where it started after four turns, with no creep", () => {
    const subject = table({ size: 5, endSeats: true, gridX: 4, gridY: 2 });
    let turning = subject;
    for (let quarter = 0; quarter < 4; quarter += 1) {
      turning = rotateSeatingTable(turning, plan(), later);
    }
    expect(turning).toMatchObject({
      rotation: 0,
      gridX: subject.gridX,
      gridY: subject.gridY,
    });
  });

  it("refuses to turn into a neighbour, or when removed", () => {
    const subject = table({ size: 4, gridX: 4, gridY: 3 });
    const blocker = table({ id: "tbl_2", size: 2, gridX: 5, gridY: 6 });
    expect(() => rotateSeatingTable(subject, plan([blocker]), later)).toThrow(
      "Tables may not overlap",
    );
    expect(() =>
      rotateSeatingTable(archiveSeatingTable(subject, later), plan(), later),
    ).toThrow("Cannot rotate a table that has been removed");
  });
});

describe("removeSeat and restoreSeat", () => {
  it("takes an empty chair away and puts it back", () => {
    const subject = table();
    const trimmed = removeSeat(subject, 2, later);
    expect(findSeat(trimmed, 2)?.present).toBe(false);
    expect(trimmed.version).toBe(2);

    const back = restoreSeat(trimmed, 2, plan(), later);
    expect(findSeat(back, 2)?.present).toBe(true);
    expect(back.version).toBe(3);
  });

  it("refuses to take away a chair somebody is sitting in", () => {
    const seated = labelSeat(table(), 0, "Ada Lovelace", later);
    expect(() => removeSeat(seated, 0, later)).toThrow(
      "Clear the seat before taking it away",
    );
  });

  it("refuses to label a chair that is not there", () => {
    const trimmed = removeSeat(table(), 0, later);
    expect(() => labelSeat(trimmed, 0, "Ada", later)).toThrow(
      "That seat has been taken away",
    );
  });

  it("refuses a seat number the table does not have", () => {
    expect(() => labelSeat(table(), 99, "Ada", later)).toThrow(
      "This table has no seat 100; it has 4",
    );
  });

  it("refuses a double removal and a pointless restore", () => {
    const trimmed = removeSeat(table(), 0, later);
    expect(() => removeSeat(trimmed, 0, later)).toThrow(
      "That seat has already been taken away",
    );
    expect(() => restoreSeat(table(), 0, plan(), later)).toThrow(
      "That seat is already there",
    );
  });

  it("refuses to put a chair back where another table now stands", () => {
    const trimmed = removeSeat(table({ size: 2 }), 2, later);
    const cell = layoutOf(trimmed).seats[2]!;
    const squatter = table({
      id: "tbl_2",
      size: 1,
      gridX: trimmed.gridX + cell.x,
      gridY: trimmed.gridY + cell.y,
    });
    expect(() => restoreSeat(trimmed, 2, plan([squatter]), later)).toThrow(
      "Tables may not overlap",
    );
  });
});

describe("reshapeSeatingTable", () => {
  it("turns a rectangle into a round table, renumbering the seats", () => {
    const subject = table({ size: 4, endSeats: true, gridX: 0, gridY: 0 });
    expect(subject.seats).toHaveLength(10);
    const round = reshapeSeatingTable(
      subject,
      { kind: "round", size: 3, endSeats: true },
      plan(),
      later,
    );
    // Twelve chairs around a 3x3 block, and `endSeats` normalised away: a
    // round table has no ends.
    expect(round).toMatchObject({ kind: "round", size: 3, endSeats: false });
    expect(round.seats).toHaveLength(12);
    expect(round.seats).toHaveLength(seatCount(round));
  });

  it("keeps the names it can when only the length changes", () => {
    const seated = labelSeat(table({ size: 3 }), 0, "Ada", later);
    const shorter = reshapeSeatingTable(
      seated,
      { kind: "rectangle", size: 2, endSeats: false },
      plan(),
      later,
    );
    expect(findSeat(shorter, 0)?.label).toBe("Ada");
    expect(shorter.seats).toHaveLength(4);
  });

  it("keeps the rotation it was turned to", () => {
    const turned = rotateSeatingTable(
      table({ size: 2, gridX: 4, gridY: 3 }),
      plan(),
      later,
    );
    expect(
      reshapeSeatingTable(
        turned,
        { kind: "rectangle", size: 3, endSeats: false },
        plan(),
        later,
      ).rotation,
    ).toBe(90);
  });

  it("refuses to grow into an occupied neighbour, and refuses a no-op", () => {
    const subject = table({ size: 2 });
    const neighbour = table({ id: "tbl_2", gridX: 2, gridY: 0 });
    expect(() =>
      reshapeSeatingTable(
        subject,
        { kind: "rectangle", size: 4, endSeats: false },
        plan([neighbour]),
        later,
      ),
    ).toThrow("Tables may not overlap");
    expect(() =>
      reshapeSeatingTable(
        subject,
        { kind: "rectangle", size: 2, endSeats: false },
        plan(),
        later,
      ),
    ).toThrow("The table already has that shape");
  });
});

describe("labelSeat", () => {
  it("writes a trimmed label on one seat and leaves the others alone", () => {
    const labelled = labelSeat(table(), 2, "  Ada Lovelace  ", later);
    expect(findSeat(labelled, 2)?.label).toBe("Ada Lovelace");
    expect(findSeat(labelled, 0)?.label).toBe("");
    expect(labelled.version).toBe(2);
  });

  it("rejects an over-long label and a no-op", () => {
    expect(() => labelSeat(table(), 0, "a".repeat(33), later)).toThrow(
      "Seat label must be at most 32 characters",
    );
    expect(() => labelSeat(table(), 0, "", later)).toThrow(
      "The seat already has that label",
    );
  });
});

describe("undo twins", () => {
  it("restores a position, including one moveSeatingTable would call a no-op", () => {
    const subject = table({ gridX: 4, gridY: 3 });
    expect(
      restoreSeatingTablePosition(
        subject,
        { gridX: 4, gridY: 3 },
        plan(),
        later,
      ),
    ).toMatchObject({ gridX: 4, gridY: 3, version: 2 });
  });

  it("refuses to restore a position that is now occupied", () => {
    const subject = table({ gridX: 4, gridY: 0 });
    const squatter = table({ id: "tbl_2", gridX: 0, gridY: 0 });
    expect(() =>
      restoreSeatingTablePosition(
        subject,
        { gridX: 0, gridY: 0 },
        plan([squatter]),
        later,
      ),
    ).toThrow("Tables may not overlap");
  });

  it("restores a rotation together with the position it was turned from", () => {
    const subject = table({ size: 4, gridX: 4, gridY: 3 });
    const turned = rotateSeatingTable(subject, plan(), later);
    expect(
      restoreSeatingTableRotation(
        turned,
        { rotation: 0, gridX: subject.gridX, gridY: subject.gridY },
        plan(),
        later,
      ),
    ).toMatchObject({
      rotation: 0,
      gridX: 4,
      gridY: 3,
      version: turned.version + 1,
    });
  });

  it("restores a recorded form with the exact seats it had", () => {
    const original = removeSeat(
      labelSeat(table({ size: 3 }), 1, "Grace", later),
      4,
      later,
    );
    const reshaped = reshapeSeatingTable(
      original,
      { kind: "round", size: 2, endSeats: false },
      plan(),
      later,
    );
    const back = restoreSeatingTableShape(
      reshaped,
      {
        kind: original.kind,
        size: original.size,
        endSeats: original.endSeats,
        seats: original.seats,
      },
      plan(),
      later,
    );
    expect(back.kind).toBe("rectangle");
    expect(back.seats).toEqual(original.seats);
    expect(findSeat(back, 1)?.label).toBe("Grace");
    expect(findSeat(back, 4)?.present).toBe(false);
  });

  it("restores a previous seat label without the no-op rule", () => {
    expect(findSeat(restoreSeatLabel(table(), 0, "", later), 0)?.label).toBe(
      "",
    );
  });

  it("restores a chair, and refuses when its cell has been taken", () => {
    const trimmed = removeSeat(table(), 2, later);
    expect(
      findSeat(restoreSeatPresence(trimmed, 2, true, plan(), later), 2)
        ?.present,
    ).toBe(true);

    const cell = layoutOf(trimmed).seats[2]!;
    const squatter = table({
      id: "tbl_2",
      size: 1,
      gridX: trimmed.gridX + cell.x,
      gridY: trimmed.gridY + cell.y,
    });
    expect(() =>
      restoreSeatPresence(trimmed, 2, true, plan([squatter]), later),
    ).toThrow("Tables may not overlap");
    // Taking one away never needs space, so it is never refused.
    expect(
      findSeat(
        restoreSeatPresence(table(), 2, false, plan([squatter]), later),
        2,
      )?.present,
    ).toBe(false);
  });

  it("puts a removed table back only while its space is free", () => {
    const removed = archiveSeatingTable(table(), later);
    expect(restoreSeatingTable(removed, plan(), later)).toMatchObject({
      status: "active",
      version: 3,
    });
    expect(() =>
      restoreSeatingTable(removed, plan([table({ id: "tbl_2" })]), later),
    ).toThrow("Tables may not overlap");
    expect(() => restoreSeatingTable(table(), plan(), later)).toThrow(
      "Cannot restore a table that has not been removed",
    );
  });
});

describe("archiveSeatingTable", () => {
  it("archives once, refuses a second time, and frees its cells", () => {
    const removed = archiveSeatingTable(table(), later);
    expect(removed).toMatchObject({ status: "archived", version: 2 });
    expect(() => archiveSeatingTable(removed, later)).toThrow(
      "Cannot remove a table that has been removed",
    );
    expect(() =>
      createSeatingTable(baseInput({ id: "tbl_2" }), plan([removed])),
    ).not.toThrow();
  });
});
