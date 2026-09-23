/**
 * Undo and redo over the seating domain (blueprint B9).
 *
 * `seating-commands.test.ts` proves the forward commands; this proves the
 * two things the floor plan adds to it.
 *
 * The first is that undo here can legitimately fail. Every other inverse in
 * this application restores a value nobody else can be holding — a status, an
 * instant, a name. A seating inverse restores a *place*, and the place may
 * have been taken while the table was somewhere else, so the round trip is
 * checked both when the space is free and when it is not.
 *
 * The second is that a reshape's inverse carries the whole seat array, not the
 * numbers that describe the form: seats are derived from the shape, so
 * reshaping renumbers them, and an undo has to put every name back on the chair
 * it was on.
 */

import { describe, expect, it } from "vitest";

import type { Actor } from "../../../src/application/actor";
import { archiveSeatingTable } from "../../../src/application/use-cases/archive-seating-table";
import { createSeatingTable } from "../../../src/application/use-cases/create-seating-table";
import { labelSeat } from "../../../src/application/use-cases/label-seat";
import { moveSeat } from "../../../src/application/use-cases/move-seat";
import { moveSeatingTable } from "../../../src/application/use-cases/move-seating-table";
import { redoOperation } from "../../../src/application/use-cases/redo-operation";
import { reshapeSeatingTable } from "../../../src/application/use-cases/reshape-seating-table";
import { shiftSeats } from "../../../src/application/use-cases/shift-seats";
import { undoOperation } from "../../../src/application/use-cases/undo-operation";
import { findSeat, type SeatingTable } from "../../../src/domain";
import {
  createInMemoryDependencies,
  type InMemoryDependencies,
} from "../../fixtures/in-memory";
import {
  seedInMemory,
  EVENT_GALA_ID,
  MEMBER1_EMAIL,
  ORG_ACME_ID,
  SEAT_LABEL_ADA,
  SEAT_LABEL_GRACE,
  TABLE_HEAD_ID,
  TABLE_SIDE_ID,
} from "../../fixtures/scenario";

const ACTOR: Actor = {
  userEmail: MEMBER1_EMAIL,
  orgId: ORG_ACME_ID,
  role: "member",
  caller: "test",
};

function deps(): InMemoryDependencies {
  const dependencies = createInMemoryDependencies() as InMemoryDependencies;
  seedInMemory(dependencies);
  return dependencies;
}

function table(d: InMemoryDependencies, id: string): SeatingTable {
  const found = d.state.seatingTables.get(id);
  if (!found) throw new Error(`fixture: no table ${id}`);
  return found;
}

