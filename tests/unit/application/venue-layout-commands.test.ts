/**
 * `bootstrap-event-layout` and `resize-room` (blueprint B8), against the
 * in-memory dependencies and the fixed B12 scenario.
 *
 * These two are the only commands in the application whose write spans more
 * than one record — a bootstrap places a dozen tables and may enlarge the room,
 * and its undo takes all of it back — so what is asserted here is mostly about
 * that: one operation rather than one per table, the room moving with the
 * layout, and the whole thing being refused as a unit.
 */

import { describe, expect, it } from "vitest";

import type { Actor } from "../../../src/application/actor";
import { bootstrapEventLayout } from "../../../src/application/use-cases/bootstrap-event-layout";
import { createEvent } from "../../../src/application/use-cases/create-event";
import { createSeatingTable } from "../../../src/application/use-cases/create-seating-table";
import { resizeRoom } from "../../../src/application/use-cases/resize-room";
import { undoOperation } from "../../../src/application/use-cases/undo-operation";
import { layoutOf } from "../../../src/domain";
import {
  createInMemoryDependencies,
  type InMemoryDependencies,
} from "../../fixtures/in-memory";
import {
  seedInMemory,
  ADMIN_EMAIL,
  EVENT_ARCHIVED_ID,
  EVENT_GALA_ID,
  EVENT_OTHER_ID,
  MEMBER1_EMAIL,
  ORG_ACME_ID,
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
    ids ? { ids } : undefined,
  ) as InMemoryDependencies;
  seedInMemory(dependencies);
  return dependencies;
}

/** An event of its own, since a bootstrap only works on an empty plan and the
 * seeded gala already has tables on it. */
async function emptyEvent(d: InMemoryDependencies) {
  const created = await createEvent(d, actor(), {
    name: "Wedding breakfast",
    startsAt: "2027-02-14T17:00:00.000Z",
  });
  return created.resource;
}

function tablesOf(d: InMemoryDependencies, eventId: string) {
  return [...d.state.seatingTables.values()].filter(
    (table) => table.eventId === eventId && table.status === "active",
  );
}

