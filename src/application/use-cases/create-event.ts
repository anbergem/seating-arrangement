/**
 * `create-event` (blueprint B8, decision D14).
 *
 * An event is the container a seating arrangement lives in. Like every other
 * create in this application it is *compensatable* rather than reversible: its
 * inverse archives the event, because nothing here deletes.
 */

import type { Event, Operation } from "../../domain";
import { createEvent as createEventDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import {
  applyDomain,
  isIdempotencyKeyViolation,
  type CommandResult,
} from "./command";

const ACTION = "create-event";

export interface CreateEventInput {
  name: string;
  /** ISO 8601 instant the event starts. */
  startsAt: string;
  /** Repeat the same key to retry safely: the second call returns the event the
   * first one created. */
  idempotencyKey?: string;
}

/** A key that names a resource which is not there is a corrupt row, not a
 * caller error, so it is `INTERNAL` with the reason withheld (B5). */
async function findCompletedCreate(
  deps: Dependencies,
  orgId: string,
  key: string,
): Promise<CommandResult<Event> | null> {
  const resourceId = await deps.idempotency.find(orgId, ACTION, key);
  if (resourceId === null) return null;

  const event = await deps.events.getById(orgId, resourceId);
  const created = await deps.operations.findCreateOperation(
    orgId,
    "event",
    resourceId,
  );
  if (!event || !created) {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return { resource: event, operationId: created.id };
}

export async function createEvent(
  deps: Dependencies,
  actor: Actor,
  input: CreateEventInput,
): Promise<CommandResult<Event>> {
  requireCapability(actor, "events:create");

  const { idempotencyKey, ...payload } = input;

  if (idempotencyKey !== undefined) {
    const existing = await findCompletedCreate(
      deps,
      actor.orgId,
      idempotencyKey,
    );
    if (existing) return existing;
  }

  const now = deps.clock.now();
  const event = applyDomain(() =>
    createEventDomain({
      id: deps.ids.next(),
      orgId: actor.orgId,
      name: input.name,
      startsAt: input.startsAt,
      createdBy: actor.userEmail,
      now,
    }),
  );

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: ACTION,
    resourceType: "event",
    resourceId: event.id,
    classification: "compensatable",
    versionBefore: 0,
    versionAfter: event.version,
    payload,
    inverse: { type: "archive-event" },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  try {
    await deps.events.create({
      event,
      operation,
      ...(idempotencyKey !== undefined
        ? { idempotency: { action: ACTION, key: idempotencyKey } }
        : {}),
    });
  } catch (err) {
    if (idempotencyKey !== undefined && isIdempotencyKeyViolation(err)) {
      const existing = await findCompletedCreate(
        deps,
        actor.orgId,
        idempotencyKey,
      );
      if (existing) return existing;
    }
    throw err;
  }

  return { resource: event, operationId: operation.id };
}
