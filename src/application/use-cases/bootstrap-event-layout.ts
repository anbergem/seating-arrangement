/**
 * `bootstrap-event-layout` (blueprint B8).
 *
 * Lays out an L- or U-shaped arrangement in one go: a run of tables across the
 * top and one or two hanging off it, standing end to end so each section reads
 * as a single long surface.
 *
 * Doing this by hand means placing a dozen tables to the cell, which is a poor
 * first five minutes with an empty plan. `planVenueLayout` in the domain does
 * the arithmetic; this use case turns the answer into rows.
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
  createSeatingTable,
  growRoomToFit,
  planVenueLayout,
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

  // Every table starts with all its chairs empty, and an empty chair claims no
  // cell, so the tables of a run can be built against one another without any
  // of the chair-shuffling that used to be needed: the chairs that this
  // arrangement leaves no room for are simply blocked, worked out from the
  // finished plan whenever anybody looks.
  // Built in order against the ones already built, so a layout that somehow
  // overlapped itself would be refused here rather than reaching the database.
  // A plain loop, not `map`: each table is checked against the growing list,
  // which cannot be referenced from inside its own initialiser.
  const tables: SeatingTable[] = [];
  plan.tables.forEach((planned, index) => {
    tables.push(
      applyDomain(() =>
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
          { room, tables },
        ),
      ),
    );
  });

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
