/**
 * The use cases against real SQLite (blueprint B9, B18).
 *
 * `tests/unit/application/*` proves these against the in-memory doubles, and
 * `seating-repositories.test.ts` proves the SQL behind the ports. This is the
 * seam between them: the whole command path — capability, version guard,
 * domain transition, operation row, atomic commit — run end to end against a
 * database, through `getDependencies()`, which is the container production
 * uses.
 *
 * Every test here is about something the in-memory doubles cannot prove on
 * their own: that a version guard expressed in SQL refuses the same writes a
 * hand-written `if` does, and that a two-statement batch really is atomic.
 */

import { describe, expect, it } from "vitest";

import { bootstrapEventLayout } from "../../src/application/use-cases/bootstrap-event-layout";
import { createEvent } from "../../src/application/use-cases/create-event";
import { createSeatingTable } from "../../src/application/use-cases/create-seating-table";
import { labelSeat } from "../../src/application/use-cases/label-seat";
import { listRecentActivity } from "../../src/application/use-cases/list-recent-activity";
import { moveSeatingTable } from "../../src/application/use-cases/move-seating-table";
import { redoOperation } from "../../src/application/use-cases/redo-operation";
import { reshapeSeatingTable } from "../../src/application/use-cases/reshape-seating-table";
import { undoOperation } from "../../src/application/use-cases/undo-operation";
import { blockedSeats, findSeat } from "../../src/domain";
import { getDependencies } from "../../src/infrastructure/container";
import {
  ADMIN_EMAIL,
  EVENT_GALA_ID,
  MEMBER1_EMAIL,
  MEMBER2_EMAIL,
  ORG_ACME_ID,
} from "../fixtures/scenario";

const memberOne = {
  userEmail: MEMBER1_EMAIL,
  orgId: ORG_ACME_ID,
  role: "member" as const,
  caller: "test",
};
const memberTwo = { ...memberOne, userEmail: MEMBER2_EMAIL };
const admin = { ...memberOne, userEmail: ADMIN_EMAIL, role: "admin" as const };

/** A table of this file's own, so the order tests run in cannot matter. */
async function freshTable(name: string, gridX: number, gridY: number) {
  const created = await createSeatingTable(getDependencies(), memberOne, {
    eventId: EVENT_GALA_ID,
    name,
    size: 2,
    gridX,
    gridY,
  });
  return created;
}

