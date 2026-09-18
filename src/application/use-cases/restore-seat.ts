/**
 * `restore-seat` (blueprint B8, B16).
 *
 * Puts a chair back on a table. The cell it wants may have been taken by a
 * neighbouring table in the meantime — that is usually the whole reason it was
 * taken away — so this is one of the commands that can be refused for want of
 * space.
 */

import type { Operation, SeatingTable } from "../../domain";
import { restoreSeat as restoreSeatDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";
import { loadFloorPlan } from "./floor-plan";

export interface RestoreSeatInput {
  tableId: string;
  /** Which seat, counting clockwise from 0. `get-event` returns them in that
   * order. */
  seat: number;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function restoreSeat(
  deps: Dependencies,
  actor: Actor,
  input: RestoreSeatInput,
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
    restoreSeatDomain(table, input.seat, plan, now),
  );

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "restore-seat",
    resourceType: "seating_table",
    resourceId: table.id,
    classification: "reversible",
    versionBefore: table.version,
    versionAfter: next.version,
    payload: { seat: input.seat },
    inverse: {
      type: "restore-seat-presence",
      seat: input.seat,
      present: false,
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
