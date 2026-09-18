/**
 * Dragging a table around the floor plan, on Pointer Events.
 *
 * Hand-rolled rather than pulled from a library: there is no drag-and-drop
 * package in this repository's dependency graph, and AGENTS.md asks for a
 * reason before one is added. A grid drag is a pointer capture, a division and
 * a round, which is less code than the adapter a library would need.
 *
 * Three positions can exist for one table at once, and the component renders
 * the first of them that is set:
 *
 *   1. `drag` — where the pointer currently is, this instant.
 *   2. `pending` — where the user dropped it, while the server is being told.
 *      Without this the table would snap back to its old cell for the length
 *      of one round trip and then jump forward again.
 *   3. the table as the last `get-event` returned it.
 *
 * A drop the server refuses clears `pending`, so the next render puts the table
 * back where the server still has it. The client-side legality check is a
 * courtesy that keeps the preview honest; the server refusing is the actual
 * constraint.
 */

import { useCallback, useRef, useState } from "react";

import {
  fitsAt,
  footprintSize,
  occupiedCellKeys,
  type Room,
  type SeatingTable,
  type SeatingTablePosition,
} from "./geometry";

export interface DragCandidate extends SeatingTablePosition {
  tableId: string;
  valid: boolean;
}

interface DragSession extends DragCandidate {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startGridX: number;
  startGridY: number;
  moved: boolean;
}

export interface TableDrag {
  /** The table being dragged or nudged, and where it would land. */
  candidate: DragCandidate | null;
  /** Optimistic positions by table id, held until the query catches up. */
  pending: Record<string, SeatingTablePosition>;
  /** True while a keyboard move is open and waiting for Enter or Escape. */
  keyboardMoveFor: string | null;
  onPointerDown: (event: React.PointerEvent, table: SeatingTable) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onKeyDown: (event: React.KeyboardEvent, table: SeatingTable) => void;
  /** Where a table should be drawn right now, whatever is going on. */
  positionOf: (table: SeatingTable) => SeatingTablePosition;
}

