/**
 * Seating table domain model (blueprint B4).
 *
 * One table on an event's floor plan, the seats around it, and whatever a user
 * wrote on each seat. Seats are value objects of the table: they have no
 * lifecycle of their own, they are never addressed without it, and they are
 * *derived from the table's shape* — what a user authors about a seat is its
 * label, and whether it is there at all.
 *
 * ## Shape
 *
 * A table is **round or rectangular**, and its body is always an axis-aligned
 * block of whole grid cells:
 *
 *     rectangle   size × 1      a straight run, `size` cells long
 *     round       size × size   a square block, drawn as a circle
 *
 * `rotation` turns a rectangle in quarter turns clockwise. A round table's body
 * is square, so turning it would change nothing anybody could see; its rotation
 * is always 0 and `rotateSeatingTable` refuses it.
 *
 * A table is never itself bent. An L- or U-shaped *arrangement* is several
 * tables standing against one another, which is what `venue-layout.ts` plans
 * and what the cell occupancy below allows.
 *
 * ## Seats
 *
 * A seat exists at **every cell orthogonally touching the body** — the ring
 * around the block, corners excluded — walked clockwise from the top-left. That
 * is `2w + 2h` seats: `2n + 2` down the sides and ends of a rectangle, and `4n`
 * around a round table of diameter `n`. A rectangle with `endSeats` off drops
 * the two single-cell ends; a round table has no ends to drop.
 *
 * Nothing enumerates seats by hand. A round table of diameter 2 seats 8 because
 * eight cells touch a 2×2 block, not because a rule says so.
 *
 * ## Seat identity
 *
 * A seat is its **index in that clockwise walk**, and the stored `seats` array
 * is in the same order. The index is stable under rotation — the ring is built
 * in the canonical, unrotated frame and turned afterwards — so turning a table
 * never moves a guest. It is *not* stable under reshaping, which renumbers the
 * perimeter; that is why a reshape records the whole seat array as its inverse.
 *
 * ## Occupancy, and why an empty chair holds nothing
 *
 * What a table **claims** is its body cells plus one cell per seat that has a
 * name on it. An empty chair claims nothing at all.
 *
 * That is the rule that lets tables be pushed together: drag one table's end
 * against another's and, as long as nobody is sitting in the chairs that meet,
 * the bodies may touch. Physically it is the obvious thing — an empty chair is
 * pushed in or moved aside without a thought, where a chair with somebody in it
 * is not.
 *
 * A seat whose cell is claimed by another table is **blocked**: there is no
 * chair there while the neighbour stands there, so it is not drawn, not offered
 * and cannot be named (`blockedSeats`). Blocked is *derived* from the floor
 * plan every time it is asked, never stored — put the neighbour somewhere else
 * and the chair is simply back.
 *
 * The room those cells live in belongs to the **event**, not to this module, so
 * every placement rule takes a `FloorPlan` — the room's size and the other
 * tables standing in it. Overlap is checked here so the caller gets a precise
 * `INVARIANT`, but this check is not the authority: `plan.tables` is a snapshot,
 * and two people moving two different tables could each pass it against a stale
 * one. The binding check is the `seating_cells` table, whose primary key is
 * `(org_id, event_id, x, y)`.
 *
 * Plain object plus pure functions: no I/O, no `Date.now()` — time is always an
 * argument (`now`). Every mutation returns a new object with
 * `version: previous.version + 1` and `updatedAt: now`; nothing here mutates
 * its input.
 */

import { DomainError } from "./errors";

export type TableShapeKind = "rectangle" | "round";
export type SeatingTableStatus = "active" | "archived";
/** Quarter turns clockwise. */
export type Rotation = 0 | 90 | 180 | 270;

export const TABLE_SHAPE_KINDS: readonly TableShapeKind[] = [
  "rectangle",
  "round",
];
export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

/** The room a new event starts with. Rooms belong to events (`event.ts`); these
 * are only the defaults and the outer bounds. */
export const DEFAULT_ROOM_WIDTH = 16;
export const DEFAULT_ROOM_HEIGHT = 10;
export const MIN_ROOM_SIZE = 4;
export const MAX_ROOM_WIDTH = 64;
export const MAX_ROOM_HEIGHT = 40;

