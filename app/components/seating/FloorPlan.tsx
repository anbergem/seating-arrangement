/**
 * The floor plan: a grid of cells with the event's tables standing on it.
 *
 * HTML and CSS rather than SVG, deliberately. The labels are the point of this
 * screen, and SVG `<text>` neither wraps nor ellipsizes nor inherits the app's
 * type scale — it would mean measuring a font by hand and truncating by
 * character count. A seat also has to be a real focusable control, which in
 * SVG means `role="button"` plus a tabindex plus hand-written key handling.
 * Here every cell is a `<button>` and every colour is a theme token, so both
 * themes and the keyboard come for free.
 *
 * The grid itself is a repeating gradient rather than elements, so the number
 * of cells costs nothing.
 *
 * ## Scale
 *
 * The plan fills whatever space it is given: the cell size is measured from the
 * container rather than fixed, so a small room in a big window is drawn large
 * and a big room shrinks to fit.
 *
 * It shrinks only so far. Past `MIN_CELL_WIDTH` a name stops being readable and
 * a seat stops being a usable target, and "the label must be readable" is the
 * one thing this screen exists for — so below that the plan keeps its size and
 * the container scrolls instead. A 64 by 40 room is simply bigger than a laptop
 * screen, and pretending otherwise would make it useless rather than merely
 * large.
 *
 * Cells are deliberately wider than they are tall (`CELL_ASPECT`), which is
 * what gives a first name room to sit on one line. The ratio is held constant
 * at every scale so tables never look squashed.
 */

import { useT } from "@agent-native/core/client/i18n";
import { useEffect, useRef, useState } from "react";

import type { Room, SeatingTable } from "./geometry";
import { TableShape } from "./TableShape";
import type { SeatDrag } from "./use-seat-drag";
import type { SeatShift } from "./use-seat-shift";
import type { TableDrag } from "./use-table-drag";

const EMPTY: ReadonlySet<number> = new Set<number>();

/** Cell width divided by cell height. */
const CELL_ASPECT = 88 / 52;
/** Narrower than this and a seat chip holds no readable name. */
const MIN_CELL_WIDTH = 56;
/** Wider than this and a small plan is just blown up. */
const MAX_CELL_WIDTH = 104;
/** The scroll container's padding, in pixels on each side. Kept beside the
 * class that applies it, because the fit has to subtract it. */
const PADDING = 12;

/** The width one cell should have, to fill `space` without going below what a
 * name needs. Whole pixels, so the gradient grid lines stay crisp. */
function fitCellWidth(
  space: { width: number; height: number },
  room: Room,
): number {
  const byWidth = space.width / room.width;
  const byHeight = (space.height / room.height) * CELL_ASPECT;
  return Math.max(
    MIN_CELL_WIDTH,
    Math.min(MAX_CELL_WIDTH, Math.floor(Math.min(byWidth, byHeight))),
  );
}

/** The box available inside the scroll container, remeasured whenever it
 * changes — a window resize, the sheet opening, the sidebar collapsing. */
function useAvailableSpace(): [
  React.RefObject<HTMLDivElement | null>,
  { width: number; height: number } | null,
] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [space, setSpace] = useState<{ width: number; height: number } | null>(
    null,
  );
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setSpace({
        // `clientWidth` excludes the scrollbar, which is what we have to lay
        // out inside.
        width: element.clientWidth - PADDING * 2,
        height: element.clientHeight - PADDING * 2,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, space];
}

export interface FloorPlanProps {
  /** The event's own floor. Rooms differ per event, so nothing here assumes a
   * size. */
  room: Room;
  tables: readonly SeatingTable[];
  /** Blocked seats by table id; see `blockedSeats`. */
  blocked: ReadonlyMap<string, ReadonlySet<number>>;
  drag: TableDrag;
  seatDrag: SeatDrag;
  shift: SeatShift;
  /** True while shift mode is on. */
  shifting: boolean;
  selectedTableId: string | null;
  selectedSeat: number | null;
  canvasRef: React.RefObject<HTMLDivElement | null>;
}

