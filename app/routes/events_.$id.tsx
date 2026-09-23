import {
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useFormatters, useT } from "@agent-native/core/client/i18n";
import { useOrgRole } from "@agent-native/core/client/org";
import { useRef, useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";

import {
  translatedActionError,
  type CommandResult,
} from "@/components/activity/action-ui";
import { useOperationFeedback } from "@/components/activity/use-operation-feedback";
import { FloorPlan } from "@/components/seating/FloorPlan";
import {
  blockedSeats,
  DEFAULT_ROOM_HEIGHT,
  DEFAULT_ROOM_WIDTH,
  MAX_SIZE,
  MIN_TABLE_SIZE,
  type SeatingTable,
  type SeatingTablePosition,
  type TableShapeKind,
} from "@/components/seating/geometry";
import {
  DEFAULT_LAYOUT_VALUES,
  LayoutPicker,
  type LayoutValues,
} from "@/components/seating/LayoutPicker";
import { SeatPanel, type ReshapeInput } from "@/components/seating/SeatPanel";
import type { EventDetail } from "@/components/seating/types";
import {
  useSeatDrag,
  type SeatRefId,
} from "@/components/seating/use-seat-drag";
import { useSeatShift } from "@/components/seating/use-seat-shift";
import { useTableDrag } from "@/components/seating/use-table-drag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const INVALIDATES = ["get-event", "list-events", "list-recent-activity"];

type TableResult = CommandResult<SeatingTable>;
type TableArgs = Record<string, unknown>;

export default function EventSeatingRoute() {
  const { id = "" } = useParams();
  const t = useT();
  const fmt = useFormatters();
  const feedback = useOperationFeedback(INVALIDATES);
  const { canManageOrg } = useOrgRole();
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const [newTableName, setNewTableName] = useState("");
  const [newTableKind, setNewTableKind] = useState<TableShapeKind>("rectangle");
  const [newTableSize, setNewTableSize] = useState(4);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [shifting, setShifting] = useState(false);
  const [layout, setLayout] = useState<LayoutValues>({
    ...DEFAULT_LAYOUT_VALUES,
    layout: "L",
  });

  const detail = useActionQuery<EventDetail>("get-event", { eventId: id });
  const stored = detail.data?.tables ?? [];
  // Rooms belong to events, so the floor the drag preview is bounded by comes
  // from the record rather than from a constant. Falls back to the default for
  // the render before the query lands.
  const room = {
    width: detail.data?.event.roomWidth ?? DEFAULT_ROOM_WIDTH,
    height: detail.data?.event.roomHeight ?? DEFAULT_ROOM_HEIGHT,
  };

  // Written out one by one rather than through a helper: `useActionMutation`
  // is a hook, and a hook called from a nested function is a rule of hooks
  // violation even when the call order happens to be stable.
  const options = (message: string) => ({
    onSuccess: (result: CommandResult<SeatingTable>) =>
      void feedback.success(result, t(message)),
    onError: (error: unknown) => toast.error(translatedActionError(error, t)),
  });
  const create = useActionMutation<TableResult, TableArgs>(
    "create-seating-table",
    options("seating.created"),
  );
  const move = useActionMutation<TableResult, TableArgs>(
    "move-seating-table",
    options("seating.moved"),
  );
  const reshape = useActionMutation<TableResult, TableArgs>(
    "reshape-seating-table",
    options("seating.reshaped"),
  );
  const rotate = useActionMutation<TableResult, TableArgs>(
    "rotate-seating-table",
    options("seating.rotated"),
  );
  const label = useActionMutation<TableResult, TableArgs>(
    "label-seat",
    options("seating.labelled"),
  );
  const moveSeat = useActionMutation<TableResult, TableArgs>(
    "move-seat",
    options("seating.seatMoved"),
  );
  const shift = useActionMutation<TableResult, TableArgs>(
    "shift-seats",
    options("seating.shifted"),
  );
  const remove = useActionMutation<TableResult, TableArgs>(
    "archive-seating-table",
    options("seating.removed"),
  );
  // Its resource is the event rather than a table — a layout is a change to the
  // whole plan, and it may enlarge the room.
  const bootstrap = useActionMutation<
    CommandResult<EventDetail["event"]>,
    TableArgs
  >("bootstrap-event-layout", {
    onSuccess: (result) =>
      void feedback.success(result, t("seating.layoutApplied")),
    onError: (error: unknown) => toast.error(translatedActionError(error, t)),
  });

  const busy =
    create.isPending ||
    move.isPending ||
    reshape.isPending ||
    rotate.isPending ||
    bootstrap.isPending ||
    label.isPending ||
    moveSeat.isPending ||
    shift.isPending ||
    remove.isPending;

  /**
   * The drag hook owns the optimistic position and reverts it when this
   * resolves `false`. The client-side legality check it ran first is only a
   * courtesy: an overlap the preview missed comes back from the server as
   * CONFLICT, and this is where it lands.
   */
  async function commitMove(
    table: SeatingTable,
    to: SeatingTablePosition,
  ): Promise<boolean> {
    try {
      await move.mutateAsync({
        tableId: table.id,
        gridX: to.gridX,
        gridY: to.gridY,
        expectedVersion: table.version,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The seat drag's half of the same bargain. Both tables' versions go with
   * it: a move across tables writes two rows, and either of them changing
   * under the drag is a conflict.
   */
  async function commitSeatMove(
    from: SeatRefId,
    to: SeatRefId,
  ): Promise<boolean> {
    const fromTable = stored.find((table) => table.id === from.tableId);
    const toTable = stored.find((table) => table.id === to.tableId);
    if (!fromTable || !toTable) return false;
    try {
      await moveSeat.mutateAsync({
        fromTableId: from.tableId,
        fromSeat: from.seat,
        toTableId: to.tableId,
        toSeat: to.seat,
        fromExpectedVersion: fromTable.version,
        toExpectedVersion: toTable.version,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** "Seat 3, Head table" — the same phrase the seat's own accessible name is
   * built from, so what is spoken during a move matches what is spoken when
   * the seat is reached with Tab. */
  const placeOf = (ref: SeatRefId) =>
    t("seating.seatPlace", {
      number: ref.seat + 1,
      table: stored.find((table) => table.id === ref.tableId)?.name ?? "",
    });

  /** Everybody along the row moves one place. Only the table the user acted
   * on is version-guarded here; the batch guards every other row it writes. */
  async function commitShift(
    from: SeatRefId,
    toward: SeatRefId,
  ): Promise<boolean> {
    const table = stored.find((candidate) => candidate.id === from.tableId);
    if (!table) return false;
    try {
      await shift.mutateAsync({
        tableId: from.tableId,
        seat: from.seat,
        towardTableId: toward.tableId,
        towardSeat: toward.seat,
        expectedVersion: table.version,
      });
      return true;
    } catch {
      return false;
    }
  }

  // Declared before `useTableDrag`, and the order matters: a name dropped on a
  // seat claims that seat's cell the moment it is drawn there, so the
  // optimistic labels change both which chairs are blocked and where a table
  // may legally be dragged. Everything below this line works from `tables`,
  // the plan as the screen is actually showing it.
  const seatDrag = useSeatDrag({
    room,
    tables: stored,
    onMove: commitSeatMove,
    onTap: (ref) => {
      setSelectedTableId(ref.tableId);
      setSelectedSeat(ref.seat);
    },
    announce: setAnnouncement,
    messages: {
      pickedUp: (label, from) =>
        t("seating.announceSeatPickedUp", {
          label,
          place: placeOf(from),
        }),
      moved: (label, to) =>
        t("seating.announceSeatMoved", { label, place: placeOf(to) }),
      swapped: (label, other) =>
        t("seating.announceSeatSwapped", { label, other }),
      blocked: t("seating.seatBlocked"),
      cancelled: t("seating.announceCancelled"),
    },
  });
  const tables = seatDrag.apply(stored);

  const seatShift = useSeatShift({
    room,
    tables,
    enabled: shifting,
    onShift: commitShift,
    announce: setAnnouncement,
    messages: {
      armed: (label) => t("seating.announceShiftArmed", { label }),
      shifted: (label) => t("seating.announceShifted", { label }),
      cancelled: t("seating.announceCancelled"),
    },
  });

  // Which chairs have no room right now, per table. Derived from the plan the
  // same way the server derives it, so the page and the write agree.
  const blocked = new Map<string, ReadonlySet<number>>(
    tables.map((table) => [table.id, blockedSeats(table, { room, tables })]),
  );
  const noneBlocked: ReadonlySet<number> = new Set<number>();

  const drag = useTableDrag({
    canvasRef,
    room,
    tables,
    onMove: commitMove,
    onTap: (table) => {
      setSelectedTableId(table.id);
      setSelectedSeat(null);
    },
    announce: setAnnouncement,
    messages: {
      moved: (table, to) =>
        t("seating.announceMoved", {
          name: table.name,
          x: to.gridX + 1,
          y: to.gridY + 1,
        }),
      blocked: t("seating.overlap"),
      moveStarted: (table) =>
        t("seating.announceMoveStarted", { name: table.name }),
      cancelled: t("seating.announceCancelled"),
    },
  });

  if (detail.isLoading) return <div className="p-6">{t("common.loading")}</div>;
  if (!detail.data || detail.error) {
    return (
      <div className="p-6 text-destructive">
        {translatedActionError(detail.error, t)}
      </div>
    );
  }

  const { event } = detail.data;
  const selectedTable =
    tables.find((table) => table.id === selectedTableId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{event.name}</h1>
          <p className="text-xs text-muted-foreground">
            {fmt.formatDate(event.startsAt, {
              dateStyle: "long",
              timeStyle: "short",
            })}
          </p>
        </div>
        {/* The spoken half of the drag: every outcome the outline shows is
            also said out loud, so the plan is usable without seeing it. It
            lives in the header rather than over the canvas, where it would
            cover the corner the plan is laid out from. */}
        <p
          aria-live="polite"
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
        >
          {announcement || t("seating.hint")}
        </p>
        <Button
          type="button"
          variant={shifting ? "default" : "outline"}
          data-testid="shift-mode"
          aria-pressed={shifting}
          onClick={() => {
            const next = !shifting;
            setShifting(next);
            setAnnouncement(
              next ? t("seating.shiftModeOn") : t("seating.shiftModeOff"),
            );
          }}
        >
          {t("seating.shiftMode")}
        </Button>
        {canManageOrg ? (
          <ArchiveEventButton eventId={event.id} version={event.version} />
        ) : null}
      </header>

      {/* The editor. The plan takes everything left over; the toolbar, the
          empty state and the announcement float above it rather than taking
          height away from it. */}
      {/* `pb-24` reserves the strip the toolbar floats in, so the plan is
          sized to fit *above* it rather than having its last row covered. */}
      <div className="relative flex min-h-0 flex-1 flex-col p-3 pb-24">
        <FloorPlan
          room={room}
          tables={tables}
          blocked={blocked}
          drag={drag}
          seatDrag={seatDrag}
          shift={seatShift}
          shifting={shifting}
          selectedTableId={selectedTableId}
          selectedSeat={selectedSeat}
          canvasRef={canvasRef}
        />

        {/* A bootstrap is for an empty plan, so it doubles as the empty state
            and is only offered while the plan is one — the rule the server
            enforces anyway. */}
        {tables.length === 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-24 top-0 flex items-center justify-center p-6">
            <div className="pointer-events-auto grid w-full max-w-sm gap-3 rounded-xl border bg-background p-4 shadow-lg">
              <div>
                <h2 className="text-sm font-medium">
                  {t("seating.layoutTitle")}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {t("seating.layoutDescription")}
                </p>
              </div>
              <LayoutPicker
                value={layout}
                disabled={busy}
                allowNone={false}
                onChange={setLayout}
              />
              <Button
                data-testid="lay-out-event"
                disabled={busy}
                onClick={() =>
                  bootstrap.mutate({
                    eventId: event.id,
                    layout: layout.layout,
                    sections: layout.sections,
                    tableLength: layout.tableLength,
                    endSeats: true,
                  })
                }
              >
                {t("seating.layoutApply")}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Floating, and at the bottom: the plan is laid out from its top-left
            corner, so that is the last place to put something over it. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center px-5">
          <div className="pointer-events-auto flex flex-wrap items-end gap-2 rounded-xl border bg-background/90 p-2 shadow-lg backdrop-blur">
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t("seating.tableName")}
              <Input
                aria-label={t("seating.tableName")}
                className="w-40"
                value={newTableName}
                placeholder={t("seating.tableNamePlaceholder")}
                onChange={(changed) => setNewTableName(changed.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t("seating.shape")}
              <select
                className="rounded-md border bg-background px-3 py-2"
                aria-label={t("seating.newTableShape")}
                data-testid="new-table-kind"
                value={newTableKind}
                onChange={(changed) =>
                  setNewTableKind(changed.target.value as TableShapeKind)
                }
              >
                <option value="rectangle">{t("seating.shapeRectangle")}</option>
                <option value="round">{t("seating.shapeRound")}</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {newTableKind === "round"
                ? t("seating.diameter")
                : t("seating.length")}
              <select
                className="rounded-md border bg-background px-3 py-2"
                aria-label={t("seating.newTableSize")}
                data-testid="new-table-size"
                value={Math.min(newTableSize, MAX_SIZE[newTableKind])}
                onChange={(changed) =>
                  setNewTableSize(Number(changed.target.value))
                }
              >
                {Array.from(
                  { length: MAX_SIZE[newTableKind] - MIN_TABLE_SIZE + 1 },
                  (_, offset) => MIN_TABLE_SIZE + offset,
                ).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <Button
              data-testid="add-table"
              disabled={busy}
              onClick={() => {
                const name =
                  newTableName.trim() ||
                  t("seating.defaultTableName", { number: tables.length + 1 });
                create.mutate({
                  eventId: event.id,
                  name,
                  kind: newTableKind,
                  size: Math.min(newTableSize, MAX_SIZE[newTableKind]),
                  endSeats: true,
                });
                setNewTableName("");
              }}
            >
              {t("seating.addTable")}
            </Button>
          </div>
        </div>
      </div>

      {/* Not modal: the plan stays draggable with the panel open, which is the
          whole reason to put the panel over the canvas rather than beside it. */}
      <Sheet
        open={selectedTable !== null}
        modal={false}
        onOpenChange={(open) => {
          if (open) return;
          setSelectedTableId(null);
          setSelectedSeat(null);
        }}
      >
        {selectedTable ? (
          <SheetContent
            side="right"
            showOverlay={false}
            className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-sm"
          >
            <SheetHeader className="space-y-0 text-left">
              <SheetTitle className="truncate">{selectedTable.name}</SheetTitle>
            </SheetHeader>
            <SeatPanel
              table={selectedTable}
              blocked={blocked.get(selectedTable.id) ?? noneBlocked}
              selectedSeat={selectedSeat}
              busy={busy}
              onLabel={(table, seat, value) =>
                label.mutate({
                  tableId: table.id,
                  seat,
                  label: value,
                  expectedVersion: table.version,
                })
              }
              onReshape={(table, shape: ReshapeInput) =>
                reshape.mutate({
                  tableId: table.id,
                  kind: shape.kind,
                  size: shape.size,
                  endSeats: shape.endSeats,
                  expectedVersion: table.version,
                })
              }
              onRotate={(table) =>
                rotate.mutate({
                  tableId: table.id,
                  expectedVersion: table.version,
                })
              }
              onRemove={(table) => {
                setSelectedTableId(null);
                setSelectedSeat(null);
                remove.mutate({
                  tableId: table.id,
                  expectedVersion: table.version,
                });
              }}
            />
          </SheetContent>
        ) : null}
      </Sheet>
    </div>
  );
}

/** Admin-only: it hides a whole floor plan at once. That is
 * courtesy — the server check is the security. */
function ArchiveEventButton(props: { eventId: string; version: number }) {
  const t = useT();
  const feedback = useOperationFeedback(INVALIDATES);
  const archive = useActionMutation<
    CommandResult<{ id: string }>,
    { eventId: string; expectedVersion: number }
  >("archive-event", {
    onSuccess: (result) => void feedback.success(result, t("events.archived")),
    onError: (error) => toast.error(translatedActionError(error, t)),
  });
  return (
    <Button
      variant="outline"
      data-testid="archive-event"
      disabled={archive.isPending}
      onClick={() =>
        archive.mutate({
          eventId: props.eventId,
          expectedVersion: props.version,
        })
      }
    >
      {t("events.archive")}
    </Button>
  );
}