export const MIN_TABLE_SIZE = 1;
/** A rectangle's run, in cells. */
export const MAX_TABLE_LENGTH = 8;
/** A round table's diameter. Bigger than this and the middle of the table is
 * out of arm's reach of everybody sitting at it. */
export const MAX_ROUND_DIAMETER = 4;

export const MAX_SEAT_LABEL_LENGTH = 32;
export const MAX_TABLE_NAME_LENGTH = 60;

/** The largest `size` each kind allows. */
export const MAX_SIZE: Readonly<Record<TableShapeKind, number>> = {
  rectangle: MAX_TABLE_LENGTH,
  round: MAX_ROUND_DIAMETER,
};

/** What a user authored about a seat: the name of whoever sits there, or `""`
 * for nobody. A seat's identity is its position in the table's `seats` array.
 *
 * There is deliberately no "is the chair there" flag. Whether a chair can be
 * there is a fact about the floor plan, not about the table, so it is derived
 * by `blockedSeats` rather than stored and kept in step. */
export interface Seat {
  label: string;
}

/** One whole cell of the floor-plan grid. */
export interface Cell {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How big an event's floor is, in cells. */
export interface Room {
  width: number;
  height: number;
}

/** A table's form, with nothing about where it stands. */
export interface TableShape {
  kind: TableShapeKind;
  /** A rectangle's length, or a round table's diameter, in cells. */
  size: number;
  /** A chair capping each end of a rectangle's run. Always false when round: a
   * round table has no ends. */
  endSeats: boolean;
  /** Always 0 when round. */
  rotation: Rotation;
}

export interface SeatingTablePosition {
  gridX: number;
  gridY: number;
}

export interface SeatingTable extends TableShape, SeatingTablePosition {
  id: string;
  orgId: string;
  eventId: string;
  name: string;
  seats: readonly Seat[];
  status: SeatingTableStatus;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Everything a placement rule needs: how big the room is, and what else is
 * standing in it.
 *
 * One argument rather than two because these are never useful apart — a
 * position is legal only if it is both inside the room and clear of the other
 * tables, and a caller that had one without the other would be checking half
 * the rule.
 */
export interface FloorPlan {
  room: Room;
  tables: readonly SeatingTable[];
}

export interface NewSeatingTableInput {
  id: string;
  orgId: string;
  eventId: string;
  name: string;
  /** Defaults to a rectangle. */
  kind?: TableShapeKind;
  /** A rectangle's length, or a round table's diameter, in cells. */
  size: number;
  endSeats?: boolean;
  /** Quarter turns clockwise; defaults to none, and is forced to none for a
   * round table. */
  rotation?: Rotation;
  gridX: number;
  gridY: number;
  createdBy: string;
  now: string;
}

// ---------------------------------------------------------------------------
// Geometry — pure, and shared with the UI so the drag preview and the server
// agree cell for cell on what counts as a legal placement.
// ---------------------------------------------------------------------------

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** A quarter turn clockwise in screen coordinates, where y grows downward. */
function quarterTurn(cell: Cell): Cell {
  return { x: -cell.y, y: cell.x };
}

function rotateCell(cell: Cell, rotation: Rotation): Cell {
  let turned = cell;
  for (let quarter = 0; quarter < rotation / 90; quarter += 1) {
    turned = quarterTurn(turned);
  }
  return turned;
}

export function shapeOf(table: TableShape): TableShape {
  return {
    kind: table.kind,
    size: table.size,
    endSeats: table.endSeats,
    rotation: table.rotation,
  };
}

/**
 * Whether a kind carries the two extra fields at all.
 *
 * A round table has no ends to seat and no direction to face, so rather than
 * letting a caller store values that mean nothing, both are normalised away
 * here and every transition goes through this.
 */
export function normalizeShape(next: {
  kind: TableShapeKind;
  size: number;
  endSeats?: boolean;
  rotation?: Rotation;
}): TableShape {
  const round = next.kind === "round";
  return {
    kind: next.kind,
    size: next.size,
    endSeats: round ? false : (next.endSeats ?? false),
    rotation: round ? 0 : (next.rotation ?? 0),
  };
}

/** The body's extent in cells, before rotation. */
function canonicalExtent(shape: TableShape): { width: number; height: number } {
  return shape.kind === "round"
    ? { width: shape.size, height: shape.size }
    : { width: shape.size, height: 1 };
}

/** The body cells in the canonical frame: a solid block anchored at 0,0. */
function canonicalBody(shape: TableShape): Cell[] {
  const { width, height } = canonicalExtent(shape);
  const cells: Cell[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) cells.push({ x, y });
  }
  return cells;
}

/**
 * The seat cells, clockwise from the top-left, in the canonical frame.
 *
 * The ring of cells touching the block, corners left out — they touch only
 * diagonally, and nobody sits at the corner of a table. A rectangle runs east
 * in this frame, so its ends are the single cells to left and right, and
 * `endSeats` is what decides whether they carry a chair. A round table's four
 * sides are all full edges, so there is nothing to leave off.
 */
function canonicalSeats(shape: TableShape): Cell[] {
  const { width, height } = canonicalExtent(shape);
  const ends = shape.kind === "round" || shape.endSeats;
  const ring: Cell[] = [];
  for (let x = 0; x < width; x += 1) ring.push({ x, y: -1 });
  if (ends) for (let y = 0; y < height; y += 1) ring.push({ x: width, y });
  for (let x = width - 1; x >= 0; x -= 1) ring.push({ x, y: height });
  if (ends) for (let y = height - 1; y >= 0; y -= 1) ring.push({ x: -1, y });
  return ring;
}

export interface TableLayout {
  /** Body cells, rotated and normalised so the bounding box starts at 0,0. */
  body: readonly Cell[];
  /** Seat cells in the same frame, in clockwise perimeter order. */
  seats: readonly Cell[];
  width: number;
  height: number;
}

/**
 * The whole geometry of a shape: where its body is, where each numbered seat
 * is, and how big the bounding box is. Everything else here and in the UI is
 * built on this one function.
 */
export function layoutOf(shape: TableShape): TableLayout {
  const body = canonicalBody(shape).map((cell) =>
    rotateCell(cell, shape.rotation),
  );
  const seats = canonicalSeats(shape).map((cell) =>
    rotateCell(cell, shape.rotation),
  );
  const all = [...body, ...seats];
  const minX = Math.min(...all.map((cell) => cell.x));
  const minY = Math.min(...all.map((cell) => cell.y));
  const shift = (cell: Cell): Cell => ({ x: cell.x - minX, y: cell.y - minY });
  const shifted = all.map(shift);
  return {
    body: body.map(shift),
    seats: seats.map(shift),
    width: Math.max(...shifted.map((cell) => cell.x)) + 1,
    height: Math.max(...shifted.map((cell) => cell.y)) + 1,
  };
}

export function footprintSize(shape: TableShape): {
  width: number;
  height: number;
} {
  const { width, height } = layoutOf(shape);
  return { width, height };
}

export function seatCount(shape: TableShape): number {
  return layoutOf(shape).seats.length;
}

/** A fresh seat for every position the shape has, carrying over what was on the
 * seat at the same index before. A reshape renumbers the perimeter, so this is
 * a best effort by position, and the recorded inverse is what makes an undo
 * exact. */
export function buildSeats(
  shape: TableShape,
  carryOver: readonly Seat[] = [],
): Seat[] {
  return layoutOf(shape).seats.map((_, index) => ({
    label: carryOver[index]?.label ?? "",
  }));
}

export function boundingBoxOf(table: TableShape & SeatingTablePosition): Rect {
  const { width, height } = footprintSize(table);
  return { x: table.gridX, y: table.gridY, width, height };
}

/** Where seat `index` sits relative to the bounding box. */
export function seatOffset(
  shape: TableShape,
  index: number,
): { column: number; row: number } | null {
  const cell = layoutOf(shape).seats[index];
  return cell ? { column: cell.x, row: cell.y } : null;
}

/**
 * Every cell a table would **claim** standing here: its body, plus one cell per
 * seat with a name on it.
 *
 * An empty chair is left out on purpose. It is what makes two tables able to
 * meet, and it is the whole of the rule — there is no second concept of a chair
 * that has been "taken away".
 */
export function cellsAt(
  shape: TableShape,
  seats: readonly Seat[],
  gridX: number,
  gridY: number,
): Cell[] {
  const layout = layoutOf(shape);
  const cells = layout.body.map((cell) => ({
    x: gridX + cell.x,
    y: gridY + cell.y,
  }));
  layout.seats.forEach((cell, index) => {
    if (seats[index]?.label) {
      cells.push({ x: gridX + cell.x, y: gridY + cell.y });
    }
  });
  return cells;
}

export function cellsOf(table: SeatingTable): Cell[] {
  return cellsAt(table, table.seats, table.gridX, table.gridY);
}

/** The cells an incoming table has to avoid: every cell held by every *other*
 * active table. Archived tables hold nothing. */
export function occupiedCellKeys(
  others: readonly SeatingTable[],
  selfId?: string,
): Set<string> {
  const taken = new Set<string>();
  for (const table of others) {
    if (table.status !== "active" || table.id === selfId) continue;
    for (const cell of cellsOf(table)) taken.add(cellKey(cell.x, cell.y));
  }
  return taken;
}

/**
 * The seats of `table` that have no chair right now, because something else is
 * standing in the cell the chair would occupy.
 *
 * Derived, never stored. A chair is blocked exactly while a neighbour is there
 * and back the moment it moves — a stored flag would have to be kept in step
 * with every move, reshape and rotation of every *other* table on the plan,
 * which is a great deal of bookkeeping for a fact that is one set intersection
 * away.
 *
 * Two things block a chair:
 *
 *   * **A claimed cell** — another table's body, or a chair with somebody in
 *     it. There is no room for this chair while that is there.
 *   * **Another table's empty chair, if that table came first.** Two empty
 *     chairs contending for one cell are not two chairs: they are one piece of
 *     furniture that both tables could use, and drawing it twice would be a
 *     lie. `plan.tables` is in creation order, so the table that was there
 *     first keeps it and the newcomer goes without — the same first-come rule
 *     the rest of the floor plan runs on.
 *
 * A table's own cells never block its own chairs.
 */
export function blockedSeats(
  table: SeatingTable,
  plan: FloorPlan,
): Set<number> {
  const taken = occupiedCellKeys(plan.tables, table.id);
  // A table not on the plan — a drag preview, a table being built — is treated
  // as the newest, so it yields rather than taking a chair off something real.
  const position = plan.tables.findIndex((other) => other.id === table.id);
  const earlier =
    position === -1 ? plan.tables : plan.tables.slice(0, position);
  for (const other of earlier) {
    if (other.status !== "active" || other.id === table.id) continue;
    const layout = layoutOf(other);
    layout.seats.forEach((cell, index) => {
      // A filled chair is already in `taken`; this is only about empty ones.
      if (other.seats[index]?.label) return;
      taken.add(cellKey(other.gridX + cell.x, other.gridY + cell.y));
    });
  }

  const blocked = new Set<number>();
  if (taken.size === 0) return blocked;
  layoutOf(table).seats.forEach((cell, index) => {
    if (taken.has(cellKey(table.gridX + cell.x, table.gridY + cell.y))) {
      blocked.add(index);
    }
  });
  return blocked;
}

/** How many of a table's chairs can actually be sat in. */
export function availableSeatCount(
  table: SeatingTable,
  plan: FloorPlan,
): number {
  return table.seats.length - blockedSeats(table, plan).size;
}

export function isWithinRoom(
  shape: TableShape,
  gridX: number,
  gridY: number,
  room: Room,
): boolean {
  const { width, height } = footprintSize(shape);
  return (
    gridX >= 0 &&
    gridY >= 0 &&
    gridX + width <= room.width &&
    gridY + height <= room.height
  );
}

export function fitsAt(
  shape: TableShape,
  seats: readonly Seat[],
  gridX: number,
  gridY: number,
  occupied: ReadonlySet<string>,
  room: Room,
): boolean {
  if (!isWithinRoom(shape, gridX, gridY, room)) return false;
  return !cellsAt(shape, seats, gridX, gridY).some((cell) =>
    occupied.has(cellKey(cell.x, cell.y)),
  );
}

export function firstFreePlacement(
  shape: TableShape,
  seats: readonly Seat[],
  occupied: ReadonlySet<string>,
  room: Room,
): SeatingTablePosition | null {
  const { width, height } = footprintSize(shape);
  for (let gridY = 0; gridY + height <= room.height; gridY += 1) {
    for (let gridX = 0; gridX + width <= room.width; gridX += 1) {
      if (fitsAt(shape, seats, gridX, gridY, occupied, room)) {
        return { gridX, gridY };
      }
    }
  }
  return null;
}

export function findSeat(
  table: Pick<SeatingTable, "seats">,
  index: number,
): Seat | undefined {
  return table.seats[index];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_TABLE_NAME_LENGTH) {
    throw new DomainError(
      "VALIDATION",
      `Table name must be between 1 and ${MAX_TABLE_NAME_LENGTH} characters`,
    );
  }
  return trimmed;
}