describe("use cases against Node SQLite repositories", () => {
  it("runs a move, its undo and its redo end to end", async () => {
    const deps = getDependencies();
    const created = await freshTable("Round trip", 0, 4);

    const moved = await moveSeatingTable(deps, memberOne, {
      tableId: created.resource.id,
      gridX: 4,
      gridY: 4,
      expectedVersion: created.resource.version,
    });
    expect(moved.resource).toMatchObject({ gridX: 4, gridY: 4, version: 2 });

    const undone = await undoOperation(deps, memberOne, {
      operationId: moved.operationId,
    });
    expect(undone.resource).toMatchObject({ gridX: 0, gridY: 4, version: 3 });
    expect(undone.resourceType).toBe("seating_table");

    const redone = await redoOperation(deps, memberOne, {
      operationId: undone.operationId,
    });
    expect(redone.resource).toMatchObject({ gridX: 4, gridY: 4, version: 4 });

    // The ledger records all three, and the forward operation is marked undone
    // by the one that reversed it.
    const stored = await deps.operations.getById(
      ORG_ACME_ID,
      moved.operationId,
    );
    expect(stored?.undoneByOperationId).toBe(undone.operationId);
  });

  it("refuses a stale undo after another actor has changed the same table", async () => {
    const deps = getDependencies();
    const created = await freshTable("Stale undo", 8, 4);

    const labelled = await labelSeat(deps, memberOne, {
      tableId: created.resource.id,
      seat: 0,
      label: "Ada Lovelace",
      expectedVersion: created.resource.version,
    });

    // A coworker moves the same table on. The undo's version rule is now
    // unsatisfiable, and it has to refuse rather than discard the move.
    await moveSeatingTable(deps, memberTwo, {
      tableId: created.resource.id,
      gridX: 12,
      gridY: 4,
      expectedVersion: labelled.resource.version,
    });

    await expect(
      undoOperation(deps, memberOne, { operationId: labelled.operationId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const current = await deps.seatingTables.getById(
      ORG_ACME_ID,
      created.resource.id,
    );
    expect(current).toMatchObject({ gridX: 12, gridY: 4 });
    expect(findSeat(current!, 0)?.label).toBe("Ada Lovelace");
  });

  /**
   * The invariant the SQL predicate exists for, through the real use case: the
   * caller's snapshot said the cell was free, and the write still has to lose.
   */
  it("refuses a move whose target was taken between the read and the write", async () => {
    const deps = getDependencies();
    const mover = await freshTable("Mover", 0, 7);
    const target = { gridX: 8, gridY: 7 };
    await freshTable("Squatter", target.gridX, target.gridY);

    await expect(
      moveSeatingTable(deps, memberOne, {
        tableId: mover.resource.id,
        ...target,
        expectedVersion: mover.resource.version,
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });

    const stored = await deps.seatingTables.getById(
      ORG_ACME_ID,
      mover.resource.id,
    );
    expect(stored).toMatchObject({ gridX: 0, gridY: 7, version: 1 });
  });

  it("restores a shrunk table's discarded seat labels on undo", async () => {
    const deps = getDependencies();
    const created = await freshTable("Reshape round trip", 12, 7);
    const labelled = await labelSeat(deps, memberOne, {
      tableId: created.resource.id,
      seat: 3,
      label: "Grace Hopper",
      expectedVersion: created.resource.version,
    });

    const shrunk = await reshapeSeatingTable(deps, memberOne, {
      tableId: created.resource.id,
      kind: "rectangle",
      size: 1,
      endSeats: false,
      expectedVersion: labelled.resource.version,
    });
    // Seats are derived from the shape, so shrinking the body renumbers them.
    // Four chairs become two, and seat 3 — Grace's — is not one of them.
    expect(shrunk.resource.seats).toHaveLength(2);
    expect(shrunk.resource.seats.some((seat) => seat.label !== "")).toBe(false);

    const undone = await undoOperation(deps, memberOne, {
      operationId: shrunk.operationId,
    });
    expect(findSeat(undone.resource as never, 3)?.label).toBe("Grace Hopper");
  });

  /**
   * The arrangement the feature is for, end to end against a real database:
   * one action, many tables, and the chairs at every join and corner already
   * off. It gets a floor plan of its own so the order these tests run in
   * cannot crowd it out.
   */
  it("lays out a U in one operation, and takes the whole thing back on undo", async () => {
    const deps = getDependencies();
    const event = await createEvent(deps, memberOne, {
      name: "Wedding breakfast",
      startsAt: "2027-01-09T18:00:00.000Z",
    });
    expect(event.resource).toMatchObject({ roomWidth: 16, roomHeight: 10 });

    const laid = await bootstrapEventLayout(deps, memberOne, {
      eventId: event.resource.id,
      layout: "U",
      sections: [3, 4, 3],
      tableLength: 4,
      endSeats: true,
    });

    const placed = await deps.seatingTables.list(ORG_ACME_ID, {
      eventId: event.resource.id,
      status: "active",
    });
    expect(placed).toHaveLength(10);
    // The runs are continuous rather than merely adjacent: bodies touching,
    // with the chairs that have no room simply blocked.
    const room = {
      width: laid.resource.roomWidth,
      height: laid.resource.roomHeight,
    };
    expect(
      placed.some(
        (table) => blockedSeats(table, { room, tables: placed }).size > 0,
      ),
    ).toBe(true);
    // The room grew to hold it: this U needs 18 by 15, and an event starts at
    // 16 by 10. Nobody had to work that out.
    expect(laid.resource).toMatchObject({ roomWidth: 18, roomHeight: 15 });

    // One operation for the whole layout, not ten.
    const undone = await undoOperation(deps, memberOne, {
      operationId: laid.operationId,
    });
    expect(
      await deps.seatingTables.list(ORG_ACME_ID, {
        eventId: event.resource.id,
        status: "active",
      }),
    ).toHaveLength(0);
    // …and the room it grew comes back with it.
    expect(undone.resource).toMatchObject({ roomWidth: 16, roomHeight: 10 });

    // It creates records, so like every create it cannot be redone.
    await expect(
      redoOperation(deps, memberOne, { operationId: undone.operationId }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  });

  it("refuses to lay out a plan that already has tables", async () => {
    const deps = getDependencies();
    await expect(
      bootstrapEventLayout(deps, memberOne, {
        eventId: EVENT_GALA_ID,
        layout: "L",
        sections: [2, 1],
        tableLength: 2,
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  });

  it("reports a create's undo as not redoable, and refuses the redo", async () => {
    const deps = getDependencies();
    const created = await freshTable("Compensated", 14, 4);

    const undone = await undoOperation(deps, memberOne, {
      operationId: created.operationId,
    });
    expect(undone.resource).toMatchObject({ status: "archived" });

    const activity = await listRecentActivity(deps, memberOne, { limit: 50 });
    const entry = activity.find((item) => item.id === undone.operationId);
    expect(entry?.redoable).toBe(false);

    await expect(
      redoOperation(deps, memberOne, { operationId: undone.operationId }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  });

  it("keeps the admin-only archive out of a member's reach", async () => {
    const deps = getDependencies();
    await expect(
      undoOperation(deps, memberOne, {
        operationId: "op_archive_evt_archived",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });

    // The same operation, by an admin, is reversible.
    const restored = await undoOperation(deps, admin, {
      operationId: "op_archive_evt_archived",
    });
    expect(restored.resource).toMatchObject({ status: "active" });
    expect(restored.resourceType).toBe("event");
  });
});
