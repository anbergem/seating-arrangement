/**
 * `get-event` (blueprint B8).
 *
 * Returns the event together with its floor plan, because the two are read as
 * one thing: a seating page that fetched them separately would render an empty
 * room for a moment, and the drag preview needs every table's footprint to
 * decide what a legal drop looks like.
 *
 * Removed tables are left out. They are kept as rows so an undo can put them
 * back, but they occupy no space and belong to nobody's floor plan.
 */

import type { Event, SeatingTable } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";

export interface GetEventInput {
  eventId: string;
}

export interface EventDetail {
  event: Event;
  tables: SeatingTable[];
}

export async function getEvent(
  deps: Dependencies,
  actor: Actor,
  input: GetEventInput,
): Promise<EventDetail> {
  requireCapability(actor, "events:read");
  requireCapability(actor, "seating:read");

  const event = await deps.events.getById(actor.orgId, input.eventId);
  if (!event) throw new AppError("NOT_FOUND", "Event not found");

  const tables = await deps.seatingTables.list(actor.orgId, {
    eventId: event.id,
    status: "active",
  });
  return { event, tables };
}
