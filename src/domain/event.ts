/**
 * Event domain model (blueprint B4).
 *
 * An event is the container a seating arrangement belongs to — a wedding, a
 * conference dinner, an offsite. It owns exactly one floor plan, which is the
 * set of `SeatingTable` rows that name it as their `eventId`.
 *
 * It also owns the **room** those tables stand in. The size of the floor is a
 * property of the occasion, not a constant of the application: a head table for
 * two hundred needs a room a wedding breakfast for twenty does not, and a venue
 * bootstrap sizes the room to the layout it was asked for. Every placement rule
 * in `seating-table.ts` therefore takes the room as an argument.
 *
 * Plain object plus pure functions: no I/O, no `Date.now()` — time is always an
 * argument (`now`) so every caller controls it and tests stay deterministic.
 * Every mutation returns a new object with `version: previous.version + 1` and
 * `updatedAt: now`; nothing here mutates its input.
 */

import { DomainError } from "./errors";
import {
  boundingBoxOf,
  DEFAULT_ROOM_HEIGHT,
  DEFAULT_ROOM_WIDTH,
  MAX_ROOM_HEIGHT,
  MAX_ROOM_WIDTH,
  MIN_ROOM_SIZE,
  type Room,
  type SeatingTable,
} from "./seating-table";

export type EventStatus = "active" | "archived";

export interface Event {
  id: string;
  orgId: string;
  name: string;
  /** ISO 8601 instant the event starts. */
  startsAt: string;
  /** How big the floor is, in grid cells. */
  roomWidth: number;
  roomHeight: number;
  status: EventStatus;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewEventInput {
  id: string;
  orgId: string;
  name: string;
  startsAt: string;
  /** Defaults to 16 by 10; a bootstrap grows it later if a layout needs more. */
  roomWidth?: number;
  roomHeight?: number;
  createdBy: string;
  now: string;
}

const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 120;

/** Trimmed length 1..120; the trimmed value is what gets stored. */
function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME_LENGTH || trimmed.length > MAX_NAME_LENGTH) {
    throw new DomainError(
      "VALIDATION",
      `Event name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters`,
    );
  }
  return trimmed;
}

/**
 * Accepts anything `Date` can parse and stores the canonical ISO 8601 form, so
 * two spellings of the same instant compare equal in the database and in a
 * recorded inverse.
 */
function normalizeStartsAt(startsAt: string): string {
  const parsed = new Date(startsAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError(
      "VALIDATION",
      "Event start must be a valid ISO 8601 instant",
    );
  }
  return parsed.toISOString();
}

/** The room every event's floor plan starts at. */
export function defaultRoom(): Room {
  return { width: DEFAULT_ROOM_WIDTH, height: DEFAULT_ROOM_HEIGHT };
}

export function roomOf(event: Event): Room {
  return { width: event.roomWidth, height: event.roomHeight };
}

function assertRoom(room: Room): void {
  const whole = Number.isInteger(room.width) && Number.isInteger(room.height);
  if (
    !whole ||
    room.width < MIN_ROOM_SIZE ||
    room.height < MIN_ROOM_SIZE ||
    room.width > MAX_ROOM_WIDTH ||
    room.height > MAX_ROOM_HEIGHT
  ) {
    throw new DomainError(
      "VALIDATION",
      `A room must be a whole number of cells, ${MIN_ROOM_SIZE} to ${MAX_ROOM_WIDTH} across and ${MIN_ROOM_SIZE} to ${MAX_ROOM_HEIGHT} down`,
    );
  }
}

/**
 * Refuses a room that would leave a table outside it.
 *
 * Named, because "the room is too small" is not actionable — the user has to
 * know which table to move first. Only active tables count: an archived one
 * holds no space and comes back through an undo that re-checks placement
 * itself.
 */
