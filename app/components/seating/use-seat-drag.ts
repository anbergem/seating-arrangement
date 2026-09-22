/**
 * Dragging a *name* from one seat to another, on Pointer Events.
 *
 * A sibling of `use-table-drag.ts` rather than a mode of it. The two gestures
 * share about fifteen lines of pointer bookkeeping and nothing else: one drags
 * a position and the other a label, one is bounded by the room and the other
 * by which seats exist, one is nudged with arrow keys and the other is aimed
 * with Tab, and one always has somewhere to land while the other may be over
 * nothing at all. Folded together they would be one hook with two candidates,
 * two keyboard grammars and a mode flag on every handler.
 *
 * ## The drop target is found in the DOM
 *
 * `document.elementFromPoint`, not grid arithmetic — a deliberate reversal of
 * the instinct to keep it pure, for two reasons:
 *
 *   * A seat with no chair is not rendered, so it cannot be hit. Arithmetic
 *     would have to re-derive `blockedSeats` to reach the same answer, and any
 *     drift between the two would let somebody drop a name onto a chair that
 *     is not drawn.
 *   * It breaks a cycle. Grid arithmetic needs each table's *position*, which
 *     `use-table-drag` holds optimistically; that hook needs the optimistic
 *     *labels*, which this one holds. Going through the DOM means neither has
 *     to know about the other.
 *
 * ## Two label sets can exist at once
 *
 * `pending` holds what the user dropped while the server is being told.
 * Without it the names would snap back for the length of one round trip and
 * then jump forward again. `apply` lays it over the tables the query returned,
 * and a drop the server refuses clears it, so the next render shows what the
 * server still has.
 *
 * An optimistic label is not only cosmetic: a name claims its cell, so the
 * tables `apply` returns are what the rest of the screen must derive `blocked`
 * and the table-drag legality from.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { seatMoveFits, type Room, type SeatingTable } from "./geometry";

export interface SeatRefId {
  tableId: string;
  seat: number;
}

export interface SeatDragCandidate {
  from: SeatRefId;
  /** Where the pointer is now, or `null` when it is over no seat at all. */
  to: SeatRefId | null;
  valid: boolean;
}

interface SeatDragSession {
  from: SeatRefId;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  /** False until the pointer has actually gone somewhere, which is what
   * separates a drag from a press. */
  moved: boolean;
  /** False for an empty seat: there is no name to pick up, only a chip to
   * tap. */
  draggable: boolean;
}

export interface SeatDrag {
  candidate: SeatDragCandidate | null;
  /** The seat a keyboard pick-up is holding, until Enter or Escape. */
  keyboardMoveFor: SeatRefId | null;
  onPointerDown: (
    event: React.PointerEvent,
    table: SeatingTable,
    seat: number,
  ) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onKeyDown: (
    event: React.KeyboardEvent,
    table: SeatingTable,
    seat: number,
  ) => void;
  /** The tables with the optimistic labels laid over them. */
  apply: (tables: readonly SeatingTable[]) => SeatingTable[];
}

export interface UseSeatDragInput {
  room: Room;
  /** The tables as the query returned them. */
  tables: readonly SeatingTable[];
  /** Called once per completed move. Resolving `false` puts the names back. */
  onMove: (from: SeatRefId, to: SeatRefId) => Promise<boolean>;
  /** A press that did not turn into a drag — "select this seat". It cannot be
   * an `onClick`: this hook calls `preventDefault` on pointerdown, and a click
   * may never follow. */
  onTap: (ref: SeatRefId) => void;
  announce: (message: string) => void;
  messages: {
    pickedUp: (label: string, from: SeatRefId) => string;
    moved: (label: string, to: SeatRefId) => string;
    swapped: (label: string, other: string) => string;
    blocked: string;
    cancelled: string;
  };
}

/** How far the pointer may wander and still count as a press rather than a
 * drag. A click is never pixel-perfect, and a chip is small enough that a few
 * pixels of tremor should still open the panel. */
const TAP_SLOP = 4;

function sameSeat(a: SeatRefId | null, b: SeatRefId | null): boolean {
  return (
    a !== null && b !== null && a.tableId === b.tableId && a.seat === b.seat
  );
}