/** The size has to be a whole number of cells in the range its kind allows —
 * a round table's is a diameter, and a wide one puts the middle of the table
 * out of everybody's reach. */
function assertShape(kind: TableShapeKind, size: number): void {
  const most = MAX_SIZE[kind];
  if (!Number.isInteger(size) || size < MIN_TABLE_SIZE || size > most) {
    throw new DomainError(
      "VALIDATION",
      kind === "round"
        ? `A round table's diameter must be a whole number of cells between ${MIN_TABLE_SIZE} and ${most}`
        : `A table's length must be a whole number of cells between ${MIN_TABLE_SIZE} and ${most}`,
    );
  }
}

function assertCoordinates(position: SeatingTablePosition): void {
  if (
    !Number.isInteger(position.gridX) ||
    !Number.isInteger(position.gridY) ||
    position.gridX < 0 ||
    position.gridY < 0
  ) {
    throw new DomainError(
      "VALIDATION",
      "Table position must be whole, non-negative grid coordinates",
    );
  }
}

function normalizeLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length > MAX_SEAT_LABEL_LENGTH) {
    throw new DomainError(
      "VALIDATION",
      `Seat label must be at most ${MAX_SEAT_LABEL_LENGTH} characters`,
    );
  }
  return trimmed;
}

function assertPlaceable(
  shape: TableShape,
  seats: readonly Seat[],
  gridX: number,
  gridY: number,
  plan: FloorPlan,
  selfId?: string,
): void {
  if (!isWithinRoom(shape, gridX, gridY, plan.room)) {
    throw new DomainError(
      "INVARIANT",
      `A table must stay inside the ${plan.room.width} by ${plan.room.height} room`,
    );
  }
  const occupied = occupiedCellKeys(plan.tables, selfId);
  if (!fitsAt(shape, seats, gridX, gridY, occupied, plan.room)) {
    throw new DomainError("INVARIANT", "Tables may not overlap");
  }
}