export interface UseTableDragInput {
  canvasRef: React.RefObject<HTMLElement | null>;
  /** The event's floor. Every bound below is measured against it rather than
   * against a constant, because each event has its own room. */
  room: Room;
  tables: readonly SeatingTable[];
  /** Called once per completed move. Resolving `false` reverts the table. */
  onMove: (table: SeatingTable, to: SeatingTablePosition) => Promise<boolean>;
  /** A press on the body that did not turn into a drag — the gesture people
   * mean as "select this table". It cannot be an `onClick`, because the drag
   * calls `preventDefault` on pointerdown and a click may never follow. */
  onTap: (table: SeatingTable) => void;
  /** Announced to assistive technology, and shown under the plan. */
  announce: (message: string) => void;
  messages: {
    moved: (table: SeatingTable, to: SeatingTablePosition) => string;
    blocked: string;
    moveStarted: (table: SeatingTable) => string;
    cancelled: string;
  };
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

export function useTableDrag(input: UseTableDragInput): TableDrag {
  const { canvasRef, room, tables, onMove, onTap, announce, messages } = input;
  const session = useRef<DragSession | null>(null);
  const [candidate, setCandidate] = useState<DragCandidate | null>(null);
  const [pending, setPending] = useState<Record<string, SeatingTablePosition>>(
    {},
  );
  const [keyboardMoveFor, setKeyboardMoveFor] = useState<string | null>(null);

  /** Measured, never hard-coded: the canvas sizes its cells to fill whatever
   * space it is given, so the scale changes under us on every resize. */
  const cellSize = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return { x: rect.width / room.width, y: rect.height / room.height };
  }, [canvasRef, room]);

  const isLegal = useCallback(
    (table: SeatingTable, to: SeatingTablePosition) =>
      // Cell for cell, the same arithmetic the server runs: a table with end
      // seats leaves its corners free, and an empty chair claims nothing at
      // all, so a neighbour may legally sit inside what looks like this
      // table's rectangle.
      fitsAt(
        table,
        table.seats,
        to.gridX,
        to.gridY,
        occupiedCellKeys(tables, table.id),
        room,
      ),
    [tables, room],
  );

  const commit = useCallback(
    async (table: SeatingTable, to: SeatingTablePosition) => {
      setPending((current) => ({ ...current, [table.id]: to }));
      const accepted = await onMove(table, to);
      if (accepted) {
        announce(messages.moved(table, to));
      } else {
        // The server said no. Drop the optimistic position and the table
        // renders wherever the query still has it.
        setPending((current) => {
          const next = { ...current };
          delete next[table.id];
          return next;
        });
      }
    },
    [announce, messages, onMove],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent, table: SeatingTable) => {
      // Left button or touch only, and never while a keyboard move is open.
      if (event.button !== 0 || keyboardMoveFor) return;
      const cell = cellSize();
      if (!cell) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      session.current = {
        tableId: table.id,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startGridX: table.gridX,
        startGridY: table.gridY,
        gridX: table.gridX,
        gridY: table.gridY,
        valid: true,
        moved: false,
      };
      setCandidate({
        tableId: table.id,
        gridX: table.gridX,
        gridY: table.gridY,
        valid: true,
      });
    },
    [cellSize, keyboardMoveFor],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const active = session.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const cell = cellSize();
      const table = tables.find(
        (candidateTable) => candidateTable.id === active.tableId,
      );
      if (!cell || !table) return;
      const size = footprintSize(table);
      const gridX = clamp(
        active.startGridX +
          Math.round((event.clientX - active.startClientX) / cell.x),
        room.width - size.width,
      );
      const gridY = clamp(
        active.startGridY +
          Math.round((event.clientY - active.startClientY) / cell.y),
        room.height - size.height,
      );
      if (gridX === active.gridX && gridY === active.gridY) return;
      const valid = isLegal(table, { gridX, gridY });
      active.gridX = gridX;
      active.gridY = gridY;
      active.valid = valid;
      active.moved = true;
      setCandidate({ tableId: table.id, gridX, gridY, valid });
    },
    [cellSize, isLegal, tables],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const active = session.current;
      if (!active || active.pointerId !== event.pointerId) return;
      session.current = null;
      setCandidate(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const table = tables.find(
        (candidateTable) => candidateTable.id === active.tableId,
      );
      if (!table) return;
      if (!active.moved) {
        onTap(table);
        return;
      }
      if (
        active.gridX === active.startGridX &&
        active.gridY === active.startGridY
      ) {
        return;
      }
      if (!active.valid) {
        // Nothing is sent: an illegal drop is the user's gesture landing
        // somewhere impossible, not a request the server should have to refuse.
        announce(messages.blocked);
        return;
      }
      void commit(table, { gridX: active.gridX, gridY: active.gridY });
    },
    [announce, commit, messages, onTap, tables],
  );

  /**
   * The same move without a mouse. Arrow keys nudge a local candidate and
   * Enter commits it, so one intent is one operation row and one Undo — a
   * mutation per key press would bury the history under a trail of single
   * cells.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent, table: SeatingTable) => {
      const open = keyboardMoveFor === table.id;
      const at = candidate?.tableId === table.id ? candidate : null;

      if (!open && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        setKeyboardMoveFor(table.id);
        setCandidate({
          tableId: table.id,
          gridX: table.gridX,
          gridY: table.gridY,
          valid: true,
        });
        announce(messages.moveStarted(table));
        return;
      }
      if (!open) return;

      if (event.key === "Escape") {
        event.preventDefault();
        setKeyboardMoveFor(null);
        setCandidate(null);
        announce(messages.cancelled);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        setKeyboardMoveFor(null);
        setCandidate(null);
        if (!at || (at.gridX === table.gridX && at.gridY === table.gridY))
          return;
        if (!at.valid) {
          announce(messages.blocked);
          return;
        }
        void commit(table, { gridX: at.gridX, gridY: at.gridY });
        return;
      }

      const step = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      }[event.key];
      if (!step) return;
      event.preventDefault();
      const from = at ?? { gridX: table.gridX, gridY: table.gridY };
      const size = footprintSize(table);
      const gridX = clamp(from.gridX + step.x, room.width - size.width);
      const gridY = clamp(from.gridY + step.y, room.height - size.height);
      setCandidate({
        tableId: table.id,
        gridX,
        gridY,
        valid: isLegal(table, { gridX, gridY }),
      });
    },
    [announce, candidate, commit, isLegal, keyboardMoveFor, messages],
  );

  const positionOf = useCallback(
    (table: SeatingTable): SeatingTablePosition => {
      if (candidate?.tableId === table.id) {
        return { gridX: candidate.gridX, gridY: candidate.gridY };
      }
      return pending[table.id] ?? { gridX: table.gridX, gridY: table.gridY };
    },
    [candidate, pending],
  );

  return {
    candidate,
    pending,
    keyboardMoveFor,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
    positionOf,
  };
}
