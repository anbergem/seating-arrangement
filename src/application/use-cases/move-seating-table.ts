/**
 * `move-seating-table` (blueprint B8, B16).
 *
 * The command behind a drag. The siblings are read so the domain can refuse an
 * overlap with a precise message, but that check is not the authority: two
 * people dragging two different tables at the same moment both pass it against
 * their own snapshot. The `seating_cells` primary key is what stops the second
 * one, and the repository rewrites this table's cells inside the same atomic
 * batch as the move.
 */

import type { Operation, SeatingTable } from "../../domain";
import { moveSeatingTable as moveSeatingTableDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";
import { loadFloorPlan } from "./floor-plan";

export interface MoveSeatingTableInput {
  tableId: string;
  gridX: number;
  gridY: number;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function moveSeatingTable(
  deps: Dependencies,
  actor: Actor,
  input: MoveSeatingTableInput,
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
  const next = applyDomain(() =>
    moveSeatingTableDomain(
      table,
      { gridX: input.gridX, gridY: input.gridY },
      plan,
      now,
    ),
  );

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "move-seating-table",
    resourceType: "seating_table",
    resourceId: table.id,
    classification: "reversible",
    versionBefore: table.version,
    versionAfter: next.version,
    payload: { gridX: next.gridX, gridY: next.gridY },
    inverse: {
      type: "restore-seating-table-position",
      previous: { gridX: table.gridX, gridY: table.gridY },
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
