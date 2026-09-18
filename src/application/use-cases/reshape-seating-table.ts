/**
 * `reshape-seating-table` (blueprint B8, B16).
 *
 * Changes a table's form: round or rectangular, how big it is, and whether a
 * rectangle's two ends carry a seat.
 *
 * Seats are derived from the form, so reshaping renumbers the perimeter. Names
 * are carried over by index, which across a change of kind is frankly a guess;
 * that is why the inverse records the *whole* previous seat array rather than
 * the numbers that describe the form. An undo puts every name back exactly
 * where it was.
 *
 * The footprint changes too, so the new cells have to be free.
 */

import type { Operation, SeatingTable, TableShapeKind } from "../../domain";
import { reshapeSeatingTable as reshapeSeatingTableDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";
import { loadFloorPlan } from "./floor-plan";

export interface ReshapeSeatingTableInput {
  tableId: string;
  kind: TableShapeKind;
  /** A rectangle's length, or a round table's diameter, in cells. */
  size: number;
  /** Ignored for a round table, which has no ends. */
  endSeats: boolean;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function reshapeSeatingTable(
  deps: Dependencies,
  actor: Actor,
  input: ReshapeSeatingTableInput,
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
    reshapeSeatingTableDomain(
      table,
      { kind: input.kind, size: input.size, endSeats: input.endSeats },
      plan,
      now,
    ),
  );

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "reshape-seating-table",
    resourceType: "seating_table",
    resourceId: table.id,
    classification: "reversible",
    versionBefore: table.version,
    versionAfter: next.version,
    payload: {
      kind: next.kind,
      size: next.size,
      endSeats: next.endSeats,
    },
    inverse: {
      type: "restore-seating-table-shape",
      previous: {
        kind: table.kind,
        size: table.size,
        endSeats: table.endSeats,
        seats: table.seats,
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
