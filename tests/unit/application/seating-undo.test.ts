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
import { moveSeatingTable } from "../../../src/application/use-cases/move-seating-table";
import { redoOperation } from "../../../src/application/use-cases/redo-operation";
import { reshapeSeatingTable } from "../../../src/application/use-cases/reshape-seating-table";
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
