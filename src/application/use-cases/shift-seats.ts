/**
 * `shift-seats` (blueprint B8, B16).
 *
 * Everybody along a row of chairs moves one place, so that somebody can be
 * seated where the shift started — or, where the chairs go all the way round a
 * table and every one of them is taken, so that the whole table turns by one.
 *
 * Those read as two features and are one walk: the chain of chairs is followed
 * from the chosen seat, each name moves to the chair ahead of it, and the
 * shift stops at the first empty chair. A closed chain with no empty chair has
 * nowhere to leave a gap, so the last person comes round to the chair the
 * first has just left. `src/domain/seat-chain.ts` has the geometry, including
 * why a rectangle with no chair at either end can never turn.
 *
 * ## Which table is the subject
 *
 * The chain runs wherever the furniture does, so a shift down the outside of
 * an L writes as many rows as it passes tables. The operation names the table
 * the user acted on, and the versions of every *other* table it wrote ride in
 * `payload.others` — which is what undo and redo check before they touch them.
 */

import type { Operation, SeatingTable } from "../../domain";
import { shiftSeats as shiftSeatsDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";
import { loadFloorPlan } from "./floor-plan";

export interface ShiftSeatsInput {
  /** The table holding the chair the shift starts from. */
  tableId: string;
  /** Which seat, counting clockwise from 0. */
  seat: number;
  /** The table holding the chair to shift toward. The same id for a shift
   * that stays on one table. */
  towardTableId: string;
  /** The next chair along in the direction to shift. A chain has no direction
   * of its own, so this is how one is named. */
  towardSeat: number;
  /** Version the caller last saw for `tableId`. */
  expectedVersion?: number;
}

export async function shiftSeats(
  deps: Dependencies,
  actor: Actor,
  input: ShiftSeatsInput,
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

  // The chain is derived from the whole plan — which chairs are there at all
  // depends on what else is standing in the room, and the chain may run
  // through tables the caller never named.
  const { plan } = await loadFloorPlan(deps, actor.orgId, table.eventId);

  const now = deps.clock.now();
  const shifted = applyDomain(() =>
    shiftSeatsDomain(
      plan,
      { tableId: input.tableId, seat: input.seat },
      { tableId: input.towardTableId, seat: input.towardSeat },
      now,
    ),
  );

  // Only one of the two ways a shift can end writes nothing at all, and the
  // domain refuses that one outright, so an empty result is a bug here.
  if (shifted.tables.length === 0) {
    throw new AppError("INTERNAL", "Unexpected error");
  }

  const versionOf = (id: string) =>
    plan.tables.find((candidate) => candidate.id === id)?.version ?? 0;
  const subject =
    shifted.tables.find((candidate) => candidate.id === table.id) ?? null;
  // The chair the user acted on always ends up holding something different —
  // that is what a shift is — so its table is always one of the written ones.
  if (!subject) throw new AppError("INTERNAL", "Unexpected error");

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "shift-seats",
    resourceType: "seating_table",
    resourceId: table.id,
    classification: "reversible",
    versionBefore: table.version,
    versionAfter: subject.version,
    payload: {
      tableId: input.tableId,
      seat: input.seat,
      towardTableId: input.towardTableId,
      towardSeat: input.towardSeat,
      seats: shifted.previous.length,
      others: shifted.tables
        .filter((written) => written.id !== table.id)
        .map((written) => ({
          tableId: written.id,
          versionBefore: versionOf(written.id),
          versionAfter: written.version,
        })),
    },
    inverse: {
      type: "restore-seat-labels",
      seats: shifted.previous.map((entry) => ({ ...entry })),
    },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  await deps.seatingTables.commitTables({
    tables: shifted.tables.map((written) => ({
      table: written,
      expectedVersion: versionOf(written.id),
    })),
    operation,
  });

  return { resource: subject, operationId: operation.id };
}
