/**
 * `archive-seating-table` (blueprint B8, B16).
 *
 * Takes a table off the floor plan. The row stays, with its seats and their
 * labels, so an undo can put the whole thing back; what it loses is its claim
 * on the space, which another table may take in the meantime. That is why the
 * inverse can legitimately fail — see `restoreSeatingTable` in the domain.
 */

import type { Operation, SeatingTable } from "../../domain";
import { archiveSeatingTable as archiveSeatingTableDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";

export interface ArchiveSeatingTableInput {
  tableId: string;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function archiveSeatingTable(
  deps: Dependencies,
  actor: Actor,
  input: ArchiveSeatingTableInput,
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
  const next = applyDomain(() => archiveSeatingTableDomain(table, now));

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "archive-seating-table",
    resourceType: "seating_table",
    resourceId: table.id,
    classification: "reversible",
    versionBefore: table.version,
    versionAfter: next.version,
    payload: {},
    inverse: { type: "restore-seating-table" },
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
