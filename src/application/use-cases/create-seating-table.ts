/**
 * `create-seating-table` (blueprint B8, decision D14).
 *
 * Two preconditions this file does not decide itself:
 *
 * - The event must exist, belong to this organization and still be active.
 *   That is enforced inside the repository's atomic write (B11), because a
 *   check here followed by a write there is a race: D1 cannot hold a
 *   transaction open across the two. The repository reports it as
 *   `NOT_FOUND "Event not found or archived"`.
 * - The space must be free. The domain checks it against the tables read below
 *   so the caller gets a precise `INVARIANT`, but the binding check is the
 *   no-overlap predicate inside the same insert, which turns a lost race into a
 *   `CONFLICT` rather than an overlapping floor plan.
 *
 * `gridX`/`gridY` are optional: without them the table is dropped into the
 * first free spot, which is what the "add a table" button wants.
 *
 * Compensatable, not reversible: its inverse removes the table rather than
 * deleting it.
 */

import type {
  Operation,
  Rotation,
  SeatingTable,
  TableShape,
  TableShapeKind,
} from "../../domain";
import {
  buildSeats,
  createSeatingTable as createSeatingTableDomain,
  firstFreePlacement,
  normalizeShape,
  occupiedCellKeys,
} from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import {
  applyDomain,
  isIdempotencyKeyViolation,
  type CommandResult,
} from "./command";
import { loadFloorPlan } from "./floor-plan";

const ACTION = "create-seating-table";

export interface CreateSeatingTableInput {
  eventId: string;
  name: string;
  /** `rectangle` or `round`; defaults to a rectangle. */
  kind?: TableShapeKind;
  /** A rectangle's length, or a round table's diameter, in cells. */
  size: number;
  /** Ignored for a round table, which has no ends. */
  endSeats?: boolean;
  /** Quarter turns clockwise; defaults to none, and ignored for a round
   * table, whose square body turns into itself. */
  rotation?: Rotation;
  /** Both or neither; omitted, the first free spot is used. */
  gridX?: number;
  gridY?: number;
  /** Repeat the same key to retry safely: the second call returns the table the
   * first one created. */
  idempotencyKey?: string;
}

/** See `create-event.ts` for why an inconsistent key is `INTERNAL`. */
async function findCompletedCreate(
  deps: Dependencies,
  orgId: string,
  key: string,
): Promise<CommandResult<SeatingTable> | null> {
  const resourceId = await deps.idempotency.find(orgId, ACTION, key);
  if (resourceId === null) return null;

  const table = await deps.seatingTables.getById(orgId, resourceId);
  const created = await deps.operations.findCreateOperation(
    orgId,
    "seating_table",
    resourceId,
  );
  if (!table || !created) {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return { resource: table, operationId: created.id };
}

export async function createSeatingTable(
  deps: Dependencies,
  actor: Actor,
  input: CreateSeatingTableInput,
): Promise<CommandResult<SeatingTable>> {
  requireCapability(actor, "seating:write");

  const { idempotencyKey } = input;

  if (idempotencyKey !== undefined) {
    const existing = await findCompletedCreate(
      deps,
      actor.orgId,
      idempotencyKey,
    );
    if (existing) return existing;
  }

  if ((input.gridX === undefined) !== (input.gridY === undefined)) {
    throw new AppError("VALIDATION", "Give both gridX and gridY, or neither");
  }

  const { plan } = await loadFloorPlan(deps, actor.orgId, input.eventId);
  const shape: TableShape = normalizeShape({
    kind: input.kind ?? "rectangle",
    size: input.size,
    endSeats: input.endSeats,
    rotation: input.rotation,
  });
  const position =
    input.gridX !== undefined && input.gridY !== undefined
      ? { gridX: input.gridX, gridY: input.gridY }
      : firstFreePlacement(
          shape,
          buildSeats(shape),
          occupiedCellKeys(plan.tables),
          plan.room,
        );
  if (position === null) {
    throw new AppError(
      "VALIDATION",
      "There is no free space left on this floor plan",
    );
  }

  const now = deps.clock.now();
  const table = applyDomain(() =>
    createSeatingTableDomain(
      {
        id: deps.ids.next(),
        orgId: actor.orgId,
        eventId: input.eventId,
        name: input.name,
        ...shape,
        gridX: position.gridX,
        gridY: position.gridY,
        createdBy: actor.userEmail,
        now,
      },
      plan,
    ),
  );

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: ACTION,
    resourceType: "seating_table",
    resourceId: table.id,
    classification: "compensatable",
    versionBefore: 0,
    versionAfter: table.version,
    // The resolved position, not the caller's: a create is never redone, so
    // the payload is documentation, and the resolved value is the useful one.
    payload: {
      eventId: table.eventId,
      name: table.name,
      kind: table.kind,
      size: table.size,
      endSeats: table.endSeats,
      rotation: table.rotation,
      gridX: table.gridX,
      gridY: table.gridY,
    },
    inverse: { type: "archive-seating-table" },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  try {
    await deps.seatingTables.create({
      table,
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

  return { resource: table, operationId: operation.id };
}