export function FloorPlan(props: FloorPlanProps) {
  const t = useT();
  const { drag, seatDrag, shift } = props;
  const [wrapper, space] = useAvailableSpace();
  // Before the first measurement there is nothing to fit to; the largest cell
  // is the closest guess and the observer corrects it on the next frame.
  const column = space ? fitCellWidth(space, props.room) : MAX_CELL_WIDTH;
  const row = Math.round(column / CELL_ASPECT);

  return (
    <div
      ref={wrapper}
      className="flex min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/30 p-3"
    >
      <div
        ref={props.canvasRef}
        data-testid="floor-plan"
        role="group"
        aria-label={t("seating.planLabel")}
        // Both gestures are offered every pointer event, and each ignores a
        // pointer that is not its own — a press is either on a table body or
        // on a seat chip, never both, so only one of them ever has a session
        // open for it.
        onPointerMove={(event) => {
          drag.onPointerMove(event);
          if (!props.shifting) seatDrag.onPointerMove(event);
        }}
        onPointerUp={(event) => {
          drag.onPointerUp(event);
          if (!props.shifting) seatDrag.onPointerUp(event);
        }}
        onPointerCancel={(event) => {
          drag.onPointerUp(event);
          if (!props.shifting) seatDrag.onPointerUp(event);
        }}
        // `m-auto` rather than centring on the wrapper: it centres a plan
        // smaller than the space and still scrolls to the top-left corner of
        // one that is bigger, where `place-content: center` would clip it.
        className="relative m-auto"
        style={
          {
            // Consumed by every absolutely positioned table below, and measured
            // back out of the DOM by the drag hook — never duplicated as a
            // number in JavaScript.
            "--seat-col": `${column}px`,
            "--seat-row": `${row}px`,
            width: `calc(var(--seat-col) * ${props.room.width})`,
            height: `calc(var(--seat-row) * ${props.room.height})`,
            backgroundImage:
              "repeating-linear-gradient(to right, hsl(var(--border)) 0 1px, transparent 1px var(--seat-col)), repeating-linear-gradient(to bottom, hsl(var(--border)) 0 1px, transparent 1px var(--seat-row))",
          } as React.CSSProperties
        }
      >
        {props.tables.map((table) => {
          const at = drag.positionOf(table);
          const active = drag.candidate?.tableId === table.id;
          const carried = seatDrag.candidate?.from ?? seatDrag.keyboardMoveFor;
          const over = seatDrag.candidate?.to ?? null;
          return (
            <TableShape
              key={table.id}
              blocked={props.blocked.get(table.id) ?? EMPTY}
              table={table}
              gridX={at.gridX}
              gridY={at.gridY}
              dragging={active && drag.keyboardMoveFor !== table.id}
              invalid={active && drag.candidate?.valid === false}
              moving={drag.keyboardMoveFor === table.id}
              selected={props.selectedTableId === table.id}
              selectedSeat={
                props.selectedTableId === table.id ? props.selectedSeat : null
              }
              liftedSeat={carried?.tableId === table.id ? carried.seat : null}
              dropSeat={over?.tableId === table.id ? over.seat : null}
              dropValid={seatDrag.candidate?.valid ?? false}
              onPointerDown={(event) => drag.onPointerDown(event, table)}
              onKeyDown={(event) => drag.onKeyDown(event, table)}
              onSeatPointerDown={(seat, event) =>
                seatDrag.onPointerDown(event, table, seat)
              }
              onSeatKeyDown={(seat, event) =>
                props.shifting
                  ? shift.onKeyDown(event, table, seat)
                  : seatDrag.onKeyDown(event, table, seat)
              }
              onSeatSelect={(seat) => shift.onSelect(table, seat)}
              shifting={props.shifting}
              armedSeat={
                shift.armed?.tableId === table.id ? shift.armed.seat : null
              }
              canShift={(seat) => shift.canShift({ tableId: table.id, seat })}
              arrowFor={(seat) => shift.arrowTo({ tableId: table.id, seat })}
            />
          );
        })}
      </div>
    </div>
  );
}
