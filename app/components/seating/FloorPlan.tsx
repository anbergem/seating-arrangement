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
 */

import { useT } from "@agent-native/core/client/i18n";

import { cn } from "@/lib/utils";

import type { Room, SeatingTable } from "./geometry";
import { TableShape } from "./TableShape";
import type { TableDrag } from "./use-table-drag";

export interface FloorPlanProps {
  /** The event's own floor. Rooms differ per event, so nothing here assumes a
   * size. */
  room: Room;
  tables: readonly SeatingTable[];
  drag: TableDrag;
  dense: boolean;
  selectedTableId: string | null;
  selectedSeat: number | null;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  onSelectSeat: (tableId: string, seat: number) => void;
}

export function FloorPlan(props: FloorPlanProps) {
  const t = useT();
  const { drag } = props;
  const column = props.dense ? 64 : 88;
  const row = props.dense ? 40 : 52;

  return (
    <div className="overflow-auto rounded-lg border bg-muted/30 p-3">
      <div
        ref={props.canvasRef}
        data-testid="floor-plan"
        role="group"
        aria-label={t("seating.planLabel")}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerUp}
        className="relative"
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
          return (
            <TableShape
              key={table.id}
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
              onPointerDown={(event) => drag.onPointerDown(event, table)}
              onKeyDown={(event) => drag.onKeyDown(event, table)}
              onSelectSeat={(seat) => props.onSelectSeat(table.id, seat)}
            />
          );
        })}
        {props.tables.length === 0 ? (
          <p
            className={cn(
              "absolute inset-0 flex items-center justify-center",
              "text-sm text-muted-foreground",
            )}
          >
            {t("seating.emptyPlan")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
