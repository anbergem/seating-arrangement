/**
 * The panel for the selected table: its shape, and every seat on it with the
 * name on that seat in a labelled text field.
 *
 * It renders no chrome of its own — the sheet that holds it supplies the frame,
 * the title and the close button — so it can sit anywhere a table needs editing.
 *
 * This is the primary place to read and write seat names, and the canvas is the
 * spatial view. That split is what makes the brief's "the label must be
 * readable" hold for a name of any length: the chip on the plan shows as much as
 * fits at a legible size, and the full value is always here, in a field wide
 * enough for it.
 *
 * It is also the whole feature's keyboard and screen-reader path — a list of
 * labelled inputs, which needs no gesture at all.
 */

import { useT } from "@agent-native/core/client/i18n";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  MAX_SEAT_LABEL_LENGTH,
  MAX_SIZE,
  MIN_TABLE_SIZE,
  TABLE_SHAPE_KINDS,
  type SeatingTable,
  type TableShapeKind,
} from "./geometry";

export interface ReshapeInput {
  kind: TableShapeKind;
  size: number;
  endSeats: boolean;
}

export interface SeatPanelProps {
  /** Never null: the panel is only mounted for a table that is selected. */
  table: SeatingTable;
  selectedSeat: number | null;
  busy: boolean;
  onLabel: (table: SeatingTable, seat: number, label: string) => void;
  onReshape: (table: SeatingTable, shape: ReshapeInput) => void;
  onRotate: (table: SeatingTable) => void;
  /** Seats with no chair right now, because a neighbour is standing in the
   * cell. Derived from the plan by the route; see `blockedSeats`. */
  blocked: ReadonlySet<number>;
  onRemove: (table: SeatingTable) => void;
}

export function SeatPanel(props: SeatPanelProps) {
  const t = useT();
  const { table } = props;
  const available = table.seats.length - props.blocked.size;
  const sizeLabel =
    table.kind === "round" ? t("seating.diameter") : t("seating.length");

  /** A round table's diameter tops out lower than a rectangle's length, so
   * switching kind clamps the size rather than sending one the server would
   * refuse. */
  const reshapeTo = (change: Partial<ReshapeInput>) => {
    const kind = change.kind ?? table.kind;
    props.onReshape(table, {
      kind,
      size: Math.min(change.size ?? table.size, MAX_SIZE[kind]),
      endSeats: change.endSeats ?? table.endSeats,
    });
  };

  const sizes = Array.from(
    { length: MAX_SIZE[table.kind] - MIN_TABLE_SIZE + 1 },
    (_, offset) => MIN_TABLE_SIZE + offset,
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t("seating.tableSummary", {
          seats: available,
          x: table.gridX + 1,
          y: table.gridY + 1,
        })}
      </p>

      <div className="grid gap-2">
        <label className="flex items-center justify-between gap-2 text-sm">
          {t("seating.shape")}
          <select
            className="rounded-md border bg-background px-2 py-1"
            aria-label={t("seating.shape")}
            data-testid="table-kind"
            disabled={props.busy}
            value={table.kind}
            onChange={(event) =>
              reshapeTo({ kind: event.target.value as TableShapeKind })
            }
          >
            {TABLE_SHAPE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind === "rectangle"
                  ? t("seating.shapeRectangle")
                  : t("seating.shapeRound")}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center justify-between gap-2 text-sm">
          {sizeLabel}
          <select
            className="rounded-md border bg-background px-2 py-1"
            aria-label={sizeLabel}
            data-testid="table-size"
            disabled={props.busy}
            value={table.size}
            onChange={(event) =>
              reshapeTo({ size: Number(event.target.value) })
            }
          >
            {sizes.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        {/* A round table has no ends to cap, so the control is not disabled —
            it is not there. */}
        {table.kind === "rectangle" ? (
          <label className="flex items-center justify-between gap-2 text-sm">
            {t("seating.endSeats")}
            <input
              type="checkbox"
              className="size-4"
              aria-label={t("seating.endSeats")}
              disabled={props.busy}
              checked={table.endSeats}
              onChange={(event) =>
                reshapeTo({ endSeats: event.target.checked })
              }
            />
          </label>
        ) : null}
      </div>

      <div className="grid gap-3">
        <h3 className="text-sm font-medium">{t("seating.seats")}</h3>
        {/* Numbered as the shape derives them, so there is never a gap to
            explain: a chair with no room keeps its number and says so. */}
        {table.seats.map((seat, index) => {
          const place = t("seating.seatPlace", {
            number: index + 1,
            table: table.name,
          });
          return (
            <div className="grid gap-1" key={`${table.id}-seat-${index}`}>
              <span className="text-xs text-muted-foreground">{place}</span>
              {/* A blocked seat is not offered rather than offered and
                  refused: while the neighbour is there, there is no chair. It
                  keeps its number, so the list still reads straight through. */}
              {props.blocked.has(index) ? (
                <p className="text-xs italic text-muted-foreground">
                  {t("seating.seatBlocked")}
                </p>
              ) : (
                <SeatField
                  place={place}
                  label={seat.label}
                  autoFocus={props.selectedSeat === index}
                  busy={props.busy}
                  placeholder={t("seating.emptySeat")}
                  onCommit={(value) => props.onLabel(table, index, value)}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="grid gap-2">
        {/* A round table's square body turns into itself, so there is nothing
            to offer. */}
        {table.kind === "rectangle" ? (
          <Button
            variant="outline"
            data-testid="rotate-table"
            disabled={props.busy}
            onClick={() => props.onRotate(table)}
          >
            {t("seating.rotate")}
          </Button>
        ) : null}
        <Button
          variant="outline"
          data-testid="remove-table"
          disabled={props.busy}
          onClick={() => props.onRemove(table)}
        >
          {t("seating.remove")}
        </Button>
      </div>
    </div>
  );
}

interface SeatFieldProps {
  place: string;
  label: string;
  autoFocus: boolean;
  busy: boolean;
  placeholder: string;
  onCommit: (label: string) => void;
}

/**
 * One seat's field. It holds a draft while the user types and sends it on blur
 * or Enter, so a name is one operation row and one Undo rather than one per
 * keystroke. A label changed elsewhere — by the agent, by a colleague, by an
 * undo — replaces the draft when the field is not being edited.
 */
function SeatField(props: SeatFieldProps) {
  const [draft, setDraft] = useState(props.label);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(props.label);
  }, [editing, props.label]);

  const commit = () => {
    setEditing(false);
    const value = draft.trim();
    if (value === props.label) return;
    props.onCommit(value);
  };

  return (
    <Input
      aria-label={props.place}
      value={draft}
      autoFocus={props.autoFocus}
      disabled={props.busy}
      maxLength={MAX_SEAT_LABEL_LENGTH}
      placeholder={props.placeholder}
      onChange={(event) => {
        setEditing(true);
        setDraft(event.target.value);
      }}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setEditing(false);
          setDraft(props.label);
        }
      }}
    />
  );
}
