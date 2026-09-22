/**
 * `move-seat` (blueprint B8, B16).
 *
 * Moves the name on one seat to another seat — the command behind dragging a
 * guest from one chair to another. A destination that already has a name
 * **swaps** with it: nothing is overwritten, only relocated.
 *
 * ## Why this is not two `label-seat` calls
 *
 * Two calls have a state between them where the guest has left one chair and
 * not arrived at the other. That state is not merely untidy:
 *
 *   * it is two audit rows and two Undos for one intent;
 *   * the second call can fail, and then the name is simply gone; and
 *   * clearing first and setting second is the only order that can work, since
 *     a name claims its cell — so the *intermediate* state is what the
 *     database would be asked to accept, and a crash leaves it there.
 *
 * One command means one row, one Undo and, across two tables, one atomic
 * batch (`commitSeatMove`).
 *
 * ## Which table is the subject
 *
 * The operation's resource is the table the name landed on, as `label-seat`'s
 * is the table it was written on. A move across tables changes a second row
 * too, and one `versionBefore`/`versionAfter` pair cannot guard both, so the
 * source table's versions ride in `payload.other` — which is what `undo` and
 * `redo` check before they touch it.
 */

import type { Operation, SeatingTable } from "../../domain";
import { findSeat, moveSeatLabel } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";
import { loadFloorPlan } from "./floor-plan";

export interface MoveSeatInput {
  /** The table the name is on now. */
  fromTableId: string;
  /** Which seat it is on, counting clockwise from 0. */
  fromSeat: number;
  /** The table it is going to. The same id for a move within one table. */
  toTableId: string;
  /** Which seat it is going to. */
  toSeat: number;
  /** Version the caller last saw for the table the name is on. */
  fromExpectedVersion?: number;
  /** Version the caller last saw for the table it is going to. */
  toExpectedVersion?: number;
}

export async function moveSeat(
  deps: Dependencies,
  actor: Actor,
  input: MoveSeatInput,
): Promise<CommandResult<SeatingTable>> {
  requireCapability(actor, "seating:write");

  const from = await deps.seatingTables.getById(actor.orgId, input.fromTableId);
  if (!from) throw new AppError("NOT_FOUND", "Table not found");
  // Read once when both seats are on one table. Two equal-but-separate copies
  // would make the result depend on which of them each half was read from.
  const to =
    input.toTableId === input.fromTableId
      ? from
      : await deps.seatingTables.getById(actor.orgId, input.toTableId);
  if (!to) throw new AppError("NOT_FOUND", "Table not found");

  if (
    input.fromExpectedVersion !== undefined &&
    input.fromExpectedVersion !== from.version
  ) {
    throw new AppError("CONFLICT", "The table was changed by someone else");
  }
  if (
    input.toExpectedVersion !== undefined &&
    input.toExpectedVersion !== to.version
  ) {
    throw new AppError("CONFLICT", "The table was changed by someone else");
  }

  // Naming somebody is what makes a chair claim its cell, so a move is a
  // placement question and needs the plan. Both tables must be at the same
  // event for the plan to mean anything about both of them — the domain
  // refuses the pair if they are not, at the cost of this one read.
  const { plan } = await loadFloorPlan(deps, actor.orgId, from.eventId);

  const now = deps.clock.now();
  const moved = applyDomain(() =>
    moveSeatLabel(
      { table: from, seat: input.fromSeat },
      { table: to, seat: input.toSeat },
      plan,
      now,
    ),
  );

  const sameTable = from.id === to.id;
  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "move-seat",
    resourceType: "seating_table",
    resourceId: to.id,
    classification: "reversible",
    versionBefore: to.version,
    versionAfter: moved.target.version,
    payload: {
      fromTableId: from.id,
      fromSeat: input.fromSeat,
      toTableId: to.id,
      toSeat: input.toSeat,
      label: findSeat(moved.target, input.toSeat)?.label ?? "",
      // The second row's guard. Absent when there is no second row.
      ...(sameTable
        ? {}
        : {
            other: {
              tableId: from.id,
              versionBefore: from.version,
              versionAfter: moved.source.version,
            },
          }),
    },
    inverse: {
      type: "restore-seat-placement",
      // `moveSeatLabel` above already proved both seats exist.
      from: {
        tableId: from.id,
        seat: input.fromSeat,
        label: findSeat(from, input.fromSeat)?.label ?? "",
      },
      to: {
        tableId: to.id,
        seat: input.toSeat,
        label: findSeat(to, input.toSeat)?.label ?? "",
      },
    },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  if (sameTable) {
    // One array, one row: `moved.source` and `moved.target` are the same
    // object, and writing it twice would be writing it twice.
    await deps.seatingTables.commit({
      table: moved.target,
      expectedVersion: to.version,
      operation,
    });
  } else {
    await deps.seatingTables.commitSeatMove({
      tables: [
        { table: moved.source, expectedVersion: from.version },
        { table: moved.target, expectedVersion: to.version },
      ],
      operation,
    });
  }

  return { resource: moved.target, operationId: operation.id };
}

/**
 * The second table's version guard, as a `move-seat` row carries it.
 *
 * It lives in `payload` rather than in `inverse` because an inverse says what
 * to restore, and this says what the writer may assume is still true. An
 * `Operation` has one `versionBefore`/`versionAfter` pair, which guards the
 * one table it names as its resource; without this, undoing a move across
 * tables would write the second one blind and could silently discard somebody
 * else's change to it.
 */
export interface OtherTableGuard {
  tableId: string;
  versionBefore: number;
  versionAfter: number;
}

/** The guard off a `move-seat`, `undo` or `redo` row, or `null` when the move
 * was within one table and there is no second row. A malformed one is a
 * corrupt row rather than a caller's mistake, so it is `INTERNAL` (B5). */
export function otherTableGuard(
  payload: Record<string, unknown> | null,
): OtherTableGuard | null {
  const value = payload?.other;
  if (value === undefined || value === null) return null;
  const other = value as Partial<OtherTableGuard>;
  if (
    typeof other.tableId !== "string" ||
    !Number.isInteger(other.versionBefore) ||
    !Number.isInteger(other.versionAfter)
  ) {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return other as OtherTableGuard;
}

/** Which two seats a recorded `move-seat` named. Read by `redo-operation`,
 * which re-runs the forward command rather than an inverse. */
export function seatMoveTargets(payload: Record<string, unknown> | null): {
  fromTableId: string;
  fromSeat: number;
  toTableId: string;
  toSeat: number;
} {
  const targets = {
    fromTableId: payload?.fromTableId,
    fromSeat: payload?.fromSeat,
    toTableId: payload?.toTableId,
    toSeat: payload?.toSeat,
  };
  if (
    typeof targets.fromTableId !== "string" ||
    typeof targets.toTableId !== "string" ||
    !Number.isInteger(targets.fromSeat) ||
    !Number.isInteger(targets.toSeat)
  ) {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return targets as {
    fromTableId: string;
    fromSeat: number;
    toTableId: string;
    toSeat: number;
  };
}
