/**
 * Venue layouts — planning an L- or U-shaped arrangement of ordinary tables.
 *
 * A table is never itself bent (`seating-table.ts`). An L- or U-shaped
 * *arrangement* is several rectangular tables standing against one another, and
 * laying one out by hand is fiddly work: every table has to be placed to the
 * cell, and every chair that would stand where the next table's body goes has
 * to be taken off first, or the floor plan refuses the placement.
 *
 * This module does that arithmetic. It is pure and knows nothing about
 * persistence: it answers "given these section sizes, where does each table go,
 * which of its chairs cannot be there, and how big a room does the whole thing
 * need" — and the use case turns that into real tables in one atomic write.
 *
 * ## Sections
 *
 * A section is **one continuous run**: `n` tables whose bodies are adjacent end
 * to end, reading as a single long surface rather than a row of separate
 * tables.
 *
 *     L    [across, down]                across the top, then down from its right end
 *     U    [leftWing, middle, rightWing]  middle across the top, a wing down from each end
 *
 * ## Which chairs come off, and why
 *
 * Cells are allocated in two passes. **Every body cell is reserved first**, then
 * each table's chairs are offered their cells in turn and a chair is dropped
 * when its cell is already taken.
 *
 * Bodies first is the whole trick. A chair and a body want the same cell at
 * every join and at every corner, and the body has to win — a table cannot give
 * up the space it physically occupies, while a chair can simply not be there.
 * Doing it in one pass would let whichever table happened to be placed first
 * keep a chair standing inside the next table's body.
 *
 * What falls out is exactly what a person would do with real furniture: the two
 * end chairs at each join come off because the neighbouring table is there, and
 * the chairs on the inside of each corner come off because the other run is.
 * Nothing here enumerates them.
 */

import { DomainError } from "./errors";
import {
  layoutOf,
  MAX_TABLE_LENGTH,
  MIN_TABLE_SIZE,
  normalizeShape,
  type Cell,
  type Room,
  type SeatingTablePosition,
  type TableShape,
} from "./seating-table";

export type LayoutKind = "L" | "U";

export const LAYOUT_KINDS: readonly LayoutKind[] = ["L", "U"];

/** How many runs each layout is made of. */
export const SECTION_COUNT: Readonly<Record<LayoutKind, number>> = {
  L: 2,
  U: 3,
};

/** The most tables one run may hold. A run longer than this cannot fit any
 * legal room even at the shortest table. */
export const MAX_SECTION_TABLES = 12;

export interface LayoutRequest {
  kind: LayoutKind;
  /** Tables per section. L: `[across, down]`. U: `[leftWing, middle, rightWing]`. */
  sections: readonly number[];
  /** Every table in the layout is this long, in cells. */
  tableLength: number;
  /** Whether the run is capped with a chair at each far end. The chairs at the
   * joins *between* tables come off either way — that is where the next table
   * stands. */
  endSeats: boolean;
}

export interface PlannedTable {
  shape: TableShape;
  gridX: number;
  gridY: number;
  /** Seat indices that cannot be there, because another table of this layout
   * stands in the cell. Ascending. */
  removed: readonly number[];
}

export interface PlannedLayout {
  /** The floor this layout needs. The event's room is grown to hold it. */
  room: Room;
  tables: readonly PlannedTable[];
}

/** Which way a run travels, and therefore how its tables are turned. */
type Run = "across" | "down";

interface Placement extends SeatingTablePosition {
  shape: TableShape;
}

/**
 * Where a table's bounding box goes, given where its *body* should start.
 *
 * The caller reasons in body cells — that is what has to line up for a run to
 * be continuous — but a table is positioned by its bounding box, which includes
 * the ring of chairs around it. This is the one conversion between the two.
 */
function placeByBody(
  shape: TableShape,
  bodyX: number,
  bodyY: number,
): Placement {
  const first = layoutOf(shape).body[0]!;
  return { shape, gridX: bodyX - first.x, gridY: bodyY - first.y };
}

/** One continuous run of `count` tables, bodies adjacent end to end. */
function run(
  direction: Run,
  count: number,
  length: number,
  endSeats: boolean,
  bodyX: number,
  bodyY: number,
): Placement[] {
  const shape = normalizeShape({
    kind: "rectangle",
    size: length,
    endSeats,
    rotation: direction === "across" ? 0 : 90,
  });
  return Array.from({ length: count }, (_, index) =>
    direction === "across"
      ? placeByBody(shape, bodyX + index * length, bodyY)
      : placeByBody(shape, bodyX, bodyY + index * length),
  );
}

