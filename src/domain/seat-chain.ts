/**
 * Chains of chairs, and shifting everybody along one.
 *
 * A table is never bent and an L or a U is several tables standing against one
 * another (`venue-layout.ts`), so "the row of chairs down this side" is not a
 * fact any record holds. It is derived from the floor plan, the same way
 * `blockedSeats` is — and, like blocked-ness, it is right again the moment
 * somebody moves a table.
 *
 * ## The chain
 *
 * Chairs are walked as a chain of touching cells rather than as a run of seat
 * numbers, which is what lets one rule cover a single table, an L and a U
 * without any of them being a case. Three things make the walk unambiguous:
 *
 *   * **Orthogonal neighbours first, diagonals only when there are none.**
 *     Chairs meet diagonally at a table's corner, so diagonals have to count —
 *     that is how the chain reaches the chair capping the end of a run from
 *     the side of it. But at the *inside* corner of an L three chairs touch one
 *     another in a triangle, and preferring the orthogonal step is what picks
 *     the one that hugs the table. Without it the walk stops at every inner
 *     corner.
 *   * **A step between two tables needs their bodies to be touching.** Two
 *     tables that have nothing to do with one another can easily stand back to
 *     back with a walkway between them, close enough that their chairs touch;
 *     without this they would chain into one loop and "shift everybody round"
 *     would move people between two unrelated tables.
 *   * **Only chairs that are really there.** A blocked seat is not a chair
 *     (`blockedSeats`), so a table pushed into the middle of a run splits the
 *     chain in two — which is right: a missing chair is a break nobody can be
 *     shifted past.
 *
 * A chain either closes into a loop or ends. A rectangle with a chair at each
 * end closes, and so does a round table; a rectangle *without* end chairs
 * cannot, because its two rows are separated by the table itself. Nothing here
 * says "a table without end seats may not be rotated" — the geometry says it.
 */

import { DomainError } from "./errors";
import {
  blockedSeats,
  cellKey,
  layoutOf,
  type Cell,
  type FloorPlan,
  type SeatingTable,
} from "./seating-table";

/** One chair: the seat of a table that is actually there. */
export interface ChairRef {
  tableId: string;
  seat: number;
}

interface Chair extends ChairRef {
  cell: string;
  label: string;
}

/**
 * The chairs of a floor plan and how they may be walked.
 *
 * Built once and passed around, because every question below needs all of it
 * and the screen asks the questions once per chair. It is a snapshot: labels
 * are copied in, so a map outlives the plan it was built from only as long as
 * nothing has changed.
 */
export interface ChairMap {
  readonly byCell: ReadonlyMap<string, Chair>;
  readonly byRef: ReadonlyMap<string, Chair>;
  /** Pairs of table ids whose bodies stand against one another. */
  readonly touching: ReadonlySet<string>;
}

const ORTHOGONAL = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const DIAGONAL = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

export function chairKey(ref: ChairRef): string {
  return `${ref.tableId}#${ref.seat}`;
}

/** Order-free, so one pair is one entry however it is looked up. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

export function mapChairs(plan: FloorPlan): ChairMap {
  const byCell = new Map<string, Chair>();
  const byRef = new Map<string, Chair>();
  const bodyOwner = new Map<string, string>();

  for (const table of plan.tables) {
    if (table.status !== "active") continue;
    const layout = layoutOf(table);
    for (const cell of layout.body) {
      bodyOwner.set(
        cellKey(table.gridX + cell.x, table.gridY + cell.y),
        table.id,
      );
    }
    const blocked = blockedSeats(table, plan);
    layout.seats.forEach((cell, seat) => {
      if (blocked.has(seat)) return;
      const chair: Chair = {
        tableId: table.id,
        seat,
        cell: cellKey(table.gridX + cell.x, table.gridY + cell.y),
        label: table.seats[seat]?.label ?? "",
      };
      // A blocked seat is exactly the one a neighbour already has, so no two
      // chairs can want the same cell.
      byCell.set(chair.cell, chair);
      byRef.set(chairKey(chair), chair);
    });
  }

  const touching = new Set<string>();
  for (const [cell, id] of bodyOwner) {
    const [x, y] = cell.split(",").map(Number) as [number, number];
    for (const [dx, dy] of ORTHOGONAL) {
      const other = bodyOwner.get(cellKey(x + dx, y + dy));
      if (other && other !== id) touching.add(pairKey(id, other));
    }
  }

  return { byCell, byRef, touching };
}

/** Where a chair stands on the floor, or `null` when there is no chair there.
 * The screen needs it to point an arrow the right way. */
export function chairCell(chairs: ChairMap, ref: ChairRef): Cell | null {
  const chair = chairAt(chairs, ref);
  if (!chair) return null;
  const [x, y] = chair.cell.split(",").map(Number) as [number, number];
  return { x, y };
}

function chairAt(chairs: ChairMap, ref: ChairRef): Chair | null {
  return chairs.byRef.get(chairKey(ref)) ?? null;
}