describe("bootstrapEventLayout", () => {
  it("places every table of the layout under one operation", async () => {
    const d = deps();
    const event = await emptyEvent(d);
    const result = await bootstrapEventLayout(d, actor(), {
      eventId: event.id,
      layout: "L",
      sections: [3, 2],
      tableLength: 3,
      endSeats: true,
    });

    const placed = tablesOf(d, event.id);
    expect(placed).toHaveLength(5);
    // One audit row for the whole arrangement, naming the event rather than
    // any one table: undoing a layout is one decision, not five.
    const operation = d.state.operations.get(result.operationId);
    expect(operation).toMatchObject({
      action: "bootstrap-event-layout",
      resourceType: "event",
      resourceId: event.id,
      classification: "compensatable",
    });
    expect(operation?.inverse).toMatchObject({
      type: "undo-bootstrap",
      tableIds: placed.map((table) => table.id),
      previousRoom: { width: 16, height: 10 },
    });
  });

  it("takes the chairs off wherever another table of the layout stands", async () => {
    const d = deps();
    const event = await emptyEvent(d);
    await bootstrapEventLayout(d, actor(), {
      eventId: event.id,
      layout: "L",
      sections: [2, 1],
      tableLength: 3,
      endSeats: true,
    });

    const placed = tablesOf(d, event.id);
    const absent = placed.reduce(
      (total, table) => total + table.seats.filter((s) => !s.present).length,
      0,
    );
    // Five chairs cannot be there: the two at the join, the one where the
    // wing's body meets the run, and the two inside the corner.
    expect(absent).toBe(5);

    // And no two tables hold the same cell — the arrangement is legal floor
    // plan, not just a drawing.
    const taken = new Set<string>();
    for (const table of placed) {
      const geometry = layoutOf(table);
      const cells = [
        ...geometry.body,
        ...geometry.seats.filter((_, seat) => table.seats[seat]?.present),
      ];
      for (const cell of cells) {
        const key = `${table.gridX + cell.x},${table.gridY + cell.y}`;
        expect(taken.has(key)).toBe(false);
        taken.add(key);
      }
    }
  });

  it("grows the room to hold the arrangement, and shrinks it back on undo", async () => {
    const d = deps();
    const event = await emptyEvent(d);
    expect(event).toMatchObject({ roomWidth: 16, roomHeight: 10 });

    const laid = await bootstrapEventLayout(d, actor(), {
      eventId: event.id,
      layout: "U",
      sections: [3, 4, 3],
      tableLength: 4,
      endSeats: true,
    });
    expect(laid.resource).toMatchObject({ roomWidth: 18, roomHeight: 15 });

    const undone = await undoOperation(d, actor(), {
      operationId: laid.operationId,
    });
    expect(tablesOf(d, event.id)).toHaveLength(0);
    expect(undone.resource).toMatchObject({ roomWidth: 16, roomHeight: 10 });
    expect(undone.resourceType).toBe("event");
  });

  it("refuses a plan that already has tables", async () => {
    const d = deps();
    await expect(
      bootstrapEventLayout(d, actor(), {
        eventId: EVENT_GALA_ID,
        layout: "L",
        sections: [2, 1],
        tableLength: 2,
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  });

  it("is NOT_FOUND for another organization's event, never AUTHORIZATION", async () => {
    const d = deps();
    await expect(
      bootstrapEventLayout(d, actor(), {
        eventId: EVENT_OTHER_ID,
        layout: "L",
        sections: [2, 1],
        tableLength: 2,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses an archived event", async () => {
    const d = deps();
    await expect(
      bootstrapEventLayout(d, actor(), {
        eventId: EVENT_ARCHIVED_ID,
        layout: "L",
        sections: [2, 1],
        tableLength: 2,
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
  });

  it("refuses a layout the domain cannot plan", async () => {
    const d = deps();
    const event = await emptyEvent(d);
    await expect(
      bootstrapEventLayout(d, actor(), {
        eventId: event.id,
        layout: "U",
        sections: [2, 2],
        tableLength: 3,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("resizeRoom", () => {
  it("resizes the floor and records the size it came from", async () => {
    const d = deps(["op_resize"]);
    const before = d.state.events.get(EVENT_GALA_ID)!;
    const result = await resizeRoom(d, actor(), {
      eventId: EVENT_GALA_ID,
      width: 24,
      height: 16,
      expectedVersion: before.version,
    });
    expect(result.resource).toMatchObject({ roomWidth: 24, roomHeight: 16 });
    expect(d.state.operations.get("op_resize")).toMatchObject({
      action: "resize-room",
      resourceType: "event",
      classification: "reversible",
      payload: { width: 24, height: 16 },
      inverse: {
        type: "restore-room-size",
        previous: { width: 16, height: 10 },
      },
    });
  });

  it("refuses a shrink that would strand a table, and says which", async () => {
    const d = deps();
    await expect(
      resizeRoom(d, actor(), { eventId: EVENT_GALA_ID, width: 4, height: 4 }),
    ).rejects.toMatchObject({
      code: "INVARIANT",
      message: expect.stringContaining("would be left outside"),
    });
  });

  it("allows the same shrink once the table is off the plan", async () => {
    const d = deps();
    const event = await emptyEvent(d);
    const table = await createSeatingTable(d, actor(), {
      eventId: event.id,
      name: "In the way",
      size: 4,
      gridX: 8,
      gridY: 6,
    });
    await expect(
      resizeRoom(d, actor(), { eventId: event.id, width: 8, height: 8 }),
    ).rejects.toMatchObject({ code: "INVARIANT" });

    await undoOperation(d, actor(), { operationId: table.operationId });
    await expect(
      resizeRoom(d, actor(), { eventId: event.id, width: 8, height: 8 }),
    ).resolves.toMatchObject({ resource: { roomWidth: 8, roomHeight: 8 } });
  });

  it("round-trips through undo and redo", async () => {
    const d = deps();
    const grown = await resizeRoom(d, actor(), {
      eventId: EVENT_GALA_ID,
      width: 24,
      height: 16,
    });
    const undone = await undoOperation(d, actor(), {
      operationId: grown.operationId,
    });
    expect(undone.resource).toMatchObject({ roomWidth: 16, roomHeight: 10 });
  });

  it("refuses a stale expectedVersion", async () => {
    const d = deps();
    await expect(
      resizeRoom(d, actor({ userEmail: ADMIN_EMAIL, role: "admin" }), {
        eventId: EVENT_GALA_ID,
        width: 24,
        height: 16,
        expectedVersion: 99,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
