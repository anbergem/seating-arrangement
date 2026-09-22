/**
 * `redo-operation` (blueprint B9, decision D13).
 *
 * Redo is not "restore a snapshot" either: it re-runs the original forward
 * command through the domain, with the arguments that command recorded as its
 * `payload`. The handle it takes is the id of an **undo** operation — redo
 * answers "put back what I just undid" — and it is refused unless the record
 * still stands exactly where that undo left it, which is the same version rule
 * undo obeys.
 *
 * Two refusals are worth naming:
 *
 * - A create is never redone. Its undo was a *compensation* (the resource was
 *   archived, not deleted), so re-running `create-*` would produce a second
 *   resource rather than resurrect the first. B9 calls this INVARIANT.
 * - An undo of a *redo* cannot be redone. B9 lets a redo be undone
 *   (`canUndo` accepts kind `redo`, and the redo row carries the forward
 *   operation's inverse), but the operation such an undo points at is the redo
 *   row, whose action is `redo-operation` and not a domain command. That is
 *   refused with INVARIANT rather than guessed at; see
 *   `docs/plan/DISCREPANCIES.md`.
 */

import type {
  Event,
  FloorPlan,
  Operation,
  ResourceType,
  SeatingTable,
  TableShapeKind,
} from "../../domain";
import {
  archiveEvent,
  resizeRoom,
  archiveSeatingTable,
  labelSeat,
  moveSeatLabel,
  moveSeatingTable,
  reshapeSeatingTable,
  rotateSeatingTable,
  TABLE_SHAPE_KINDS,
} from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import { mayRedo, requireHistoryPermission } from "../history-policy";
import type { Dependencies } from "../ports";
import { applyDomain, isCompensated, type UndoRedoResult } from "./command";
import { loadFloorPlan } from "./floor-plan";
import { otherTableGuard, seatMoveTargets } from "./move-seat";

const ACTION = "redo-operation";

/** The refusal for a forward operation this use case has no way to re-apply:
 * an `irreversible` action (which could never have been undone), or the
 * `redo-operation` row an undo of a redo points at. */
const NOT_REDOABLE_MESSAGE = "This operation cannot be redone";

export interface RedoOperationInput {
  /** Id of the **undo** operation to reverse — not the forward operation it
   * undid. */
  operationId: string;
}

/** B9 step 1. Both refusals are INVARIANT: an operation that is not an undo
 * will never become one, and an undo that has already been redone is a
 * different row's business. */
function assertRedoable(undoOp: Operation): void {
  if (undoOp.kind !== "undo") {
    throw new AppError("INVARIANT", "Only an undo operation can be redone");
  }
  if (undoOp.undoneByOperationId !== null) {
    throw new AppError("INVARIANT", "This undo has already been redone");
  }
}

/** B9 step 2: the resource must still be where the undo left it, or redoing
 * would discard whatever happened since. */
function assertUnchanged(undoOp: Operation, currentVersion: number): void {
  if (currentVersion !== undoOp.versionAfter) {
    throw new AppError("CONFLICT", "Newer changes exist; redo refused");
  }
}

/**
 * B9 step 3: the forward operation the undo reversed, which holds the action
 * and arguments to replay.
 *
 * Its absence is a corrupt row rather than a caller error — an undo always
 * names the operation it undid — so it is `INTERNAL` with the reason withheld
 * (B5). A create is refused here, before anything is written.
 */
async function loadForwardOperation(
  deps: Dependencies,
  actor: Actor,
  undoOp: Operation,
): Promise<Operation> {
  const forward = undoOp.relatedOperationId
    ? await deps.operations.getById(actor.orgId, undoOp.relatedOperationId)
    : null;
  if (!forward) throw new AppError("INTERNAL", "Unexpected error");
  // A create, or a layout: its undo archived what it made, so re-running it
  // would produce a second one rather than bring the first back.
  if (isCompensated(forward)) {
    throw new AppError("INVARIANT", "A create cannot be redone");
  }
  if (forward.kind !== "forward")
    throw new AppError("INVARIANT", NOT_REDOABLE_MESSAGE);
  requireHistoryPermission(mayRedo(actor, forward));
  return forward;
}

/**
 * Reads one recorded argument out of a forward operation's payload.
 *
 * A payload that does not hold what its own action needs is a corrupt row
 * rather than a caller error, so every one of these is `INTERNAL` with the
 * reason withheld (B5).
 */
function payloadNumber(
  payload: Record<string, unknown> | null,
  key: string,
): number {
  const value = payload?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return value;
}

