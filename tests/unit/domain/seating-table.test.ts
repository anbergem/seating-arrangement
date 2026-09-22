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
  moveSeatLabel,
  moveSeatingTable,
  blockedSeats,
  occupiedCellKeys,
  reshapeSeatingTable,
  restoreSeatingTable,
  restoreSeatingTablePosition,
  restoreSeatingTableRotation,
  restoreSeatingTableShape,
  restoreSeatLabel,
  restoreSeatPlacement,
  rotatedPlacement,
  rotateSeatingTable,
  seatCount,
  seatMoveFits,
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

/** The same table with a name on every chair, so it claims every cell its
 * shape describes. Empty chairs claim nothing, which is the point of most of
 * the occupancy tests below — this is how to ask the other question. */
function fullySeated(subject: SeatingTable): SeatingTable {
  return subject.seats.reduce(
    (next, _, index) => ({
      ...next,
      seats: next.seats.map((seat, at) =>
        at === index ? { label: `Guest ${index}` } : seat,
      ),
    }),
    subject,
  );
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
  it("starts every seat unlabelled", () => {
    expect(buildSeats(shape({ size: 2 }))).toEqual([
      { label: "" },
      { label: "" },
      { label: "" },
      { label: "" },
    ]);
  });

  it("carries names over by number", () => {
    const before = buildSeats(shape({ size: 4 })).map((_, index) => ({
      label: `seat-${index}`,
    }));
    const after = buildSeats(shape({ size: 3 }), before);
    expect(after[0]).toEqual({ label: "seat-0" });
    expect(after[2]).toEqual({ label: "seat-2" });
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
  it("holds its body, and its chairs only once they are filled", () => {
    // A table nobody is sitting at holds its two body cells and nothing else.
    expect(cells(table())).toEqual(["0,1", "1,1"].sort());
    expect(cells(fullySeated(table()))).toEqual(
      ["0,0", "0,1", "0,2", "1,0", "1,1", "1,2"].sort(),
    );
  });

  it("leaves the corners of the bounding box free even when every chair is filled", () => {
    const withEnds = fullySeated(table({ size: 2, endSeats: true }));
    expect(footprintSize(withEnds)).toEqual({ width: 4, height: 3 });
    expect(cells(withEnds)).toHaveLength(8);
    for (const corner of ["0,0", "3,0", "0,2", "3,2"]) {
      expect(cells(withEnds)).not.toContain(corner);
    }
  });

  it("leaves the corners of a round table free for a neighbour", () => {
    const round = fullySeated(table({ kind: "round", size: 2 }));
    // Four body cells and eight chairs, out of a 4x4 bounding box: nobody
    // sits at a corner, so those four cells belong to nobody and a neighbour
    // may stand in them.
    expect(cells(round)).toHaveLength(12);
    for (const corner of ["0,0", "3,0", "0,3", "3,3"]) {
      expect(cells(round)).not.toContain(corner);
    }
  });

  it("holds one more cell for each chair somebody sits in", () => {
    const empty = table();
    expect(cells(empty)).toHaveLength(layoutOf(empty).body.length);
    const seated = labelSeat(empty, 2, "Ada Lovelace", plan(), later);
    expect(cells(seated)).toHaveLength(cells(empty).length + 1);
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
    const subject = fullySeated(table());
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

  it("may move into a cell a neighbour's empty chair is sitting in", () => {
    const neighbour = table({ id: "tbl_2", size: 4, gridX: 4, gridY: 0 });
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
      plan(),
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
    // Seated, so its body is not the only thing in the way — an empty chair
    // would simply yield and the turn would be allowed.
    const blocker = fullySeated(
      table({ id: "tbl_2", size: 2, gridX: 5, gridY: 6 }),
    );
    expect(() => rotateSeatingTable(subject, plan([blocker]), later)).toThrow(
      "Tables may not overlap",
    );
    expect(() =>
      rotateSeatingTable(archiveSeatingTable(subject, later), plan(), later),
    ).toThrow("Cannot rotate a table that has been removed");
  });
});

/**
 * An empty chair claims nothing, which is what lets two tables be pushed
 * together — and a chair a neighbour is standing in is *blocked*, worked out
 * from the plan rather than recorded anywhere.
 */
describe("empty chairs and blocked seats", () => {
  it("claims a cell only once somebody is sitting in it", () => {
    const subject = table();
    const empty = cells(subject);
    const seated = labelSeat(subject, 2, "Ada Lovelace", plan(), later);
    expect(cells(seated)).toHaveLength(empty.length + 1);
    // And gives it back the moment the name comes off.
    expect(cells(labelSeat(seated, 2, "", plan(), later))).toEqual(empty);
  });

  it("lets two tables meet where their chairs are empty, but not where they are not", () => {
    // A table of three with a chair at each end: body at columns 1 to 3, right
    // cap at column 4.
    const left = table({ size: 3, endSeats: true, gridX: 0, gridY: 0 });
    const right = table({
      id: "tbl_2",
      size: 3,
      endSeats: true,
      gridX: 3,
      gridY: 0,
    });
    // `right`'s body starts in `left`'s cap cell. Nobody is in it, so the two
    // bodies may touch.
    expect(
      fitsAt(
        right,
        right.seats,
        right.gridX,
        right.gridY,
        occupiedCellKeys([left]),
        ROOM,
      ),
    ).toBe(true);

    // Seat 3 is that cap. With a name on it, the same placement is refused.
    const seated = labelSeat(left, 3, "Ada Lovelace", plan(), later);
    expect(
      fitsAt(
        right,
        right.seats,
        right.gridX,
        right.gridY,
        occupiedCellKeys([seated]),
        ROOM,
      ),
    ).toBe(false);
  });

  it("reports the chairs a neighbour is standing in as blocked", () => {
    const left = table({ size: 3, endSeats: true, gridX: 0, gridY: 0 });
    const right = table({
      id: "tbl_2",
      size: 3,
      endSeats: true,
      gridX: 3,
      gridY: 0,
    });
    // Each loses exactly the chair the other's body is standing in.
    expect([...blockedSeats(left, plan([right]))]).toEqual([3]);
    expect([...blockedSeats(right, plan([left]))]).toEqual([7]);
    // Nothing is blocked by the table's own cells, or on an empty plan.
    expect(blockedSeats(left, plan()).size).toBe(0);
  });

  it("refuses to seat somebody in a chair that is not there", () => {
    const left = table({ size: 3, endSeats: true, gridX: 0, gridY: 0 });
    const right = table({
      id: "tbl_2",
      size: 3,
      endSeats: true,
      gridX: 3,
      gridY: 0,
    });
    expect(() => labelSeat(left, 3, "Ada", plan([right]), later)).toThrow(
      "There is no chair there",
    );
    // Clearing one never needs space, so it is never refused.
    expect(() => labelSeat(left, 3, "", plan([right]), later)).toThrow(
      "The seat already has that label",
    );
  });

  it("refuses a seat number the table does not have", () => {
    expect(() => labelSeat(table(), 99, "Ada", plan(), later)).toThrow(
      "This table has no seat 100; it has 4",
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
    const seated = labelSeat(table({ size: 3 }), 0, "Ada", plan(), later);
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
    const labelled = labelSeat(table(), 2, "  Ada Lovelace  ", plan(), later);
    expect(findSeat(labelled, 2)?.label).toBe("Ada Lovelace");
    expect(findSeat(labelled, 0)?.label).toBe("");
    expect(labelled.version).toBe(2);
  });

  it("rejects an over-long label and a no-op", () => {
    expect(() => labelSeat(table(), 0, "a".repeat(33), plan(), later)).toThrow(
      "Seat label must be at most 32 characters",
    );
    expect(() => labelSeat(table(), 0, "", plan(), later)).toThrow(
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
    const original = labelSeat(table({ size: 3 }), 1, "Grace", plan(), later);
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
  });

  it("restores a previous seat label without the no-op rule", () => {
    expect(
      findSeat(restoreSeatLabel(table(), 0, "", plan(), later), 0)?.label,
    ).toBe("");
  });

  it("refuses to restore a name into a chair a neighbour is now standing in", () => {
    const left = table({ size: 3, endSeats: true, gridX: 0, gridY: 0 });
    const right = table({
      id: "tbl_2",
      size: 3,
      endSeats: true,
      gridX: 3,
      gridY: 0,
    });
    expect(() =>
      restoreSeatLabel(left, 3, "Ada Lovelace", plan([right]), later),
    ).toThrow("There is no chair there");
    // Restoring an *empty* label gives space up rather than asking for it, so
    // it is always allowed.
    expect(
      findSeat(restoreSeatLabel(left, 3, "", plan([right]), later), 3)?.label,
    ).toBe("");
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

/** The same table with one name written on it, without going through
 * `labelSeat` — these tests are about what a move does, not about how the
 * seats came to be filled. */
function withName(
  subject: SeatingTable,
  index: number,
  label: string,
): SeatingTable {
  return {
    ...subject,
    seats: subject.seats.map((seat, at) => (at === index ? { label } : seat)),
  };
}

describe("moveSeatLabel", () => {
  it("moves a name to an empty seat of the same table, as one object", () => {
    const subject = withName(table(), 0, "Ada");
    const moved = moveSeatLabel(
      { table: subject, seat: 0 },
      { table: subject, seat: 2 },
      plan([subject]),
      later,
    );
    // One table changed, so one object and one version: a caller that wrote
    // `source` and `target` separately would write the same row twice.
    expect(moved.source).toBe(moved.target);
    expect(findSeat(moved.target, 0)?.label).toBe("");
    expect(findSeat(moved.target, 2)?.label).toBe("Ada");
    expect(moved.target.version).toBe(2);
    expect(moved.target.updatedAt).toBe(later);
    // The input is untouched.
    expect(findSeat(subject, 0)?.label).toBe("Ada");
  });

  it("swaps two names at the same table without losing either", () => {
    const subject = withName(withName(table(), 0, "Ada"), 1, "Grace");
    const moved = moveSeatLabel(
      { table: subject, seat: 0 },
      { table: subject, seat: 1 },
      plan([subject]),
      later,
    );
    expect(findSeat(moved.target, 0)?.label).toBe("Grace");
    expect(findSeat(moved.target, 1)?.label).toBe("Ada");
    expect(moved.target.version).toBe(2);
  });

  it("moves a name across tables, bumping each of them once", () => {
    const head = withName(table({ id: "tbl_head" }), 0, "Ada");
    const side = table({ id: "tbl_side", gridX: 6 });
    const moved = moveSeatLabel(
      { table: head, seat: 0 },
      { table: side, seat: 1 },
      plan([head, side]),
      later,
    );
    expect(moved.source).not.toBe(moved.target);
    expect(findSeat(moved.source, 0)?.label).toBe("");
    expect(findSeat(moved.target, 1)?.label).toBe("Ada");
    expect(moved.source.version).toBe(2);
    expect(moved.target.version).toBe(2);
  });

  it("leaves occupancy exactly as it found it when two names swap", () => {
    const head = withName(table({ id: "tbl_head" }), 0, "Ada");
    const side = withName(table({ id: "tbl_side", gridX: 6 }), 1, "Grace");
    const before = [...cells(head), ...cells(side)].sort();
    const moved = moveSeatLabel(
      { table: head, seat: 0 },
      { table: side, seat: 1 },
      plan([head, side]),
      later,
    );
    // Both chairs are filled before and after, so the cells they claim are the
    // same cells. A swap is the one move that can never be refused for space.
    expect([...cells(moved.source), ...cells(moved.target)].sort()).toEqual(
      before,
    );
  });

  /**
   * The case the whole design turns on.
   *
   * Two length-2 tables with no end seats, one standing on the other's chairs:
   * `Q` at (0,0) has chairs along y=2, and `P` at (0,2) has chairs along the
   * same y=2. One grid cell, (0,2), is a chair of either of them — and while
   * somebody is sitting in it on `P`, `Q` has no chair there at all.
   *
   * Moving that person from `P` to the very cell they are vacating is legal,
   * and only a check against the plan **as it will be** can see that.
   *
   * The order of `plan.tables` decides it, and that is the documented
   * first-come rule rather than an accident: two *empty* chairs contending for
   * one cell belong to whichever table was there first. With `[Q, P]` the
   * emptied chair belongs to the later table and blocks nothing; with
   * `[P, Q]` it keeps the cell and `Q` goes without.
   */
  it("sees the cell the name is vacating as free for the seat it is moving to", () => {
    const upper = table({ id: "tbl_q", gridX: 0, gridY: 0 });
    const lower = withName(
      table({ id: "tbl_p", gridX: 0, gridY: 2 }),
      0,
      "Ada",
    );
    // Seat 3 of the upper table and seat 0 of the lower are the same cell.
    // `layoutOf` is relative to the bounding box, so the grid position is what
    // makes them comparable.
    const at = (subject: SeatingTable, index: number) =>
      cellKey(
        subject.gridX + (layoutOf(subject).seats[index]?.x ?? 0),
        subject.gridY + (layoutOf(subject).seats[index]?.y ?? 0),
      );
    expect(at(upper, 3)).toBe(cellKey(0, 2));
    expect(at(lower, 0)).toBe(cellKey(0, 2));
    // While Ada sits there on the lower table, the upper one has no chair.
    expect(blockedSeats(upper, plan([upper, lower])).has(3)).toBe(true);

    const moved = moveSeatLabel(
      { table: lower, seat: 0 },
      { table: upper, seat: 3 },
      plan([upper, lower]),
      later,
    );
    expect(findSeat(moved.target, 3)?.label).toBe("Ada");
    expect(findSeat(moved.source, 0)?.label).toBe("");

    expect(() =>
      moveSeatLabel(
        { table: lower, seat: 0 },
        { table: upper, seat: 3 },
        plan([lower, upper]),
        later,
      ),
    ).toThrow("There is no chair there");
  });

  it("refuses a seat a neighbouring table's body is standing on", () => {
    const head = withName(table({ id: "tbl_head" }), 0, "Ada");
    // A table whose body covers the cell seat 2 of the head table would need.
    const squatter = table({ id: "tbl_squat", gridX: 0, gridY: 1 });
    expect(() =>
      moveSeatLabel(
        { table: head, seat: 0 },
        { table: head, seat: 2 },
        plan([head, squatter]),
        later,
      ),
    ).toThrow("There is no chair there");
  });

  it("refuses the moves that are not moves", () => {
    const subject = withName(table(), 0, "Ada");
    expect(() =>
      moveSeatLabel(
        { table: subject, seat: 0 },
        { table: subject, seat: 0 },
        plan([subject]),
        later,
      ),
    ).toThrow("The name is already on that seat");
    expect(() =>
      moveSeatLabel(
        { table: subject, seat: 1 },
        { table: subject, seat: 2 },
        plan([subject]),
        later,
      ),
    ).toThrow("There is nobody on that seat");
    const twice = withName(subject, 1, "Ada");
    expect(() =>
      moveSeatLabel(
        { table: twice, seat: 0 },
        { table: twice, seat: 1 },
        plan([twice]),
        later,
      ),
    ).toThrow("Both seats already have that name");
  });

  it("refuses a seat the table does not have", () => {
    const subject = withName(table(), 0, "Ada");
    expect(() =>
      moveSeatLabel(
        { table: subject, seat: 0 },
        { table: subject, seat: 9 },
        plan([subject]),
        later,
      ),
    ).toThrow("This table has no seat 10; it has 4");
  });

  it("refuses a pair from two different events, or two organizations", () => {
    const head = withName(table({ id: "tbl_head" }), 0, "Ada");
    expect(() =>
      moveSeatLabel(
        { table: head, seat: 0 },
        {
          table: table({ id: "tbl_other", eventId: "evt_2", gridX: 6 }),
          seat: 1,
        },
        plan([head]),
        later,
      ),
    ).toThrow("Both seats must be at the same event");
    expect(() =>
      moveSeatLabel(
        { table: head, seat: 0 },
        {
          table: table({ id: "tbl_other", orgId: "org_2", gridX: 6 }),
          seat: 1,
        },
        plan([head]),
        later,
      ),
    ).toThrow("Both seats must belong to the same organization");
  });

  it("refuses a removed table on either side", () => {
    const head = withName(table({ id: "tbl_head" }), 0, "Ada");
    const gone = archiveSeatingTable(
      table({ id: "tbl_gone", gridX: 6 }),
      later,
    );
    expect(() =>
      moveSeatLabel(
        { table: head, seat: 0 },
        { table: gone, seat: 1 },
        plan([head]),
        later,
      ),
    ).toThrow("Cannot move a name to a table that has been removed");
    expect(() =>
      moveSeatLabel(
        { table: archiveSeatingTable(head, later), seat: 0 },
        { table: table({ id: "tbl_side", gridX: 6 }), seat: 1 },
        plan([]),
        later,
      ),
    ).toThrow("Cannot move a name from a table that has been removed");
  });
});

describe("seatMoveFits", () => {
  it("passes a swap between two tables standing on one another's chairs", () => {
    // The upper table's chair at (0,2) is also where the lower table's chair
    // would be; the upper one came first, so it is the upper one that has it.
    // Neither name is on a contended cell, so exchanging them changes nothing
    // about who claims what.
    const upper = withName(table({ id: "tbl_q" }), 3, "Grace");
    const lower = withName(table({ id: "tbl_p", gridY: 2 }), 2, "Ada");
    expect(
      seatMoveFits(
        { table: lower, seat: 2 },
        { table: upper, seat: 3 },
        plan([upper, lower]),
      ),
    ).toBe(true);
  });

  it("fails a move onto a chair a neighbouring table is standing in", () => {
    const head = withName(table({ id: "tbl_head" }), 0, "Ada");
    const squatter = table({ id: "tbl_squat", gridX: 0, gridY: 1 });
    expect(
      seatMoveFits(
        { table: head, seat: 0 },
        { table: head, seat: 2 },
        plan([head, squatter]),
      ),
    ).toBe(false);
  });
});

describe("restoreSeatPlacement", () => {
  it("puts both recorded names back", () => {
    const head = withName(table({ id: "tbl_head" }), 0, "");
    const side = withName(table({ id: "tbl_side", gridX: 6 }), 1, "Ada");
    const restored = restoreSeatPlacement(
      { table: head, seat: 0, label: "Ada" },
      { table: side, seat: 1, label: "" },
      plan([head, side]),
      later,
    );
    expect(findSeat(restored.source, 0)?.label).toBe("Ada");
    expect(findSeat(restored.target, 1)?.label).toBe("");
    expect(restored.source.version).toBe(2);
    expect(restored.target.version).toBe(2);
  });

  it("is one object when both seats are on one table", () => {
    const subject = withName(table(), 2, "Ada");
    const restored = restoreSeatPlacement(
      { table: subject, seat: 0, label: "Ada" },
      { table: subject, seat: 2, label: "" },
      plan([subject]),
      later,
    );
    expect(restored.source).toBe(restored.target);
    expect(restored.target.version).toBe(2);
  });

  it("refuses to put a name back where a table now stands", () => {
    // Ada left seat 2 of the head table; a table has moved into that chair's
    // cell since, so there is nowhere to put her back.
    const head = table({ id: "tbl_head" });
    const side = withName(table({ id: "tbl_side", gridX: 6 }), 1, "Ada");
    const squatter = table({ id: "tbl_squat", gridX: 0, gridY: 1 });
    expect(() =>
      restoreSeatPlacement(
        { table: head, seat: 2, label: "Ada" },
        { table: side, seat: 1, label: "" },
        plan([head, side, squatter]),
        later,
      ),
    ).toThrow("There is no chair there");
  });

  it("treats a seat the table no longer has as a corrupt row", () => {
    const subject = table();
    expect(() =>
      restoreSeatPlacement(
        { table: subject, seat: 9, label: "Ada" },
        { table: subject, seat: 0, label: "" },
        plan([subject]),
        later,
      ),
    ).toThrow("This table has no seat 10");
  });
});
