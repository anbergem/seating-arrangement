/**
 * `archive-event` (blueprint B8).
 *
 * Admin-only: an event stands over a whole floor plan, and taking it out of the
 * list hides every table on it at once, where every other seating change
 * touches one table. The tables themselves are left untouched — the event
 * coming back brings its arrangement back with it.
 */

import type { Event, Operation } from "../../domain";
import { archiveEvent as archiveEventDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";

export interface ArchiveEventInput {
  eventId: string;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function archiveEvent(
  deps: Dependencies,
  actor: Actor,
  input: ArchiveEventInput,
): Promise<CommandResult<Event>> {
  requireCapability(actor, "events:archive");

  const event = await deps.events.getById(actor.orgId, input.eventId);
  if (!event) throw new AppError("NOT_FOUND", "Event not found");
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== event.version
  ) {
    throw new AppError("CONFLICT", "The event was changed by someone else");
  }

  const now = deps.clock.now();
  const next = applyDomain(() => archiveEventDomain(event, now));

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "archive-event",
    resourceType: "event",
    resourceId: event.id,
    classification: "reversible",
    versionBefore: event.version,
    versionAfter: next.version,
    payload: {},
    inverse: { type: "restore-event" },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  await deps.events.commit({
    event: next,
    expectedVersion: event.version,
    operation,
  });

  return { resource: next, operationId: operation.id };
}