function payloadBoolean(
  payload: Record<string, unknown> | null,
  key: string,
): boolean {
  const value = payload?.[key];
  if (typeof value !== "boolean") {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return value;
}

function payloadString(
  payload: Record<string, unknown> | null,
  key: string,
): string {
  const value = payload?.[key];
  if (typeof value !== "string") {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return value;
}

function payloadShapeKind(
  payload: Record<string, unknown> | null,
): TableShapeKind {
  const value = payloadString(payload, "kind");
  const kind = TABLE_SHAPE_KINDS.find((candidate) => candidate === value);
  if (!kind) throw new AppError("INTERNAL", "Unexpected error");
  return kind;
}

function payloadSize(payload: Record<string, unknown> | null): number {
  const value = payload?.size;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return value;
}

/** B9 step 3 for an event. `bootstrap-event-layout` is deliberately absent: it
 * creates tables, so like every other create its undo was a compensation and
 * re-running it would make a second set rather than bring the first back. */
function reapplyEventForward(
  forward: Operation,
  event: Event,
  tables: readonly SeatingTable[],
  now: string,
): Event {
  switch (forward.action) {
    case "archive-event":
      return archiveEvent(event, now);
    case "resize-room":
      return resizeRoom(
        event,
        {
          width: payloadNumber(forward.payload, "width"),
          height: payloadNumber(forward.payload, "height"),
        },
        tables,
        now,
      );
    default:
      throw new AppError("INVARIANT", NOT_REDOABLE_MESSAGE);
  }
}

/**
 * B9 step 3 for a seating table.
 *
 * These are the ordinary domain functions, not the undo-only restore twins: a
 * redo moves the table back off wherever the undo put it, so the "already
 * there" and "already has that label" rules are not in the way.
 */
function reapplySeatingTableForward(
  forward: Operation,
  table: SeatingTable,
  plan: FloorPlan,
  now: string,
): SeatingTable {
  switch (forward.action) {
    case "move-seating-table":
      return moveSeatingTable(
        table,
        {
          gridX: payloadNumber(forward.payload, "gridX"),
          gridY: payloadNumber(forward.payload, "gridY"),
        },
        plan,
        now,
      );
    case "reshape-seating-table":
      return reshapeSeatingTable(
        table,
        {
          kind: payloadShapeKind(forward.payload),
          size: payloadSize(forward.payload),
          endSeats: payloadBoolean(forward.payload, "endSeats"),
        },
        plan,
        now,
      );
    case "label-seat":
      return labelSeat(
        table,
        payloadNumber(forward.payload, "seat"),
        payloadString(forward.payload, "label"),
        plan,
        now,
      );
    case "move-seat": {
      // Only a move within one table gets here; one across two is routed to
      // `redoSeatMove`, which has the second table to hand.
      const targets = seatMoveTargets(forward.payload);
      return moveSeatLabel(
        { table, seat: targets.fromSeat },
        { table, seat: targets.toSeat },
        plan,
        now,
      ).target;
    }
    case "rotate-seating-table":
      return rotateSeatingTable(table, plan, now);
    case "archive-seating-table":
      return archiveSeatingTable(table, now);
    default:
      throw new AppError("INVARIANT", NOT_REDOABLE_MESSAGE);
  }
}

/**
 * The audit row the redo writes about itself (B9 step 4). It carries the
 * *forward* operation's inverse, so the redo can itself be undone: `canUndo`
 * accepts kind `redo`, and applying that inverse puts the record back where
 * the undo had it.
 */
function redoOperationRow(input: {
  id: string;
  actor: Actor;
  undoOp: Operation;
  forward: Operation;
  resourceType: ResourceType;
  resourceId: string;
  versionBefore: number;
  versionAfter: number;
  /** Usually nothing; see `undoOperationRow`. A cross-table seat move carries
   * the second table's guard forward so a further undo can check it. */
  payload?: Record<string, unknown>;
  now: string;
}): Operation {
  return {
    id: input.id,
    orgId: input.actor.orgId,
    kind: "redo",
    action: ACTION,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    classification: "reversible",
    versionBefore: input.versionBefore,
    versionAfter: input.versionAfter,
    // Nothing to replay from here: the arguments a further redo would need
    // stay on the forward operation, the same way an undo row's do.
    payload: input.payload ?? {},
    inverse: input.forward.inverse,
    relatedOperationId: input.undoOp.id,
    undoneByOperationId: null,
    performedBy: input.actor.userEmail,
    performedVia: input.actor.caller,
    performedAt: input.now,
  };
}

export async function redoOperation(
  deps: Dependencies,
  actor: Actor,
  input: RedoOperationInput,
): Promise<UndoRedoResult> {
  requireCapability(actor, "history:undo");

  const undoOp = await deps.operations.getById(actor.orgId, input.operationId);
  if (!undoOp) throw new AppError("NOT_FOUND", "Operation not found");
  assertRedoable(undoOp);

  if (undoOp.resourceType === "event") {
    const event = await deps.events.getById(actor.orgId, undoOp.resourceId);
    if (!event) throw new AppError("NOT_FOUND", "Event not found");
    assertUnchanged(undoOp, event.version);
    const forward = await loadForwardOperation(deps, actor, undoOp);

    const siblings = await deps.seatingTables.list(actor.orgId, {
      eventId: event.id,
      status: "active",
    });
    const now = deps.clock.now();
    const next = applyDomain(() =>
      reapplyEventForward(forward, event, siblings, now),
    );
    const redoOp = redoOperationRow({
      id: deps.ids.next(),
      actor,
      undoOp,
      forward,
      resourceType: "event",
      resourceId: event.id,
      versionBefore: event.version,
      versionAfter: next.version,
      now,
    });

    await deps.events.commit({
      event: next,
      expectedVersion: event.version,
      operation: redoOp,
      markUndone: undoOp.id,
    });

    return { resource: next, operationId: redoOp.id, resourceType: "event" };
  }

  // Only two resource types remain, so this is the tail rather than a third
  // `if`: TypeScript narrows `undoOp.resourceType` to "seating_table" here.
  {
    const table = await deps.seatingTables.getById(
      actor.orgId,
      undoOp.resourceId,
    );
    if (!table) throw new AppError("NOT_FOUND", "Table not found");
    assertUnchanged(undoOp, table.version);
    const forward = await loadForwardOperation(deps, actor, undoOp);

    // `loadForwardOperation` has already checked the permission.
    if (forward.action === "move-seat" && otherTableGuard(forward.payload)) {
      return redoSeatMove(deps, actor, undoOp, forward, table);
    }

    const { plan } = await loadFloorPlan(deps, actor.orgId, table.eventId);
    const now = deps.clock.now();
    const next = applyDomain(() =>
      reapplySeatingTableForward(forward, table, plan, now),
    );
    const redoOp = redoOperationRow({
      id: deps.ids.next(),
      actor,
      undoOp,
      forward,
      resourceType: "seating_table",
      resourceId: table.id,
      versionBefore: table.version,
      versionAfter: next.version,
      now,
    });

    await deps.seatingTables.commit({
      table: next,
      expectedVersion: table.version,
      operation: redoOp,
      markUndone: undoOp.id,
    });

    return {
      resource: next,
      operationId: redoOp.id,
      resourceType: "seating_table",
    };
  }
}

/**
 * Redoing a seat move that crossed two tables.
 *
 * `reapplySeatingTableForward` cannot do this one: it is a pure function over
 * one table, and this needs a second read and a two-row write. Which is the
 * same reason `undoSeatMove` exists, and it is the mirror of it.
 *
 * The second table's guard is read from the **undo** row rather than the
 * forward one. The undo is the write that put that table where it now stands,
 * so its `versionAfter` is what "unchanged since" means here — the forward
 * row's is one version out of date by definition.
 *
 * The forward domain function is re-run rather than a restore twin, which is
 * the stance every other redo takes: after the undo the name is back on the
 * seat it started from, so none of the forward refusals are in the way.
 */
async function redoSeatMove(
  deps: Dependencies,
  actor: Actor,
  undoOp: Operation,
  forward: Operation,
  resourceTable: SeatingTable,
): Promise<UndoRedoResult> {
  const guard = otherTableGuard(undoOp.payload);
  const targets = seatMoveTargets(forward.payload);
  const otherId =
    targets.fromTableId === resourceTable.id
      ? targets.toTableId
      : targets.fromTableId;
  if (!guard || guard.tableId !== otherId) {
    throw new AppError("INTERNAL", "Unexpected error");
  }

  const other = await deps.seatingTables.getById(actor.orgId, otherId);
  if (!other) throw new AppError("NOT_FOUND", "Table not found");
  if (other.version !== guard.versionAfter) {
    throw new AppError("CONFLICT", "Newer changes exist; redo refused");
  }

  const byId = new Map([
    [resourceTable.id, resourceTable],
    [other.id, other],
  ]);
  const { plan } = await loadFloorPlan(
    deps,
    actor.orgId,
    resourceTable.eventId,
  );
  const now = deps.clock.now();
  const next = applyDomain(() =>
    moveSeatLabel(
      { table: byId.get(targets.fromTableId)!, seat: targets.fromSeat },
      { table: byId.get(targets.toTableId)!, seat: targets.toSeat },
      plan,
      now,
    ),
  );
  const nextResource =
    targets.fromTableId === resourceTable.id ? next.source : next.target;
  const nextOther =
    targets.fromTableId === resourceTable.id ? next.target : next.source;

  const redoOp = redoOperationRow({
    id: deps.ids.next(),
    actor,
    undoOp,
    forward,
    resourceType: "seating_table",
    resourceId: resourceTable.id,
    versionBefore: resourceTable.version,
    versionAfter: nextResource.version,
    payload: {
      other: {
        tableId: other.id,
        versionBefore: other.version,
        versionAfter: nextOther.version,
      },
    },
    now,
  });

  await deps.seatingTables.commitSeatMove({
    tables: [
      { table: nextResource, expectedVersion: resourceTable.version },
      { table: nextOther, expectedVersion: other.version },
    ],
    operation: redoOp,
    markUndone: undoOp.id,
  });

  return {
    resource: nextResource,
    operationId: redoOp.id,
    resourceType: "seating_table",
  };
}