function linked(chairs: ChairMap, a: Chair, b: Chair): boolean {
  return (
    a.tableId === b.tableId ||
    chairs.touching.has(pairKey(a.tableId, b.tableId))
  );
}

/** Whether two cells are next to one another, corners included. */
function touches(a: string, b: string): boolean {
  const [ax, ay] = a.split(",").map(Number) as [number, number];
  const [bx, by] = b.split(",").map(Number) as [number, number];
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1;
}

/**
 * The chairs reachable in one step, excluding the one just left.
 *
 * At most two for every shape this application can build, which is what makes
 * a chain a chain rather than a graph to search. Both of the rules that keep
 * it that way live here:
 *
 *   * A chair touching only at the corner still counts, because that is how a
 *     run reaches the chair capping its end.
 *   * **Unless an orthogonal neighbour already leads there.** At the inside
 *     corner of an L, three chairs touch one another; the diagonal one is a
 *     short cut across a corner you can walk round, and taking it would leave
 *     the walk with two equally good ways on. Dropping it is what keeps every
 *     corner of every shape unambiguous — while still offering the *other*
 *     diagonal, the one no orthogonal step reaches, which is the chair round
 *     the end of the table.
 */
function step(chairs: ChairMap, from: Chair, cameFrom: string | null): Chair[] {
  const [x, y] = from.cell.split(",").map(Number) as [number, number];
  const reach = (
    dirs: readonly (readonly [number, number])[],
    without: string | null,
  ) =>
    dirs
      .map(([dx, dy]) => chairs.byCell.get(cellKey(x + dx, y + dy)))
      .filter(
        (chair): chair is Chair =>
          chair !== undefined &&
          chair.cell !== without &&
          linked(chairs, from, chair),
      );
  // Whether a corner is a short cut is a fact about the furniture, so it is
  // judged against every orthogonal neighbour — the one just left included.
  // Leave that one out and the last step of a loop sees its own corner again
  // and calls the chain ambiguous one chair short of closing.
  const adjacent = reach(ORTHOGONAL, null);
  const orthogonal = adjacent.filter((next) => next.cell !== cameFrom);
  const corners = reach(DIAGONAL, cameFrom).filter(
    (corner) => !adjacent.some((next) => touches(next.cell, corner.cell)),
  );
  return [...orthogonal, ...corners];
}

/** Which way a chair can be walked from — the two ends of its chain, or fewer
 * at the end of a run. */
export function chainNeighbours(chairs: ChairMap, from: ChairRef): ChairRef[] {
  const chair = chairAt(chairs, from);
  if (!chair) return [];
  return step(chairs, chair, null).map((next) => ({
    tableId: next.tableId,
    seat: next.seat,
  }));
}

export interface SeatChain {
  /** The chairs in order, starting with `from`. */
  path: readonly ChairRef[];
  /** True when the last chair leads back to the first. */
  closed: boolean;
}

/**
 * The chain of chairs beginning at `from` and stepping first to `toward`.
 *
 * Stops when there is nowhere left to go, and — for the same reason — when
 * more than one chair is equally next. Both are the end of the chain: a walk
 * that had to guess would not be a chain anybody could predict.
 */
export function seatChain(
  chairs: ChairMap,
  from: ChairRef,
  toward: ChairRef,
): SeatChain {
  const start = chairAt(chairs, from);
  const first = chairAt(chairs, toward);
  if (!start || !first) return { path: start ? [from] : [], closed: false };

  const path: Chair[] = [start, first];
  const seen = new Set([start.cell, first.cell]);
  let cameFrom = start.cell;
  let current = first;
  for (;;) {
    const next = step(chairs, current, cameFrom);
    if (next.length !== 1) break;
    const [ahead] = next as [Chair];
    if (ahead.cell === start.cell) return { path, closed: true };
    if (seen.has(ahead.cell)) break;
    path.push(ahead);
    seen.add(ahead.cell);
    cameFrom = current.cell;
    current = ahead;
  }
  return { path, closed: false };
}

/**
 * The neighbours a shift from `from` could actually go to.
 *
 * A loop can always absorb one — with nowhere to put a gap, everybody simply
 * moves round. A chain that ends needs somewhere for the last person to go, so
 * it needs an empty chair ahead of them.
 */
export function shiftTargets(chairs: ChairMap, from: ChairRef): ChairRef[] {
  const chair = chairAt(chairs, from);
  if (!chair || chair.label === "") return [];
  return chainNeighbours(chairs, from).filter((toward) => {
    const chain = seatChain(chairs, from, toward);
    if (chain.closed) return true;
    return chain.path
      .slice(1)
      .some((ref) => chairAt(chairs, ref)?.label === "");
  });
}

/** Where a shift puts each name: the chairs it touches, and what each ends up
 * holding. */
interface Assignment {
  ref: ChairRef;
  before: string;
  after: string;
}

/**
 * Everybody along the chain moves one place, and the shift stops at the first
 * empty chair — the person before it slides into it, and the chair the shift
 * started from is left free.
 *
 * On a loop with nobody free to absorb it there is no gap to leave anywhere,
 * so the whole loop turns by one instead and the last person comes round to
 * the chair the first has just left. It is the same walk and the same
 * permutation; only the ending differs, which is why this is one operation
 * and not two.
 */
