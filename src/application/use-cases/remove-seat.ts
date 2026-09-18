/**
 * `remove-seat` (blueprint B8, B16).
 *
 * Takes one chair off a table, freeing the grid cell it stood in.
 *
 * This is how two tables are brought end to end into a continuous run: the
 * chair capping one table's end stands exactly where the next table's body has
 * to go, so it comes off first. The same thing you would do with real
 * furniture. `bootstrap-event-layout` does it for a whole arrangement at once;
 * this is the hand tool.
 *
 * It refuses a seat somebody is sitting in. Freeing space is not a good enough
 * reason to discard a name, so the caller clears the label first.
 */

import type { Operation, SeatingTable } from "../../domain";
import { removeSeat as removeSeatDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";

export interface RemoveSeatInput {
  tableId: string;
  /** Which seat, counting clockwise from 0. `get-event` returns them in that
   * order. */
  seat: number;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function removeSeat(
  deps: Dependencies,
  actor: Actor,
  input: RemoveSeatInput,
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
  const next = applyDomain(() => removeSeatDomain(table, input.seat, now));

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "remove-seat",
    resourceType: "seating_table",
    resourceId: table.id,
    classification: "reversible",
    versionBefore: table.version,
    versionAfter: next.version,
    payload: { seat: input.seat },
    inverse: { type: "restore-seat-presence", seat: input.seat, present: true },
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
