/**
 * Shift mode: pick a chair, pick a direction, everybody moves along one.
 *
 * A mode rather than a gesture, because the question it answers is not about
 * one chair. "Where could somebody be fitted in?" is a fact about the whole
 * plan — which rows of chairs have a gap left in them anywhere along their
 * length — and the only honest way to show it is to mark every chair at once.
 * Dragging could not: it would have to be tried before it could be answered.
 *
 * Aiming is two presses, not one, for the same reason the table drag asks for
 * Enter twice. A chair usually has two ways along its row and no inherent
 * direction, so the first press says which chair and the second says which
 * way. In between, the two chairs it could go to are marked with an arrow
 * pointing the way people would move — worked out from where the chairs
 * actually are, so it is right for a table at any angle.
 *
 * While the mode is on, the seat drag is off. They are the same element and
 * the same press, and a press that might mean either is a press that means
 * nothing.
 */

import { useCallback, useMemo, useState } from "react";

import {
  chairCell,
  chairKey,
  mapChairs,
  shiftTargets,
  type ChairRef,
  type Room,
  type SeatingTable,
} from "./geometry";

export interface SeatShift {
  /** The chair waiting for a direction, if any. */
  armed: ChairRef | null;
  /** Whether anybody on this chair could be shifted along. */
  canShift: (ref: ChairRef) => boolean;
  /** The arrow to draw on this chair while one is armed — the way people
   * would move — or `null` when it is not a candidate. */
  arrowTo: (ref: ChairRef) => string | null;
  onSelect: (table: SeatingTable, seat: number) => void;
  onKeyDown: (
    event: React.KeyboardEvent,
    table: SeatingTable,
    seat: number,
  ) => void;
}

export interface UseSeatShiftInput {
  room: Room;
  tables: readonly SeatingTable[];
  /** False while the mode is off; every handler then does nothing. */
  enabled: boolean;
  /** Resolving `false` leaves the plan as the server still has it. */
  onShift: (from: ChairRef, toward: ChairRef) => Promise<boolean>;
  announce: (message: string) => void;
  messages: {
    armed: (label: string) => string;
    shifted: (label: string) => string;
    cancelled: string;
  };
}

/** Which way the arrow points, from one chair's cell to the next one's. */
function arrowFor(dx: number, dy: number): string {
  const across = Math.sign(dx);
  const down = Math.sign(dy);
  if (across === 0) return down > 0 ? "↓" : "↑";
  if (down === 0) return across > 0 ? "→" : "←";
  if (across > 0) return down > 0 ? "↘" : "↗";
  return down > 0 ? "↙" : "↖";
}

export function useSeatShift(input: UseSeatShiftInput): SeatShift {
  const { room, tables, enabled, onShift, announce, messages } = input;
  const [armed, setArmed] = useState<ChairRef | null>(null);

  // One map per render, not one per chair: every chair on the plan asks
  // whether it can be shifted, and each answer needs the whole floor.
  const chairs = useMemo(() => mapChairs({ room, tables }), [room, tables]);

  const labelAt = useCallback(
    (ref: ChairRef) =>
      tables.find((table) => table.id === ref.tableId)?.seats[ref.seat]
        ?.label ?? "",
    [tables],
  );

  const canShift = useCallback(
    (ref: ChairRef) => enabled && shiftTargets(chairs, ref).length > 0,
    [chairs, enabled],
  );

  const arrowTo = useCallback(
    (ref: ChairRef) => {
      if (!enabled || !armed) return null;
      const isTarget = shiftTargets(chairs, armed).some(
        (target) => chairKey(target) === chairKey(ref),
      );
      if (!isTarget) return null;
      const from = chairCell(chairs, armed);
      const to = chairCell(chairs, ref);
      if (!from || !to) return null;
      return arrowFor(to.x - from.x, to.y - from.y);
    },
    [armed, chairs, enabled],
  );

  const commit = useCallback(
    async (from: ChairRef, toward: ChairRef) => {
      const label = labelAt(from);
      setArmed(null);
      if (await onShift(from, toward)) announce(messages.shifted(label));
    },
    [announce, labelAt, messages, onShift],
  );

  const select = useCallback(
    (ref: ChairRef) => {
      if (!enabled) return;
      if (armed && chairKey(armed) === chairKey(ref)) {
        setArmed(null);
        announce(messages.cancelled);
        return;
      }
      if (armed && arrowTo(ref)) {
        void commit(armed, ref);
        return;
      }
      // Anything else is either a new chair to aim from, or a chair nobody can
      // be shifted out of — in which case there is nothing to say.
      if (!canShift(ref)) return;
      setArmed(ref);
      announce(messages.armed(labelAt(ref)));
    },
    [announce, armed, arrowTo, canShift, commit, enabled, labelAt, messages],
  );

  const onSelect = useCallback(
    (table: SeatingTable, seat: number) => select({ tableId: table.id, seat }),
    [select],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent, table: SeatingTable, seat: number) => {
      if (!enabled) return;
      if (event.key === "Escape" && armed) {
        event.preventDefault();
        setArmed(null);
        announce(messages.cancelled);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      select({ tableId: table.id, seat });
    },
    [announce, armed, enabled, messages, select],
  );

  return { armed, canShift, arrowTo, onSelect, onKeyDown };
}
