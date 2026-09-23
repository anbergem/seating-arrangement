/**
 * One table on the plan: its body, which is also the drag handle, and its
 * numbered seats around it.
 *
 * The table is a CSS grid of its own bounding box, and every cell it fills is
 * placed by the coordinates `layoutOf` returns. Nothing here knows what a
 * rectangle is or what round means beyond a border radius: it draws whatever
 * cells the domain says the shape has, which is why rotation costs nothing and
 * why a new kind of table would need no change in this file.
 *
 * The body is a **single element spanning the block of cells it covers**, which
 * it can be because a body is always an axis-aligned block. That is what lets a
 * round table actually be round — one element with `rounded-full` — where a
 * grid of per-cell buttons could only ever be a row of rounded tiles.
 *
 * The container itself is `pointer-events: none`, and only the body and the
 * seats take pointer events back. A table's bounding box legitimately contains
 * cells belonging to a *neighbouring* table — the corners a rectangle leaves
 * free, an empty chair the neighbour is standing in — and the container must
 * not swallow clicks aimed at whatever is standing there.
 */

import { useT } from "@agent-native/core/client/i18n";

import { cn } from "@/lib/utils";

import { cellKey, layoutOf, type SeatingTable } from "./geometry";
import { SeatChip } from "./SeatChip";

export interface TableShapeProps {
  table: SeatingTable;
  gridX: number;
  gridY: number;
  dragging: boolean;
  invalid: boolean;
  moving: boolean;
  selected: boolean;
  selectedSeat: number | null;
  /** Seats with no chair right now, because a neighbour is standing in the
   * cell. They are not drawn at all — there is nothing there to draw. */
  blocked: ReadonlySet<number>;
  /** The seat whose name is being carried right now, if it is one of this
   * table's. */
  liftedSeat: number | null;
  /** The seat a carried name is hovering over, if it is one of this
   * table's. */
  dropSeat: number | null;
  dropValid: boolean;
  /** Shift mode is on, so a press on a chair aims a shift rather than
   * starting a drag. */
  shifting: boolean;
  /** The chair a shift is being aimed from, if it is one of this table's. */
  armedSeat: number | null;
  /** Whether anybody on this seat could be shifted along. */
  canShift: (seat: number) => boolean;
  /** The arrow to draw on this seat while a shift is aimed. */
  arrowFor: (seat: number) => string | null;
  onPointerDown: (event: React.PointerEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onSeatPointerDown: (seat: number, event: React.PointerEvent) => void;
  onSeatKeyDown: (seat: number, event: React.KeyboardEvent) => void;
  onSeatSelect: (seat: number) => void;
}

export function TableShape(props: TableShapeProps) {
  const t = useT();
  const { table } = props;
  const layout = layoutOf(table);
  const available = table.seats.length - props.blocked.size;
  const seated = table.seats.filter((seat) => seat.label.length > 0).length;

  // The body's extent within the bounding box. It is a solid block, so its
  // corners are all the geometry a single spanning element needs.
  const xs = layout.body.map((cell) => cell.x);
  const ys = layout.body.map((cell) => cell.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const spanX = Math.max(...xs) - left + 1;
  const spanY = Math.max(...ys) - top + 1;

  return (
    <div
      data-testid={`seating-table-${table.id}`}
      data-grid-x={props.gridX}
      data-grid-y={props.gridY}
      data-kind={table.kind}
      data-rotation={table.rotation}
      className={cn(
        "pointer-events-none absolute select-none p-0.5",
        props.dragging && "z-10 opacity-90",
      )}
      style={{
        left: `calc(var(--seat-col) * ${props.gridX})`,
        top: `calc(var(--seat-row) * ${props.gridY})`,
        width: `calc(var(--seat-col) * ${layout.width})`,
        height: `calc(var(--seat-row) * ${layout.height})`,
        display: "grid",
        gridTemplateColumns: `repeat(${layout.width}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${layout.height}, minmax(0, 1fr))`,
      }}
    >
      <button
        type="button"
        aria-label={t("seating.moveTable", {
          name: table.name,
          x: props.gridX + 1,
          y: props.gridY + 1,
        })}
        aria-pressed={props.moving}
        onPointerDown={props.onPointerDown}
        onKeyDown={props.onKeyDown}
        className={cn(
          "pointer-events-auto flex min-w-0 flex-col items-center justify-center overflow-hidden border px-1 shadow-sm",
          "touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          props.dragging ? "cursor-grabbing" : "cursor-grab",
          props.invalid
            ? "border-destructive bg-destructive/15 text-destructive"
            : "border-border bg-card text-card-foreground",
          (props.selected || props.moving) && "ring-1 ring-ring ring-inset",
          table.kind === "round" ? "rounded-full" : "rounded-sm",
        )}
        style={{
          gridColumn: `${left + 1} / span ${spanX}`,
          gridRow: `${top + 1} / span ${spanY}`,
        }}
      >
        <span className="w-full break-words text-center text-xs font-medium leading-tight">
          {table.name}
        </span>
        <span className="w-full truncate text-[10px] leading-tight text-muted-foreground">
          {t("seating.seatedCount", { seated, total: available })}
        </span>
      </button>

      {layout.seats.map((cell, index) => {
        const seat = table.seats[index];
        if (!seat || props.blocked.has(index)) return null;
        const place = t("seating.seatPlace", {
          number: index + 1,
          table: table.name,
        });
        const arrow = props.arrowFor(index);
        const shiftable = props.canShift(index);
        const seatName = seat.label
          ? t("seating.seatFilled", { place, label: seat.label })
          : t("seating.seatEmpty", { place });
        return (
          <SeatChip
            key={cellKey(cell.x, cell.y)}
            tableId={table.id}
            index={index}
            label={seat.label}
            accessibleName={
              // The mode is said out loud, not only drawn: a chair that can be
              // shifted and a chair a shift could land on are different
              // offers, and neither is obvious from the name alone.
              arrow
                ? t("seating.seatShiftToward", { seat: seatName })
                : props.shifting && shiftable
                  ? t("seating.seatShiftable", { seat: seatName })
                  : seatName
            }
            emptyText={t("seating.emptySeat")}
            column={cell.x}
            row={cell.y}
            selected={props.selectedSeat === index}
            lifted={props.liftedSeat === index || props.armedSeat === index}
            dropTarget={props.dropSeat === index}
            invalid={props.dropSeat === index && !props.dropValid}
            shiftable={props.shifting && shiftable}
            arrow={arrow}
            // While the mode is on the chip must stay an ordinary button: the
            // drag's `preventDefault` is what would stop the click arriving.
            onPointerDown={
              props.shifting
                ? undefined
                : (event) => props.onSeatPointerDown(index, event)
            }
            onKeyDown={(event) => props.onSeatKeyDown(index, event)}
            onClick={
              props.shifting ? () => props.onSeatSelect(index) : undefined
            }
          />
        );
      })}
    </div>
  );
}