/**
 * Where every table of the layout stands, in an arbitrary frame that
 * `planVenueLayout` normalises afterwards.
 *
 * The body of the across (or middle) run occupies row 0 from column 0, so a
 * wing hangs off the body column at one end of it and starts one row below.
 */
function placements(request: LayoutRequest): Placement[] {
  const { sections, tableLength: len, endSeats } = request;
  if (request.kind === "L") {
    const [across, down] = sections as [number, number];
    const corner = across * len - 1;
    return [
      ...run("across", across, len, endSeats, 0, 0),
      ...run("down", down, len, endSeats, corner, 1),
    ];
  }
  const [leftWing, middle, rightWing] = sections as [number, number, number];
  const rightColumn = middle * len - 1;
  return [
    ...run("across", middle, len, endSeats, 0, 0),
    ...run("down", leftWing, len, endSeats, 0, 1),
    ...run("down", rightWing, len, endSeats, rightColumn, 1),
  ];
}

function assertRequest(request: LayoutRequest): void {
  const expected = SECTION_COUNT[request.kind];
  if (!expected) {
    throw new DomainError("VALIDATION", `Unknown layout "${request.kind}"`);
  }
  if (request.sections.length !== expected) {
    throw new DomainError(
      "VALIDATION",
      `A ${request.kind} layout has ${expected} sections, not ${request.sections.length}`,
    );
  }
  for (const count of request.sections) {
    if (!Number.isInteger(count) || count < 1 || count > MAX_SECTION_TABLES) {
      throw new DomainError(
        "VALIDATION",
        `Each section must have between 1 and ${MAX_SECTION_TABLES} tables`,
      );
    }
  }
  if (
    !Number.isInteger(request.tableLength) ||
    request.tableLength < MIN_TABLE_SIZE ||
    request.tableLength > MAX_TABLE_LENGTH
  ) {
    throw new DomainError(
      "VALIDATION",
      `Each table must be a whole number of cells between ${MIN_TABLE_SIZE} and ${MAX_TABLE_LENGTH} long`,
    );
  }
}

/**
 * Plans the whole arrangement: where each table stands, which of its chairs
 * cannot be there, and the room it all needs.
 *
 * Positions are normalised so the layout sits against the top-left corner of
 * the room it asks for, which is also the room a caller should grow the event
 * to before writing any of this down.
 */
export function planVenueLayout(request: LayoutRequest): PlannedLayout {
  assertRequest(request);
  const placed = placements(request);

  // Pass one: every body cell, before any chair is considered. A collision here
  // would mean the arithmetic above put two tables in the same place, which is
  // this module's own bug rather than anything a caller did.
  const taken = new Set<string>();
  const cells = placed.map((placement) => {
    const layout = layoutOf(placement.shape);
    const at = (cell: Cell): Cell => ({
      x: placement.gridX + cell.x,
      y: placement.gridY + cell.y,
    });
    return { body: layout.body.map(at), seats: layout.seats.map(at) };
  });
  for (const table of cells) {
    for (const cell of table.body) {
      const key = `${cell.x},${cell.y}`;
      if (taken.has(key)) {
        throw new DomainError(
          "INVARIANT",
          "That layout would stand two tables in the same place",
        );
      }
      taken.add(key);
    }
  }

  // Pass two: offer each chair its cell, in table and then seat order. A chair
  // whose cell is spoken for is simply not there.
  const removedPerTable = cells.map((table) => {
    const removed: number[] = [];
    table.seats.forEach((cell, index) => {
      const key = `${cell.x},${cell.y}`;
      if (taken.has(key)) {
        removed.push(index);
        return;
      }
      taken.add(key);
    });
    return removed;
  });

  // Normalise: shift everything so the arrangement sits against the top-left
  // corner, and measure what is left.
  const occupied = [...taken].map((key) => {
    const [x, y] = key.split(",");
    return { x: Number(x), y: Number(y) };
  });
  const minX = Math.min(...occupied.map((cell) => cell.x));
  const minY = Math.min(...occupied.map((cell) => cell.y));
  const maxX = Math.max(...occupied.map((cell) => cell.x));
  const maxY = Math.max(...occupied.map((cell) => cell.y));

  return {
    room: { width: maxX - minX + 1, height: maxY - minY + 1 },
    tables: placed.map((placement, index) => ({
      shape: placement.shape,
      gridX: placement.gridX - minX,
      gridY: placement.gridY - minY,
      removed: removedPerTable[index]!,
    })),
  };
}