function assignments(chairs: ChairMap, chain: SeatChain): Assignment[] {
  const labels = chain.path.map((ref) => chairAt(chairs, ref)?.label ?? "");
  const gap = labels.findIndex((label, index) => index > 0 && label === "");

  if (gap === -1) {
    if (!chain.closed) {
      throw new DomainError(
        "INVARIANT",
        "There is nowhere to shift to: every chair along here is taken",
      );
    }
    // A full loop: everybody moves on, and the last comes round.
    return chain.path.map((ref, index) => ({
      ref,
      before: labels[index] ?? "",
      after: labels[(index - 1 + labels.length) % labels.length] ?? "",
    }));
  }

  // Only as far as the gap. Chairs past it are not touched at all.
  return chain.path.slice(0, gap + 1).map((ref, index) => ({
    ref,
    before: labels[index] ?? "",
    after: index === 0 ? "" : (labels[index - 1] ?? ""),
  }));
}

export interface ShiftedSeats {
  /** Only the tables the shift actually changed, each already versioned. */
  tables: readonly SeatingTable[];
  /** What each touched chair held before — the inverse, recorded rather than
   * replayed. */
  previous: readonly { tableId: string; seat: number; label: string }[];
}

/**
 * Shifts everybody along the chain that starts at `from` and runs toward
 * `toward`.
 *
 * ## Why this can never be refused for space
 *
 * A name is what makes a chair claim its cell, so most seat writes have to ask
 * whether there is room. This one does not. Every chair in the chain is a
 * chair that is already there — `mapChairs` leaves out the blocked ones — and
 * a shift only ever writes a name into one of them while freeing another. It
 * claims a cell the floor plan has already agreed a chair may stand in, and
 * gives one back. There is no check here because there is nothing that could
 * fail, which is worth saying out loud so nobody adds one that cannot fire.
 */
export function shiftSeats(
  plan: FloorPlan,
  from: ChairRef,
  toward: ChairRef,
  now: string,
): ShiftedSeats {
  const chairs = mapChairs(plan);
  const start = chairAt(chairs, from);
  if (!start) {
    throw new DomainError(
      "INVARIANT",
      "There is no chair there: another table is standing in that space",
    );
  }
  if (start.label === "") {
    throw new DomainError("INVARIANT", "There is nobody on that seat");
  }
  const neighbours = chainNeighbours(chairs, from);
  if (!neighbours.some((next) => chairKey(next) === chairKey(toward))) {
    throw new DomainError(
      "VALIDATION",
      "That seat is not the next chair along from this one",
    );
  }

  const chain = seatChain(chairs, from, toward);
  const moved = assignments(chairs, chain).filter(
    (entry) => entry.before !== entry.after,
  );
  return {
    tables: write(plan, moved, now),
    previous: moved.map((entry) => ({ ...entry.ref, label: entry.before })),
  };
}

/**
 * Undoing a shift: puts the recorded name back on each chair it touched.
 *
 * Recorded labels rather than a shift in the other direction, for the reason
 * `restoreSeatPlacement` gives — somebody may have written a different name on
 * one of these chairs since, and running the permutation backwards would carry
 * theirs along with it.
 */
export function restoreSeatLabels(
  plan: FloorPlan,
  seats: readonly { tableId: string; seat: number; label: string }[],
  now: string,
): readonly SeatingTable[] {
  const changed = seats.filter((entry) => {
    const table = plan.tables.find(
      (candidate) => candidate.id === entry.tableId,
    );
    if (!table || !table.seats[entry.seat]) {
      // A recorded inverse naming a seat that is no longer there is a corrupt
      // row, not a caller's mistake.
      throw new DomainError(
        "INVARIANT",
        `This table has no seat ${entry.seat + 1}`,
      );
    }
    return table.seats[entry.seat]?.label !== entry.label;
  });
  return write(
    plan,
    changed.map((entry) => ({
      ref: { tableId: entry.tableId, seat: entry.seat },
      before: "",
      after: entry.label,
    })),
    now,
  );
}

/** Applies a set of label writes, one new object per table that changed. */
function write(
  plan: FloorPlan,
  moved: readonly Assignment[],
  now: string,
): SeatingTable[] {
  const byTable = new Map<string, Assignment[]>();
  for (const entry of moved) {
    const list = byTable.get(entry.ref.tableId) ?? [];
    list.push(entry);
    byTable.set(entry.ref.tableId, list);
  }
  const tables: SeatingTable[] = [];
  for (const [tableId, entries] of byTable) {
    const table = plan.tables.find((candidate) => candidate.id === tableId);
    if (!table) continue;
    const seats = table.seats.map((seat, index) => {
      const entry = entries.find((candidate) => candidate.ref.seat === index);
      return entry ? { label: entry.after } : seat;
    });
    tables.push({
      ...table,
      seats,
      version: table.version + 1,
      updatedAt: now,
    });
  }
  return tables;
}