describe("move", () => {
  it("round-trips through undo and redo", async () => {
    const d = deps();
    const moved = await moveSeatingTable(d, ACTOR, {
      tableId: TABLE_SIDE_ID,
      gridX: 8,
      gridY: 4,
    });
    expect(table(d, TABLE_SIDE_ID)).toMatchObject({ gridX: 8, gridY: 4 });

    const undone = await undoOperation(d, ACTOR, {
      operationId: moved.operationId,
    });
    expect(undone.resourceType).toBe("seating_table");
    expect(table(d, TABLE_SIDE_ID)).toMatchObject({ gridX: 4, gridY: 0 });
    expect(d.state.operations.get(moved.operationId)?.undoneByOperationId).toBe(
      undone.operationId,
    );

    await redoOperation(d, ACTOR, { operationId: undone.operationId });
    expect(table(d, TABLE_SIDE_ID)).toMatchObject({ gridX: 8, gridY: 4 });
  });

  it("is refused when the spot it came from has been taken since", async () => {
    const d = deps();
    const moved = await moveSeatingTable(d, ACTOR, {
      tableId: TABLE_SIDE_ID,
      gridX: 8,
      gridY: 4,
    });
    // Somebody fills the vacated cell with a new table.
    await createSeatingTable(d, ACTOR, {
      eventId: EVENT_GALA_ID,
      name: "Table 3",
      size: 4,
      gridX: 4,
      gridY: 0,
    });

    await expect(
      undoOperation(d, ACTOR, { operationId: moved.operationId }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    expect(table(d, TABLE_SIDE_ID)).toMatchObject({ gridX: 8, gridY: 4 });
  });

  it("is refused with CONFLICT when the table moved on again", async () => {
    const d = deps();
    const moved = await moveSeatingTable(d, ACTOR, {
      tableId: TABLE_SIDE_ID,
      gridX: 8,
      gridY: 4,
    });
    await moveSeatingTable(d, ACTOR, {
      tableId: TABLE_SIDE_ID,
      gridX: 8,
      gridY: 7,
    });
    await expect(
      undoOperation(d, ACTOR, { operationId: moved.operationId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("label", () => {
  it("round-trips through undo and redo", async () => {
    const d = deps();
    // Seat 0 of the head table is Ada's, so the round trip has to give it back.
    const labelled = await labelSeat(d, ACTOR, {
      tableId: TABLE_HEAD_ID,
      seat: 0,
      label: "Katherine Johnson",
    });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe(
      "Katherine Johnson",
    );

    const undone = await undoOperation(d, ACTOR, {
      operationId: labelled.operationId,
    });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe(SEAT_LABEL_ADA);

    await redoOperation(d, ACTOR, { operationId: undone.operationId });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe(
      "Katherine Johnson",
    );
  });
});

describe("seat move", () => {
  it("round-trips a move across two tables, both halves together", async () => {
    const d = deps();
    const moved = await moveSeat(d, ACTOR, {
      fromTableId: TABLE_HEAD_ID,
      fromSeat: 0,
      toTableId: TABLE_SIDE_ID,
      toSeat: 0,
    });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe("");
    expect(findSeat(table(d, TABLE_SIDE_ID), 0)?.label).toBe(SEAT_LABEL_ADA);

    const undone = await undoOperation(d, ACTOR, {
      operationId: moved.operationId,
    });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe(SEAT_LABEL_ADA);
    expect(findSeat(table(d, TABLE_SIDE_ID), 0)?.label).toBe("");

    await redoOperation(d, ACTOR, { operationId: undone.operationId });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe("");
    expect(findSeat(table(d, TABLE_SIDE_ID), 0)?.label).toBe(SEAT_LABEL_ADA);
  });

  it("round-trips a swap within one table", async () => {
    const d = deps();
    const moved = await moveSeat(d, ACTOR, {
      fromTableId: TABLE_HEAD_ID,
      fromSeat: 0,
      toTableId: TABLE_HEAD_ID,
      toSeat: 1,
    });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe(SEAT_LABEL_GRACE);

    const undone = await undoOperation(d, ACTOR, {
      operationId: moved.operationId,
    });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe(SEAT_LABEL_ADA);
    expect(findSeat(table(d, TABLE_HEAD_ID), 1)?.label).toBe(SEAT_LABEL_GRACE);

    await redoOperation(d, ACTOR, { operationId: undone.operationId });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe(SEAT_LABEL_GRACE);
    expect(findSeat(table(d, TABLE_HEAD_ID), 1)?.label).toBe(SEAT_LABEL_ADA);
  });

  /**
   * The reason the operation carries a second version guard at all.
   *
   * `canUndo` checks the table the operation names as its resource, which for
   * a move is the one the name landed on. The table it *left* is just as much
   * a part of what the move did, and without `payload.other` nothing would
   * check it — this undo would write over somebody else's change without a
   * word.
   */
  it("is refused when the table the name left has changed since", async () => {
    const d = deps();
    const moved = await moveSeat(d, ACTOR, {
      fromTableId: TABLE_HEAD_ID,
      fromSeat: 0,
      toTableId: TABLE_SIDE_ID,
      toSeat: 0,
    });
    // Somebody seats a guest at a different chair of the head table.
    await labelSeat(d, ACTOR, {
      tableId: TABLE_HEAD_ID,
      seat: 2,
      label: "Katherine Johnson",
    });

    await expect(
      undoOperation(d, ACTOR, { operationId: moved.operationId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // And nothing of the undo happened: Katherine is still seated.
    expect(findSeat(table(d, TABLE_HEAD_ID), 2)?.label).toBe(
      "Katherine Johnson",
    );
    expect(findSeat(table(d, TABLE_SIDE_ID), 0)?.label).toBe(SEAT_LABEL_ADA);
  });

  it("is refused when the chair the name would go back to is gone", async () => {
    const d = deps();
    // Seat 7 of the side table is the near-side chair at the start of its run.
    await labelSeat(d, ACTOR, {
      tableId: TABLE_SIDE_ID,
      seat: 7,
      label: "Katherine Johnson",
    });
    const moved = await moveSeat(d, ACTOR, {
      fromTableId: TABLE_SIDE_ID,
      fromSeat: 7,
      toTableId: TABLE_HEAD_ID,
      toSeat: 2,
    });

    // The chair she left is empty now, so it claims nothing and a table may
    // legitimately be pushed into it — which is exactly what leaves her
    // nowhere to go back to.
    await createSeatingTable(d, ACTOR, {
      eventId: EVENT_GALA_ID,
      name: "Squatter",
      size: 2,
      endSeats: false,
      gridX: 4,
      gridY: 1,
    });

    await expect(
      undoOperation(d, ACTOR, { operationId: moved.operationId }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    // She is still where the move put her, rather than half restored.
    expect(findSeat(table(d, TABLE_HEAD_ID), 2)?.label).toBe(
      "Katherine Johnson",
    );
  });

  it("refuses a redo once the other table has moved on", async () => {
    const d = deps();
    const moved = await moveSeat(d, ACTOR, {
      fromTableId: TABLE_HEAD_ID,
      fromSeat: 0,
      toTableId: TABLE_SIDE_ID,
      toSeat: 0,
    });
    const undone = await undoOperation(d, ACTOR, {
      operationId: moved.operationId,
    });
    // The undo put Ada back on the head table; somebody then changes it.
    await labelSeat(d, ACTOR, {
      tableId: TABLE_HEAD_ID,
      seat: 2,
      label: "Katherine Johnson",
    });
    await expect(
      redoOperation(d, ACTOR, { operationId: undone.operationId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("seat shift", () => {
  it("round-trips a shift along one table", async () => {
    const d = deps();
    const shifted = await shiftSeats(d, ACTOR, {
      tableId: TABLE_HEAD_ID,
      seat: 0,
      towardTableId: TABLE_HEAD_ID,
      towardSeat: 1,
    });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe("");
    expect(findSeat(table(d, TABLE_HEAD_ID), 2)?.label).toBe(SEAT_LABEL_GRACE);

    const undone = await undoOperation(d, ACTOR, {
      operationId: shifted.operationId,
    });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe(SEAT_LABEL_ADA);
    expect(findSeat(table(d, TABLE_HEAD_ID), 1)?.label).toBe(SEAT_LABEL_GRACE);
    expect(findSeat(table(d, TABLE_HEAD_ID), 2)?.label).toBe("");

    await redoOperation(d, ACTOR, { operationId: undone.operationId });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe("");
    expect(findSeat(table(d, TABLE_HEAD_ID), 2)?.label).toBe(SEAT_LABEL_GRACE);
  });

  it("round-trips a shift that ran on to the next table", async () => {
    const d = deps();
    await moveSeatingTable(d, ACTOR, {
      tableId: TABLE_SIDE_ID,
      gridX: 3,
      gridY: 0,
    });
    const shifted = await shiftSeats(d, ACTOR, {
      tableId: TABLE_HEAD_ID,
      seat: 0,
      towardTableId: TABLE_HEAD_ID,
      towardSeat: 1,
    });
    expect(findSeat(table(d, TABLE_SIDE_ID), 0)?.label).toBe(SEAT_LABEL_GRACE);

    const undone = await undoOperation(d, ACTOR, {
      operationId: shifted.operationId,
    });
    expect(findSeat(table(d, TABLE_HEAD_ID), 0)?.label).toBe(SEAT_LABEL_ADA);
    expect(findSeat(table(d, TABLE_HEAD_ID), 1)?.label).toBe(SEAT_LABEL_GRACE);
    expect(findSeat(table(d, TABLE_SIDE_ID), 0)?.label).toBe("");

    await redoOperation(d, ACTOR, { operationId: undone.operationId });
    expect(findSeat(table(d, TABLE_SIDE_ID), 0)?.label).toBe(SEAT_LABEL_GRACE);
  });

  /** `canUndo` checks only the table the operation names, and a shift that ran
   * on to another one changed that too. Without the guards in `payload.others`
   * this undo would write over somebody else's change without a word. */
  it("is refused when a table it ran on to has changed since", async () => {
    const d = deps();
    await moveSeatingTable(d, ACTOR, {
      tableId: TABLE_SIDE_ID,
      gridX: 3,
      gridY: 0,
    });
    const shifted = await shiftSeats(d, ACTOR, {
      tableId: TABLE_HEAD_ID,
      seat: 0,
      towardTableId: TABLE_HEAD_ID,
      towardSeat: 1,
    });
    await labelSeat(d, ACTOR, {
      tableId: TABLE_SIDE_ID,
      seat: 4,
      label: "Katherine Johnson",
    });

    await expect(
      undoOperation(d, ACTOR, { operationId: shifted.operationId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(findSeat(table(d, TABLE_SIDE_ID), 4)?.label).toBe(
      "Katherine Johnson",
    );
    expect(findSeat(table(d, TABLE_SIDE_ID), 0)?.label).toBe(SEAT_LABEL_GRACE);
  });

  it("round-trips a table turned right round", async () => {
    const d = deps();
    const head = table(d, TABLE_HEAD_ID);
    d.state.seatingTables.set(TABLE_HEAD_ID, {
      ...head,
      seats: head.seats.map((seat, index) =>
        seat.label ? seat : { label: `Guest ${index}` },
      ),
    });
    const before = table(d, TABLE_HEAD_ID).seats.map((seat) => seat.label);

    const shifted = await shiftSeats(d, ACTOR, {
      tableId: TABLE_HEAD_ID,
      seat: 0,
      towardTableId: TABLE_HEAD_ID,
      towardSeat: 1,
    });
    expect(table(d, TABLE_HEAD_ID).seats.map((seat) => seat.label)).not.toEqual(
      before,
    );

    await undoOperation(d, ACTOR, { operationId: shifted.operationId });
    expect(table(d, TABLE_HEAD_ID).seats.map((seat) => seat.label)).toEqual(
      before,
    );
  });
});

describe("reshape", () => {
  it("brings back the seats a reshape threw away, with their names on them", async () => {
    const d = deps();
    const before = table(d, TABLE_HEAD_ID);
    const reshaped = await reshapeSeatingTable(d, ACTOR, {
      tableId: TABLE_HEAD_ID,
      kind: "rectangle",
      size: 1,
      endSeats: false,
    });
    // Six seats down to two, so the numbering has moved under everyone.
    expect(reshaped.resource.seats).toHaveLength(2);
    expect(before.seats).toHaveLength(6);

    await undoOperation(d, ACTOR, { operationId: reshaped.operationId });
    expect(table(d, TABLE_HEAD_ID).seats).toEqual(before.seats);
    expect(table(d, TABLE_HEAD_ID)).toMatchObject({
      kind: "rectangle",
      size: 2,
      endSeats: true,
    });
  });

  it("turns a straight table into a round one and back again", async () => {
    const d = deps();
    const before = table(d, TABLE_SIDE_ID);
    const round = await reshapeSeatingTable(d, ACTOR, {
      tableId: TABLE_SIDE_ID,
      kind: "round",
      size: 3,
      endSeats: false,
    });
    expect(round.resource).toMatchObject({ kind: "round", size: 3 });
    expect(round.resource.seats).toHaveLength(12);

    await undoOperation(d, ACTOR, { operationId: round.operationId });
    expect(table(d, TABLE_SIDE_ID)).toMatchObject({
      kind: "rectangle",
      size: 4,
    });
    expect(table(d, TABLE_SIDE_ID).seats).toEqual(before.seats);
  });
});

describe("create and remove", () => {
  it("undoes a create by removing the table, and refuses to redo it", async () => {
    const d = deps();
    const created = await createSeatingTable(d, ACTOR, {
      eventId: EVENT_GALA_ID,
      name: "Table 3",
      size: 2,
    });
    const undone = await undoOperation(d, ACTOR, {
      operationId: created.operationId,
    });
    expect(table(d, created.resource.id).status).toBe("archived");

    await expect(
      redoOperation(d, ACTOR, { operationId: undone.operationId }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  });

  it("round-trips a removal, and refuses the undo once the space is gone", async () => {
    const d = deps();
    const removed = await archiveSeatingTable(d, ACTOR, {
      tableId: TABLE_SIDE_ID,
    });
    const undone = await undoOperation(d, ACTOR, {
      operationId: removed.operationId,
    });
    expect(table(d, TABLE_SIDE_ID).status).toBe("active");
    await redoOperation(d, ACTOR, { operationId: undone.operationId });
    expect(table(d, TABLE_SIDE_ID).status).toBe("archived");

    // With the table gone, its footprint is free — and once somebody uses it,
    // putting the table back is no longer possible.
    const secondRemoval = d.state.operations.get(removed.operationId);
    expect(secondRemoval?.undoneByOperationId).not.toBeNull();
    await createSeatingTable(d, ACTOR, {
      eventId: EVENT_GALA_ID,
      name: "Table 3",
      size: 4,
      gridX: 4,
      gridY: 0,
    });
    const latestRemoval = Array.from(d.state.operations.values()).find(
      (op) => op.action === "redo-operation" && op.resourceId === TABLE_SIDE_ID,
    );
    await expect(
      undoOperation(d, ACTOR, { operationId: latestRemoval!.id }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  });
});
