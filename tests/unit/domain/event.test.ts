import { describe, expect, it } from "vitest";

import {
  archiveEvent,
  createEvent,
  createSeatingTable,
  DEFAULT_ROOM_HEIGHT,
  DEFAULT_ROOM_WIDTH,
  DomainError,
  growRoomToFit,
  resizeRoom,
  restoreEvent,
  restoreRoomSize,
  roomOf,
  type Event,
  type NewEventInput,
  type SeatingTable,
} from "../../../src/domain";

const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";

function baseInput(overrides: Partial<NewEventInput> = {}): NewEventInput {
  return {
    id: "evt_1",
    orgId: "org_1",
    name: "Spring Gala",
    startsAt: "2026-05-16T18:00:00.000Z",
    createdBy: "owner@example.invalid",
    now,
    ...overrides,
  };
}

describe("createEvent", () => {
  it("creates an active event at version 1", () => {
    expect(createEvent(baseInput())).toEqual<Event>({
      id: "evt_1",
      orgId: "org_1",
      name: "Spring Gala",
      startsAt: "2026-05-16T18:00:00.000Z",
      roomWidth: DEFAULT_ROOM_WIDTH,
      roomHeight: DEFAULT_ROOM_HEIGHT,
      status: "active",
      version: 1,
      createdBy: "owner@example.invalid",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("stores the trimmed name", () => {
    expect(createEvent(baseInput({ name: "  Spring Gala  " })).name).toBe(
      "Spring Gala",
    );
  });

  it("rejects a name that is empty after trimming", () => {
    expect(() => createEvent(baseInput({ name: "   " }))).toThrow(DomainError);
    expect(() => createEvent(baseInput({ name: "   " }))).toThrow(
      "Event name must be between 1 and 120 characters",
    );
  });

  it("accepts a name at the 120 character boundary and rejects one past it", () => {
    expect(createEvent(baseInput({ name: "a".repeat(120) })).name).toHaveLength(
      120,
    );
    expect(() => createEvent(baseInput({ name: "a".repeat(121) }))).toThrow(
      DomainError,
    );
  });

  it("stores the canonical ISO form of the start instant", () => {
    expect(
      createEvent(baseInput({ startsAt: "2026-05-16T20:00:00+02:00" }))
        .startsAt,
    ).toBe("2026-05-16T18:00:00.000Z");
  });

  it("rejects a start that is not a valid instant", () => {
    expect(() => createEvent(baseInput({ startsAt: "next friday" }))).toThrow(
      "Event start must be a valid ISO 8601 instant",
    );
  });
});

describe("archiveEvent and restoreEvent", () => {
  it("archives an active event and bumps the version once", () => {
    const archived = archiveEvent(createEvent(baseInput()), later);
    expect(archived.status).toBe("archived");
    expect(archived.version).toBe(2);
    expect(archived.updatedAt).toBe(later);
  });

  it("refuses to archive an event that is already archived", () => {
    const archived = archiveEvent(createEvent(baseInput()), later);
    expect(() => archiveEvent(archived, later)).toThrow(
      "Cannot archive an event that is archived",
    );
  });

  it("restores an archived event", () => {
    const restored = restoreEvent(
      archiveEvent(createEvent(baseInput()), later),
      later,
    );
    expect(restored.status).toBe("active");
    expect(restored.version).toBe(3);
  });

  it("refuses to restore an event that is active", () => {
    expect(() => restoreEvent(createEvent(baseInput()), later)).toThrow(
      "Cannot restore an event that is active",
    );
  });
});

/**
 * The room belongs to the event, so these are event transitions — and the one
 * rule worth having is that a shrink may not strand a table.
 */
describe("the room", () => {
  const event = createEvent(baseInput());

  /** A table standing against the far corner of the default room. */
  function cornerTable(): SeatingTable {
    return createSeatingTable(
      {
        id: "tbl_corner",
        orgId: "org_1",
        eventId: "evt_1",
        name: "Corner",
        size: 4,
        endSeats: true,
        gridX: DEFAULT_ROOM_WIDTH - 6,
        gridY: DEFAULT_ROOM_HEIGHT - 3,
        createdBy: "owner@example.invalid",
        now,
      },
      { room: roomOf(event), tables: [] },
    );
  }

  it("starts at the default and can be given one on creation", () => {
    expect(roomOf(event)).toEqual({ width: 16, height: 10 });
    expect(
      roomOf(createEvent(baseInput({ roomWidth: 30, roomHeight: 20 }))),
    ).toEqual({ width: 30, height: 20 });
  });

  it("rejects a room outside the bounds, or a fractional one", () => {
    expect(() => createEvent(baseInput({ roomWidth: 3 }))).toThrow(DomainError);
    expect(() => createEvent(baseInput({ roomHeight: 41 }))).toThrow(
      DomainError,
    );
    expect(() => createEvent(baseInput({ roomWidth: 16.5 }))).toThrow(
      DomainError,
    );
  });

  it("grows, and bumps the version once", () => {
    const bigger = resizeRoom(event, { width: 24, height: 16 }, [], later);
    expect(roomOf(bigger)).toEqual({ width: 24, height: 16 });
    expect(bigger.version).toBe(event.version + 1);
    expect(bigger.updatedAt).toBe(later);
  });

  it("refuses a shrink that would strand a table, naming it", () => {
    const tables = [cornerTable()];
    expect(() =>
      resizeRoom(event, { width: 8, height: 8 }, tables, later),
    ).toThrow('"Corner" would be left outside a 8 by 8 room; move it first');
    // The same shrink is fine once the table is off the plan.
    expect(() =>
      resizeRoom(
        event,
        { width: 8, height: 8 },
        [{ ...tables[0]!, status: "archived" as const }],
        later,
      ),
    ).not.toThrow();
  });

  it("refuses a no-op and an archived event", () => {
    expect(() => resizeRoom(event, roomOf(event), [], later)).toThrow(
      "The room is already that size",
    );
    expect(() =>
      resizeRoom(
        archiveEvent(event, later),
        { width: 20, height: 12 },
        [],
        later,
      ),
    ).toThrow("Cannot resize the room of an event that is archived");
  });

  /** The bootstrap's path: it knows what its layout needs and should not make
   * the user work the size out. */
  it("grows to fit without ever shrinking", () => {
    const grown = growRoomToFit(event, { width: 30, height: 4 }, later);
    // Wider where the layout asked for it, and no shorter than it was.
    expect(roomOf(grown)).toEqual({ width: 30, height: 10 });
  });

  it("bumps the version even when the room was already big enough", () => {
    // A bootstrap is one operation against the event whether or not the floor
    // had to grow, and an operation whose version did not move cannot be undone.
    const same = growRoomToFit(event, { width: 4, height: 4 }, later);
    expect(roomOf(same)).toEqual(roomOf(event));
    expect(same.version).toBe(event.version + 1);
  });

  it("restores a previous size, but not over a table placed since", () => {
    const grown = resizeRoom(event, { width: 24, height: 16 }, [], later);
    expect(roomOf(restoreRoomSize(grown, roomOf(event), [], later))).toEqual(
      roomOf(event),
    );
    const late = createSeatingTable(
      {
        id: "tbl_late",
        orgId: "org_1",
        eventId: "evt_1",
        name: "Latecomer",
        size: 4,
        gridX: 18,
        gridY: 12,
        createdBy: "owner@example.invalid",
        now: later,
      },
      { room: roomOf(grown), tables: [] },
    );
    expect(() => restoreRoomSize(grown, roomOf(event), [late], later)).toThrow(
      "would be left outside",
    );
  });
});
