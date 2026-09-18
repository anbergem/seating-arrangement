/**
 * `resize-room` (blueprint B8).
 *
 * Changes how big an event's floor is. Growing always works; shrinking is
 * refused when a table would be left outside the new bounds, and the refusal
 * names the table, because "the room is too small" is not something a user can
 * act on.
 *
 * `seating:write` rather than a capability of its own: the room is part of the
 * floor plan, and anybody who may move a table across it may decide how much
 * floor there is to move it across.
 */

import type { Event, Operation } from "../../domain";
import { resizeRoom as resizeRoomDomain, roomOf } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";

export interface ResizeRoomInput {
  eventId: string;
  /** Cells across and down. */
  width: number;
  height: number;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function resizeRoom(
  deps: Dependencies,
  actor: Actor,
  input: ResizeRoomInput,
): Promise<CommandResult<Event>> {
  requireCapability(actor, "seating:write");

  const event = await deps.events.getById(actor.orgId, input.eventId);
  if (!event) throw new AppError("NOT_FOUND", "Event not found");
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== event.version
  ) {
    throw new AppError("CONFLICT", "The event was changed by someone else");
  }

  // Active tables only: an archived one holds no floor, and the undo that
  // brings it back re-checks placement itself.
  const tables = await deps.seatingTables.list(actor.orgId, {
    eventId: event.id,
    status: "active",
  });

  const now = deps.clock.now();
  const next = applyDomain(() =>
    resizeRoomDomain(
      event,
      { width: input.width, height: input.height },
      tables,
      now,
    ),
  );

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "resize-room",
    resourceType: "event",
    resourceId: event.id,
    classification: "reversible",
    versionBefore: event.version,
    versionAfter: next.version,
    payload: { width: next.roomWidth, height: next.roomHeight },
    inverse: { type: "restore-room-size", previous: roomOf(event) },
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