function assertActive(table: SeatingTable, verb: string): void {
  if (table.status === "archived") {
    throw new DomainError(
      "INVARIANT",
      `Cannot ${verb} a table that has been removed`,
    );
  }
}

function requireSeat(table: SeatingTable, index: number): Seat {
  const seat = table.seats[index];
  if (!seat) {
    throw new DomainError(
      "VALIDATION",
      `This table has no seat ${index + 1}; it has ${table.seats.length}`,
    );
  }
  return seat;
}

function withSeat(
  seats: readonly Seat[],
  index: number,
  change: Partial<Seat>,
): Seat[] {
  return seats.map((seat, at) =>
    at === index ? { ...seat, ...change } : seat,
  );
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export function createSeatingTable(
  input: NewSeatingTableInput,
  plan: FloorPlan,
): SeatingTable {
  const name = normalizeName(input.name);
  const kind = input.kind ?? "rectangle";
  assertShape(kind, input.size);
  assertCoordinates(input);
  const shape = normalizeShape({
    kind,
    size: input.size,
    endSeats: input.endSeats,
    rotation: input.rotation,
  });
  const seats = buildSeats(shape);
  assertPlaceable(shape, seats, input.gridX, input.gridY, plan);
  return {
    id: input.id,
    orgId: input.orgId,
    eventId: input.eventId,
    name,
    ...shape,
    gridX: input.gridX,
    gridY: input.gridY,
    seats,
    status: "active",
    version: 1,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function moveSeatingTable(
  table: SeatingTable,
  to: SeatingTablePosition,
  plan: FloorPlan,
  now: string,
): SeatingTable {
  assertActive(table, "move");
  assertCoordinates(to);
  if (to.gridX === table.gridX && to.gridY === table.gridY) {
    throw new DomainError("INVARIANT", "The table is already in that spot");
  }
  assertPlaceable(table, table.seats, to.gridX, to.gridY, plan, table.id);
  return {
    ...table,
    gridX: to.gridX,
    gridY: to.gridY,
    version: table.version + 1,
    updatedAt: now,
  };
}

/**
 * Where a table lands when it turns a quarter turn clockwise.
 *
 * It pivots about the centre of its own bounding box rather than its top-left
 * corner, so a table turns roughly in place instead of sweeping across the
 * room, and the result is nudged back inside the room.
 *
 * `Math.trunc`, not `Math.round`, because the offsets of a turn and its reverse
 * are exact negatives and truncation is the rounding symmetric about zero. With
 * `round`, a half-cell offset would go up both times and a table would creep
 * across the room every time it was turned.
 */
export function rotatedPlacement(
  table: SeatingTable,
  room: Room,
): TableShape & SeatingTablePosition {
  const rotation = ((table.rotation + 90) % 360) as Rotation;
  const shape: TableShape = { ...shapeOf(table), rotation };
  const before = footprintSize(table);
  const after = footprintSize(shape);
  const clamp = (value: number, max: number) =>
    Math.min(Math.max(value, 0), max);
  return {
    ...shape,
    gridX: clamp(
      table.gridX + Math.trunc((before.width - after.width) / 2),
      room.width - after.width,
    ),
    gridY: clamp(
      table.gridY + Math.trunc((before.height - after.height) / 2),
      room.height - after.height,
    ),
  };
}

export function rotateSeatingTable(
  table: SeatingTable,
  plan: FloorPlan,
  now: string,
): SeatingTable {
  assertActive(table, "rotate");
  // A square body turns into itself, so the only thing a turn could do to a
  // round table is renumber its chairs for no visible reason.
  if (table.kind === "round") {
    throw new DomainError(
      "INVARIANT",
      "A round table has no direction to turn",
    );
  }
  const next = rotatedPlacement(table, plan.room);
  assertPlaceable(next, table.seats, next.gridX, next.gridY, plan, table.id);
  return { ...table, ...next, version: table.version + 1, updatedAt: now };
}

/**
 * Changes the table's form: round or rectangular, a different size, or end
 * seats on or off.
 *
 * Reshaping renumbers the perimeter, so seats are carried over by index and a
 * name may land on a different chair or be dropped altogether. That is not
 * papered over — it is why the recorded inverse is the whole previous seat
 * array, so an undo puts every name back exactly where it was.
 */
export function reshapeSeatingTable(
  table: SeatingTable,
  next: { kind: TableShapeKind; size: number; endSeats: boolean },
  plan: FloorPlan,
  now: string,
): SeatingTable {
  assertActive(table, "reshape");
  assertShape(next.kind, next.size);
  const shape = normalizeShape({ ...next, rotation: table.rotation });
  if (
    shape.kind === table.kind &&
    shape.size === table.size &&
    shape.endSeats === table.endSeats
  ) {
    throw new DomainError("INVARIANT", "The table already has that shape");
  }
  const seats = buildSeats(shape, table.seats);
  assertPlaceable(shape, seats, table.gridX, table.gridY, plan, table.id);
  return {
    ...table,
    ...shape,
    seats,
    version: table.version + 1,
    updatedAt: now,
  };
}

/**
 * Writes a name on one seat. An empty label clears it.
 *
 * Naming somebody is what makes a seat claim its cell, so it is the one seat
 * change that can be refused for want of space: while a neighbour is standing
 * in the chair's cell there is no chair to sit in. Clearing a name always
 * works — it only ever gives space up.
 */
export function labelSeat(
  table: SeatingTable,
  index: number,
  label: string,
  plan: FloorPlan,
  now: string,
): SeatingTable {
  assertActive(table, "label a seat of");
  const seat = requireSeat(table, index);
  const normalized = normalizeLabel(label);
  if (normalized === seat.label) {
    throw new DomainError("INVARIANT", "The seat already has that label");
  }
  if (normalized !== "" && blockedSeats(table, plan).has(index)) {
    throw new DomainError(
      "INVARIANT",
      "There is no chair there: another table is standing in that space",
    );
  }
  return {
    ...table,
    seats: withSeat(table.seats, index, { label: normalized }),
    version: table.version + 1,
    updatedAt: now,
  };
}

export function archiveSeatingTable(
  table: SeatingTable,
  now: string,
): SeatingTable {
  assertActive(table, "remove");
  return {
    ...table,
    status: "archived",
    version: table.version + 1,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Undo twins
//
// An undo restores a recorded fact rather than making a new decision, so these
// skip the "is this a sensible thing to want" rules — a no-op move, an
// unchanged label — that their forward counterparts enforce. What they cannot
// skip is the placement rules: the table was somewhere else while the world
// moved on, and the cells it wants back may no longer be free.
// ---------------------------------------------------------------------------

export function restoreSeatingTablePosition(
  table: SeatingTable,
  previous: SeatingTablePosition,
  plan: FloorPlan,
  now: string,
): SeatingTable {
  assertPlaceable(
    table,
    table.seats,
    previous.gridX,
    previous.gridY,
    plan,
    table.id,
  );
  return {
    ...table,
    gridX: previous.gridX,
    gridY: previous.gridY,
    version: table.version + 1,
    updatedAt: now,
  };
}

/** Restores a recorded rotation *and* the position it was turned from, because
 * a turn moves the table as well as facing it differently. */
export function restoreSeatingTableRotation(
  table: SeatingTable,
  previous: { rotation: Rotation } & SeatingTablePosition,
  plan: FloorPlan,
  now: string,
): SeatingTable {
  const shape: TableShape = { ...shapeOf(table), rotation: previous.rotation };
  assertPlaceable(
    shape,
    table.seats,
    previous.gridX,
    previous.gridY,
    plan,
    table.id,
  );
  return {
    ...table,
    ...shape,
    gridX: previous.gridX,
    gridY: previous.gridY,
    version: table.version + 1,
    updatedAt: now,
  };
}

/** Restores a recorded form together with the exact seats it had, so a reshape
 * that renumbered the perimeter puts every name back where it was. */
export function restoreSeatingTableShape(
  table: SeatingTable,
  previous: {
    kind: TableShapeKind;
    size: number;
    endSeats: boolean;
    seats: readonly Seat[];
  },
  plan: FloorPlan,
  now: string,
): SeatingTable {
  const shape = normalizeShape({ ...previous, rotation: table.rotation });
  const seats = previous.seats.map((seat) => ({ ...seat }));
  assertPlaceable(shape, seats, table.gridX, table.gridY, plan, table.id);
  return {
    ...table,
    ...shape,
    seats,
    version: table.version + 1,
    updatedAt: now,
  };
}

/** Undoing a `label-seat`. Putting a *name* back needs the chair's cell to be
 * free, because a name is what claims it; clearing one never does. */
export function restoreSeatLabel(
  table: SeatingTable,
  index: number,
  previousLabel: string,
  plan: FloorPlan,
  now: string,
): SeatingTable {
  requireSeatForRestore(table, index);
  if (previousLabel !== "" && blockedSeats(table, plan).has(index)) {
    throw new DomainError(
      "INVARIANT",
      "There is no chair there: another table is standing in that space",
    );
  }
  return {
    ...table,
    seats: withSeat(table.seats, index, { label: previousLabel }),
    version: table.version + 1,
    updatedAt: now,
  };
}

/** A recorded inverse naming a seat the table no longer has is a corrupt row,
 * not a caller's mistake, so it is an `INVARIANT` rather than a `VALIDATION`. */
function requireSeatForRestore(table: SeatingTable, index: number): void {
  if (!table.seats[index]) {
    throw new DomainError("INVARIANT", `This table has no seat ${index + 1}`);
  }
}

/** Puts a removed table back, if its cells are still free. */
export function restoreSeatingTable(
  table: SeatingTable,
  plan: FloorPlan,
  now: string,
): SeatingTable {
  if (table.status === "active") {
    throw new DomainError(
      "INVARIANT",
      "Cannot restore a table that has not been removed",
    );
  }
  assertPlaceable(table, table.seats, table.gridX, table.gridY, plan, table.id);
  return {
    ...table,
    status: "active",
    version: table.version + 1,
    updatedAt: now,
  };
}
