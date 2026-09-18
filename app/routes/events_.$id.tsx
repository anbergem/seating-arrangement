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
import { useTableDrag } from "@/components/seating/use-table-drag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

  const [dense, setDense] = useState(false);
  const [newTableName, setNewTableName] = useState("");
  const [newTableKind, setNewTableKind] = useState<TableShapeKind>("rectangle");
  const [newTableSize, setNewTableSize] = useState(4);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [layout, setLayout] = useState<LayoutValues>({
    ...DEFAULT_LAYOUT_VALUES,
    layout: "L",
  });

  const detail = useActionQuery<EventDetail>("get-event", { eventId: id });
  const tables = detail.data?.tables ?? [];
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
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{event.name}</h1>
          <p className="text-muted-foreground">
            {fmt.formatDate(event.startsAt, {
              dateStyle: "long",
              timeStyle: "short",
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs text-muted-foreground">
            {t("seating.tableName")}
            <Input
              aria-label={t("seating.tableName")}
              className="w-44"
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
          <Button
            variant="outline"
            aria-pressed={dense}
            onClick={() => setDense((current) => !current)}
          >
            {dense ? t("seating.comfortable") : t("seating.compact")}
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{t("seating.hint")}</p>

      {/* A bootstrap is for an empty plan, so the offer is only here while the
          plan is empty — the same rule the server enforces. */}
      {tables.length === 0 ? (
        <div className="grid max-w-md gap-3 rounded-lg border p-4">
          <div>
            <h2 className="text-sm font-medium">{t("seating.layoutTitle")}</h2>
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
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <FloorPlan
          room={room}
          tables={tables}
          blocked={blocked}
          drag={drag}
          dense={dense}
          selectedTableId={selectedTableId}
          selectedSeat={selectedSeat}
          canvasRef={canvasRef}
          onSelectSeat={(tableId, seat) => {
            setSelectedTableId(tableId);
            setSelectedSeat(seat);
          }}
        />
        <SeatPanel
          table={selectedTable}
          blocked={
            (selectedTable && blocked.get(selectedTable.id)) ?? noneBlocked
          }
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
      </div>

      {/* The spoken half of the drag: every outcome the outline shows is also
          said out loud, so the plan is usable without seeing it. */}
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {announcement}
      </p>

      {canManageOrg ? (
        <ArchiveEventButton eventId={event.id} version={event.version} />
      ) : null}
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
