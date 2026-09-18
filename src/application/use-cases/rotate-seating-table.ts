/**
 * `rotate-seating-table` (blueprint B8, B16).
 *
 * Turns a table a quarter turn clockwise. Its seats do not move with it: a seat
 * is its index in the clockwise walk over the table's *unrotated* shape, so
 * seat 3 is seat 3 afterwards and only where it is drawn changes. Turning a
 * table should not reseat anybody.
 *
 * It does move the table, though. `rotatedPlacement` pivots about the centre of
 * the bounding box so the table turns roughly where it stands rather than
 * sweeping across the room, which means the inverse has to restore the position
 * as well as the rotation.
 */

import type { Operation, SeatingTable } from "../../domain";
import { rotateSeatingTable as rotateSeatingTableDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";
import { loadFloorPlan } from "./floor-plan";

export interface RotateSeatingTableInput {
  tableId: string;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function rotateSeatingTable(
  deps: Dependencies,
  actor: Actor,
  input: RotateSeatingTableInput,
): Promise<CommandResult<SeatingTable>> {
  requireCapability(actor, "seating:write");

  const table = await deps.seatingTables.getById(actor.orgId, input.tableId);
  if (!table) throw new AppError("NOT_FOUND", "Table not found");
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== table.version
  ) {
    throw new AppError("CONFLICT", "The table was changed by someone else");
  }

  const { plan } = await loadFloorPlan(deps, actor.orgId, table.eventId);

  const now = deps.clock.now();
  const next = applyDomain(() => rotateSeatingTableDomain(table, plan, now));

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "rotate-seating-table",
    resourceType: "seating_table",
    resourceId: table.id,
    classification: "reversible",
    versionBefore: table.version,
    versionAfter: next.version,
    // Nothing to replay: rotation is a toggle, so redo simply turns it again.
    payload: {},
    inverse: {
      type: "restore-seating-table-rotation",
      previous: {
        rotation: table.rotation,
        gridX: table.gridX,
        gridY: table.gridY,
      },
    },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  await deps.seatingTables.commit({
    table: next,
    expectedVersion: table.version,
    operation,
  });

  return { resource: next, operationId: operation.id };
}