/** The seat under the pointer, read off the chip the browser says is there.
 * A chip that is not drawn — a chair a neighbouring table is standing in — is
 * not in the DOM, so it cannot be returned. */
function seatAt(clientX: number, clientY: number): SeatRefId | null {
  const element = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>("[data-seat]");
  if (!element) return null;
  const tableId = element.dataset.tableId;
  const seat = Number(element.dataset.seat);
  if (!tableId || !Number.isInteger(seat)) return null;
  return { tableId, seat };
}

export function useSeatDrag(input: UseSeatDragInput): SeatDrag {
  const { room, tables, onMove, onTap, announce, messages } = input;
  const session = useRef<SeatDragSession | null>(null);
  const [candidate, setCandidate] = useState<SeatDragCandidate | null>(null);
  const [pending, setPending] = useState<
    Record<string, Record<number, string>>
  >({});
  const [keyboardMoveFor, setKeyboardMoveFor] = useState<SeatRefId | null>(
    null,
  );

  const apply = useCallback(
    (source: readonly SeatingTable[]): SeatingTable[] =>
      source.map((table) => {
        const overrides = pending[table.id];
        if (!overrides) return table;
        return {
          ...table,
          seats: table.seats.map((seat, index) =>
            index in overrides ? { label: overrides[index] ?? "" } : seat,
          ),
        };
      }),
    [pending],
  );

  /** The plan as the screen is currently showing it — optimistic labels and
   * all, since those already claim their cells. */
  const shown = useMemo(() => apply(tables), [apply, tables]);
  const find = useCallback(
    (id: string) => shown.find((table) => table.id === id) ?? null,
    [shown],
  );

  const labelAt = useCallback(
    (ref: SeatRefId) => find(ref.tableId)?.seats[ref.seat]?.label ?? "",
    [find],
  );

  /**
   * Cell for cell, the same question the server will ask: would both seats
   * still have a chair once the names had been exchanged? The intent checks
   * come first because they are what the domain refuses outright.
   */
  const isLegal = useCallback(
    (from: SeatRefId, to: SeatRefId): boolean => {
      if (sameSeat(from, to)) return false;
      const fromTable = find(from.tableId);
      const toTable = find(to.tableId);
      if (!fromTable || !toTable) return false;
      if (fromTable.eventId !== toTable.eventId) return false;
      const moving = fromTable.seats[from.seat]?.label ?? "";
      const sitting = toTable.seats[to.seat]?.label ?? "";
      if (moving === "" || moving === sitting) return false;
      return seatMoveFits(
        { table: fromTable, seat: from.seat },
        { table: toTable, seat: to.seat },
        { room, tables: shown },
      );
    },
    [find, room, shown],
  );

  const commit = useCallback(
    async (from: SeatRefId, to: SeatRefId) => {
      const moving = labelAt(from);
      const sitting = labelAt(to);
      setPending((current) => {
        const next = { ...current };
        // Written through `next` rather than `current`, so a move within one
        // table writes its second seat on top of its first instead of
        // discarding it.
        const put = (ref: SeatRefId, label: string) => {
          next[ref.tableId] = { ...next[ref.tableId], [ref.seat]: label };
        };
        put(from, sitting);
        put(to, moving);
        return next;
      });
      const accepted = await onMove(from, to);
      if (accepted) {
        announce(
          sitting
            ? messages.swapped(moving, sitting)
            : messages.moved(moving, to),
        );
        // The overrides stay until the refetch carries the same names, or the
        // seats would show the server's old state for the length of one round
        // trip and then jump forward again.
        return;
      }
      // Refused: the server will never agree with these, so nothing would
      // prune them.
      setPending({});
    },
    [announce, labelAt, messages, onMove],
  );

  /**
   * Drop every override the query has caught up with.
   *
   * Pruning on agreement rather than clearing when the mutation resolves: the
   * refetch lands some time after that, and clearing early is a visible flash
   * of the old name. Left in place indefinitely they would be worse than a
   * flash — a name edited afterwards in the panel would be masked by a stale
   * override that nothing ever took off.
   */
  useEffect(() => {
    setPending((current) => {
      const keys = Object.keys(current);
      // The common case by far: nothing optimistic is outstanding, and
      // returning the same object keeps this out of the render path.
      if (keys.length === 0) return current;
      const next: Record<string, Record<number, string>> = {};
      for (const [tableId, overrides] of Object.entries(current)) {
        const table = tables.find((candidate) => candidate.id === tableId);
        const unmet = Object.entries(overrides).filter(
          ([index, label]) => table?.seats[Number(index)]?.label !== label,
        );
        if (unmet.length > 0)
          next[tableId] = Object.fromEntries(
            unmet.map(([index, label]) => [Number(index), label]),
          );
      }
      return next;
    });
  }, [tables]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent, table: SeatingTable, seat: number) => {
      // Left button or touch only, and never while a keyboard move is open.
      if (event.button !== 0 || keyboardMoveFor) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const from = { tableId: table.id, seat };
      session.current = {
        from,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
        // An empty chair has no name to carry. It is still pressed to open the
        // panel and type one.
        draggable: (table.seats[seat]?.label ?? "") !== "",
      };
    },
    [keyboardMoveFor],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const active = session.current;
      if (!active || active.pointerId !== event.pointerId) return;
      if (
        !active.moved &&
        Math.abs(event.clientX - active.startClientX) <= TAP_SLOP &&
        Math.abs(event.clientY - active.startClientY) <= TAP_SLOP
      ) {
        return;
      }
      active.moved = true;
      if (!active.draggable) return;
      const to = seatAt(event.clientX, event.clientY);
      setCandidate({
        from: active.from,
        to,
        valid: to !== null && isLegal(active.from, to),
      });
    },
    [isLegal],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const active = session.current;
      if (!active || active.pointerId !== event.pointerId) return;
      session.current = null;
      setCandidate(null);
      if (!active.moved) {
        onTap(active.from);
        return;
      }
      if (!active.draggable) return;
      const to = seatAt(event.clientX, event.clientY);
      // Dropped on nothing, or back where it started: no gesture happened.
      if (!to || sameSeat(active.from, to)) return;
      if (!isLegal(active.from, to)) {
        // Nothing is sent. An impossible drop is the gesture landing somewhere
        // it cannot, not a request the server should have to refuse.
        announce(messages.blocked);
        return;
      }
      void commit(active.from, to);
    },
    [announce, commit, isLegal, messages, onTap],
  );

  /**
   * The same move without a pointer: pick a name up, Tab to where it should
   * go, put it down.
   *
   * Arrow keys are deliberately not used — seats belong to tables scattered
   * around the room and have no two-dimensional adjacency to step through,
   * whereas every chip is already a real button in the tab order, so Tab
   * *is* the aiming mechanism.
   *
   * The two keys mean different things, which is unusual for a button and is
   * the price of a seat being both a control and a handle. **Enter selects**,
   * as activating this button always has, and opens the panel where a name is
   * written or edited — take that away and a name could only be typed with a
   * mouse. **Space picks the name up**, and while one is being carried either
   * key puts it down, because at that point there is only one thing either
   * could sensibly mean.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent, table: SeatingTable, seat: number) => {
      if (
        event.key !== "Enter" &&
        event.key !== " " &&
        event.key !== "Escape"
      ) {
        return;
      }
      const here = { tableId: table.id, seat };

      if (keyboardMoveFor) {
        event.preventDefault();
        const from = keyboardMoveFor;
        setKeyboardMoveFor(null);
        // Escape, or put back down where it was picked up: a cancel either
        // way, and saying so is what tells somebody who cannot see the plan
        // that they are no longer carrying anything.
        if (event.key === "Escape" || sameSeat(from, here)) {
          announce(messages.cancelled);
          return;
        }
        if (!isLegal(from, here)) {
          announce(messages.blocked);
          return;
        }
        void commit(from, here);
        return;
      }

      if (event.key === "Escape") return;
      event.preventDefault();
      const label = table.seats[seat]?.label ?? "";
      if (event.key === " " && label !== "") {
        setKeyboardMoveFor(here);
        announce(messages.pickedUp(label, here));
        return;
      }
      // Enter, or Space on an empty chair: there is nothing to carry, so this
      // is the ordinary activation — select the seat and open the panel.
      onTap(here);
    },
    [announce, commit, isLegal, keyboardMoveFor, messages, onTap],
  );

  return {
    candidate,
    keyboardMoveFor,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
    apply,
  };
}
