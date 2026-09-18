/**
 * `list-events` (blueprint B8).
 *
 * Archived events are left out unless the caller asks otherwise. "Otherwise"
 * includes asking for them by name: an explicit `status` filter always wins,
 * or `status: "archived"` would be a query that can only return nothing.
 */

import type { Event, EventStatus } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import type { Dependencies } from "../ports";

export interface ListEventsInput {
  status?: EventStatus;
  /** Only meaningful without `status`; `true` keeps archived events in the list. */
  includeArchived?: boolean;
}

export async function listEvents(
  deps: Dependencies,
  actor: Actor,
  input: ListEventsInput = {},
): Promise<Event[]> {
  requireCapability(actor, "events:read");

  const filter: { status?: EventStatus } = {};
  if (input.status !== undefined) filter.status = input.status;

  const events = await deps.events.list(actor.orgId, filter);

  // The port's filter has one `status` slot and no "not archived" predicate,
  // so the default exclusion is applied here rather than pushed into two
  // repository implementations that would have to agree on the SQL for it.
  if (input.status !== undefined || input.includeArchived === true) {
    return events;
  }
  return events.filter((event) => event.status !== "archived");
}
