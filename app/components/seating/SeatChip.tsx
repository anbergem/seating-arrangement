/**
 * One seat, and the name on it.
 *
 * The brief asks for readable labels, and readability is mostly a layout
 * decision made one level up: the floor plan's cells are deliberately wider
 * than they are tall (`--seat-col` against `--seat-row`), so a chip is roughly
 * 80 by 44 pixels and a real first name fits at 12px. A square cell would have
 * forced initials, which is not a label anyone can read.
 *
 * A name longer than the chip is not shrunk — below about 11px nothing is
 * gained — it wraps to two lines and then clips, and the full value stays
 * available two other ways: the `title` attribute, which is also the accessible
 * name, so the browser shows it on hover and a screen reader announces it; and
 * the seat panel over the canvas, which is where long names are meant to be
 * read and edited.
 *
 * A hand-built hover bubble was tried here instead of `title` and taken out
 * again: on the top row of a table it renders above the canvas and is clipped
 * by the scroll container, and it puts every name into the DOM twice. The
 * native tooltip is positioned by the browser and cannot be clipped.
 *
 * Colour never carries meaning alone: an empty seat is dashed as well as
 * muted, the name being carried in a drag is faded as well as ringed, and a
 * seat it cannot land on is outlined as well as tinted. Every colour is a
 * theme token, so both themes are covered by construction.
 *
 * The chip has no `onClick`. A seat is both a drag handle and a control, and
 * the drag calls `preventDefault` on pointerdown, after which a click may
 * never arrive — so selecting a seat is a press that did not turn into a drag,
 * which only `use-seat-drag` is in a position to know.
 */

import { cn } from "@/lib/utils";

export interface SeatChipProps {
  tableId: string;
  index: number;
  label: string;
  accessibleName: string;
  column: number;
  row: number;
  selected: boolean;
  /** This is the name being carried right now. */
  lifted: boolean;
  /** The pointer is over this chip while a name is being carried. */
  dropTarget: boolean;
  /** …and it could not land here. */
  invalid: boolean;
  emptyText: string;
  onPointerDown: (event: React.PointerEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

export function SeatChip(props: SeatChipProps) {
  const filled = props.label.length > 0;
  return (
    <div
      className="pointer-events-auto flex min-w-0 items-center justify-center p-0.5"
      style={{ gridColumn: props.column + 1, gridRow: props.row + 1 }}
    >
      <button
        type="button"
        // How the pointer finds what it is over: `elementFromPoint` returns a
        // node, and these turn it back into a seat. A chair that is not drawn
        // has no element and so cannot be dropped on, which is the answer we
        // want anyway.
        data-seat={props.index}
        data-table-id={props.tableId}
        data-testid={`seat-${props.tableId}-${props.index}`}
        aria-label={props.accessibleName}
        aria-pressed={props.selected || props.lifted}
        title={filled ? props.label : props.emptyText}
        // Not `onClick`: the drag calls `preventDefault` on pointerdown, so a
        // click may never follow. Selecting a seat is a press that did not
        // become a drag, and the hook decides which it was.
        onPointerDown={props.onPointerDown}
        onKeyDown={props.onKeyDown}
        className={cn(
          "flex h-full w-full min-w-0 touch-none items-center justify-center rounded-md border px-1 text-center text-xs font-medium leading-tight transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          filled
            ? "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80"
            : "border-dashed border-border bg-muted text-muted-foreground hover:bg-muted/70",
          filled && "cursor-grab",
          (props.selected || props.lifted) &&
            "ring-2 ring-ring ring-offset-1 ring-offset-background",
          // Never colour alone: the name being carried is also faded, and a
          // refused target is outlined as well as tinted.
          props.lifted && "cursor-grabbing opacity-50",
          props.dropTarget &&
            (props.invalid
              ? "border-destructive bg-destructive/15 text-destructive"
              : "ring-2 ring-ring ring-offset-1 ring-offset-background"),
        )}
      >
        <span className="line-clamp-2 break-words">
          {filled ? props.label : "+"}
        </span>
      </button>
    </div>
  );
}
