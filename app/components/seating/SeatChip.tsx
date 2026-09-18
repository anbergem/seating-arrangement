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
 * muted. Every colour is a theme token, so both themes are covered by
 * construction.
 */

import { cn } from "@/lib/utils";

export interface SeatChipProps {
  label: string;
  accessibleName: string;
  column: number;
  row: number;
  selected: boolean;
  emptyText: string;
  onSelect: () => void;
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
        aria-label={props.accessibleName}
        aria-pressed={props.selected}
        title={filled ? props.label : props.emptyText}
        onClick={props.onSelect}
        className={cn(
          "flex h-full w-full min-w-0 items-center justify-center rounded-md border px-1 text-center text-xs font-medium leading-tight transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          filled
            ? "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80"
            : "border-dashed border-border bg-muted text-muted-foreground hover:bg-muted/70",
          props.selected &&
            "ring-2 ring-ring ring-offset-1 ring-offset-background",
        )}
      >
        <span className="line-clamp-2 break-words">
          {filled ? props.label : "+"}
        </span>
      </button>
    </div>
  );
}
