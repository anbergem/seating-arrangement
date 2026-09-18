/**
 * `label-seat` (blueprint B8, B16).
 *
 * Writes a name on one seat. The seat is named by the side it is on and its
 * position along that side, never by an index into the seat array: a resize
 * renumbers that array, and an index would quietly move somebody to a
 * different side of the table.
 *
 * Nothing about a label changes the table's footprint, so this is the one
 * seating command that does not ask the database to re-check for free space.
 */

import type { Operation, SeatingTable } from "../../domain";
import { findSeat, labelSeat as labelSeatDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";

export interface LabelSeatInput {
  tableId: string;
  /** Which seat, counting clockwise from 0. `get-event` returns them in that
   * order. */
  seat: number;
  /** Empty clears the seat. */
  label: string;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function labelSeat(
  deps: Dependencies,
  actor: Actor,
  input: LabelSeatInput,
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

  const now = deps.clock.now();
  const next = applyDomain(() =>
    labelSeatDomain(table, input.seat, input.label, now),
  );

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "label-seat",
    resourceType: "seating_table",
    resourceId: table.id,
    classification: "reversible",
    versionBefore: table.version,
    versionAfter: next.version,
    payload: {
      seat: input.seat,
      label: findSeat(next, input.seat)?.label ?? "",
    },
    inverse: {
      type: "restore-seat-label",
      seat: input.seat,
      // `labelSeat` above already proved the seat exists.
      previousLabel: findSeat(table, input.seat)?.label ?? "",
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
