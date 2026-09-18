/**
 * `bootstrap-event-layout` (blueprint B8).
 *
 * Lays out an L- or U-shaped arrangement in one go: a run of tables across the
 * top and one or two hanging off it, standing end to end so each section reads
 * as a single long surface, with every chair that would be inside another
 * table's body already taken off.
 *
 * Doing this by hand means placing each table to the cell in the right order —
 * a table whose corner chair is still on cannot be brought up against its
 * neighbour, so the floor plan refuses it — and that is a poor first five
 * minutes with an empty plan. `planVenueLayout` in the domain does the
 * arithmetic; this use case turns the answer into rows.
 *
 * Three things worth knowing about the shape of the write:
 *
 *   * **It is one operation, not one per table.** A layout is a single decision
 *     and a single Undo; twelve separate operations would make undoing it
 *     twelve clicks and leave half-arrangements in between.
 *   * **The operation is against the *event*.** It creates tables but its
 *     subject is the plan as a whole, and it may enlarge the room, so the event
 *     is what it is version-guarded on and what its audit row names.
 *   * **The room grows to fit.** A U of three sections does not fit the default
 *     16 by 10, and making the user work out that it needs 18 by 15 before
 *     they are allowed to ask for it would be a bad trade.
 *
 * Compensatable, not reversible: its inverse archives the tables it made and
 * puts the room back, rather than deleting anything.
 */

import type { Event, Operation, SeatingTable } from "../../domain";
import {
  cellKey,
  cellsOf,
  createSeatingTable,
  growRoomToFit,
  planVenueLayout,
  removeSeat,
  roomOf,
  type LayoutKind,
} from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";

export interface BootstrapEventLayoutInput {
  eventId: string;
  /** `L` is two sections, `U` is three. */
  layout: LayoutKind;
  /** Tables per section. L: `[across, down]`. U: `[leftWing, middle, rightWing]`. */
  sections: readonly number[];
  /** Every table in the layout is this long, in cells. */
  tableLength: number;
  /** A chair capping each far end of the arrangement. The chairs at the joins
   * between tables come off either way. */
  endSeats?: boolean;
}

export async function bootstrapEventLayout(
  deps: Dependencies,
  actor: Actor,
  input: BootstrapEventLayoutInput,
): Promise<CommandResult<Event>> {
  requireCapability(actor, "seating:write");

  const event = await deps.events.getById(actor.orgId, input.eventId);
  if (!event) throw new AppError("NOT_FOUND", "Event not found");

  // A bootstrap is for an empty plan. Adding a layout around tables that are
  // already standing would either collide with them or shuffle them somewhere
  // the user did not ask for, and neither is a good surprise.
  const existing = await deps.seatingTables.list(actor.orgId, {
    eventId: event.id,
    status: "active",
  });
  if (existing.length > 0) {
    throw new AppError(
      "INVARIANT",
      "This event already has tables; a layout can only be laid out on an empty plan",
    );
  }

  const now = deps.clock.now();
  const plan = applyDomain(() =>
    planVenueLayout({
      kind: input.layout,
      sections: input.sections,
      tableLength: input.tableLength,
      endSeats: input.endSeats ?? true,
    }),
  );

  // The room first, because the tables are placed against it: every table the
  // plan describes is inside the room the plan asked for.
  const grown = applyDomain(() => growRoomToFit(event, plan.room, now));
  const room = roomOf(grown);

  // Each table is built on an empty floor and *then* has its planned chairs
  // taken off, rather than being checked against the tables already built.
  //
  // That order is forced: a table's chairs are what collide at a join, and
  // they cannot come off until the table exists, so checking placement first
  // would refuse the very arrangement being built. The packing has already
  // been solved by `planVenueLayout` — `tests/unit/domain/venue-layout.test.ts`
  // holds it to never planning two tables into one cell — and the binding
  // check is the `seating_cells` primary key the write goes through. What is
  // still checked here is the room, which `createSeatingTable` does.
  const tables: SeatingTable[] = plan.tables.map((planned, index) => {
    const built = applyDomain(() =>
      planned.removed.reduce(
        (table, seat) => removeSeat(table, seat, now),
        createSeatingTable(
          {
            id: deps.ids.next(),
            orgId: actor.orgId,
            eventId: event.id,
            name: `Table ${index + 1}`,
            kind: planned.shape.kind,
            size: planned.shape.size,
            endSeats: planned.shape.endSeats,
            rotation: planned.shape.rotation,
            gridX: planned.gridX,
            gridY: planned.gridY,
            createdBy: actor.userEmail,
            now,
          },
          { room, tables: [] },
        ),
      ),
    );
    // `removeSeat` bumps the version once per chair, but nothing has been
    // written yet: these are all still version 1 as far as the database is
    // concerned, and storing anything else would make the first edit conflict.
    return { ...built, version: 1 };
  });

  // Belt and braces on the planner, and INTERNAL rather than INVARIANT because
  // a layout that overlaps itself is this application's bug, not a bad request.
  const claimed = new Set<string>();
  for (const table of tables) {
    for (const cell of cellsOf(table)) {
      const key = cellKey(cell.x, cell.y);
      if (claimed.has(key)) {
        throw new AppError("INTERNAL", "Unexpected error");
      }
      claimed.add(key);
    }
  }

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "bootstrap-event-layout",
    resourceType: "event",
    resourceId: event.id,
    classification: "compensatable",
    versionBefore: event.version,
    versionAfter: grown.version,
    payload: {
      layout: input.layout,
      sections: [...input.sections],
      tableLength: input.tableLength,
      tables: tables.length,
    },
    inverse: {
      type: "undo-bootstrap",
      tableIds: tables.map((table) => table.id),
      previousRoom: roomOf(event),
    },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  await deps.seatingTables.createLayout({
    event: grown,
    expectedVersion: event.version,
    tables,
    operation,
  });

  return { resource: grown, operationId: operation.id };
}