function assertRoomFitsTables(
  room: Room,
  tables: readonly SeatingTable[],
): void {
  for (const table of tables) {
    if (table.status !== "active") continue;
    const box = boundingBoxOf(table);
    if (box.x + box.width > room.width || box.y + box.height > room.height) {
      throw new DomainError(
        "INVARIANT",
        `"${table.name}" would be left outside a ${room.width} by ${room.height} room; move it first`,
      );
    }
  }
}

export function createEvent(input: NewEventInput): Event {
  const room: Room = {
    width: input.roomWidth ?? DEFAULT_ROOM_WIDTH,
    height: input.roomHeight ?? DEFAULT_ROOM_HEIGHT,
  };
  assertRoom(room);
  return {
    id: input.id,
    orgId: input.orgId,
    name: normalizeName(input.name),
    startsAt: normalizeStartsAt(input.startsAt),
    roomWidth: room.width,
    roomHeight: room.height,
    status: "active",
    version: 1,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function archiveEvent(event: Event, now: string): Event {
  if (event.status === "archived") {
    throw new DomainError(
      "INVARIANT",
      "Cannot archive an event that is archived",
    );
  }
  return {
    ...event,
    status: "archived",
    version: event.version + 1,
    updatedAt: now,
  };
}

/**
 * Un-archives an event. Used by `undoOperation` (B9) to reverse `archive-event`
 * and to compensate `create-event`'s inverse in the other direction; the
 * version is still bumped like any other mutation.
 */
export function restoreEvent(event: Event, now: string): Event {
  if (event.status === "active") {
    throw new DomainError(
      "INVARIANT",
      "Cannot restore an event that is active",
    );
  }
  return {
    ...event,
    status: "active",
    version: event.version + 1,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

/**
 * Resizes the floor.
 *
 * Growing always works. Shrinking is refused when a table would end up outside
 * the new bounds — the alternative would be a floor plan that violates its own
 * placement rule, with tables standing in a room that does not reach them.
 */
export function resizeRoom(
  event: Event,
  room: Room,
  tables: readonly SeatingTable[],
  now: string,
): Event {
  if (event.status === "archived") {
    throw new DomainError(
      "INVARIANT",
      "Cannot resize the room of an event that is archived",
    );
  }
  assertRoom(room);
  if (room.width === event.roomWidth && room.height === event.roomHeight) {
    throw new DomainError("INVARIANT", "The room is already that size");
  }
  assertRoomFitsTables(room, tables);
  return {
    ...event,
    roomWidth: room.width,
    roomHeight: room.height,
    version: event.version + 1,
    updatedAt: now,
  };
}

/**
 * Enlarges the room to hold `needed`, keeping whichever dimension is already
 * bigger. Used by the venue bootstrap, which knows how much floor its layout
 * wants and should not make the user work it out.
 *
 * It bumps the version even when the room was already big enough. A bootstrap
 * is one operation against the event whether or not the floor had to grow, and
 * an operation whose `versionAfter` did not move could not be undone under the
 * rule in `canUndo`.
 */
export function growRoomToFit(event: Event, needed: Room, now: string): Event {
  if (event.status === "archived") {
    throw new DomainError(
      "INVARIANT",
      "Cannot lay out an event that is archived",
    );
  }
  const room: Room = {
    width: Math.max(event.roomWidth, needed.width),
    height: Math.max(event.roomHeight, needed.height),
  };
  assertRoom(room);
  return {
    ...event,
    roomWidth: room.width,
    roomHeight: room.height,
    version: event.version + 1,
    updatedAt: now,
  };
}

/** Undo twin for `resize-room` and for a bootstrap that grew the floor. It
 * re-checks the tables, because somebody may have placed one in the space that
 * is about to disappear again. */
export function restoreRoomSize(
  event: Event,
  previous: Room,
  tables: readonly SeatingTable[],
  now: string,
): Event {
  assertRoom(previous);
  assertRoomFitsTables(previous, tables);
  return {
    ...event,
    roomWidth: previous.width,
    roomHeight: previous.height,
    version: event.version + 1,
    updatedAt: now,
  };
}
