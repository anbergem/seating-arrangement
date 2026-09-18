/**
 * `undo-operation` (blueprint B9, decision D13).
 *
 * Undo here is semantic, not a snapshot restore: every command recorded the
 * *inverse command* that reverses it (B8), and this use case replays that
 * inverse through the same domain functions any other command uses. So undoing
 * a create removes the resource rather than deleting it, and undoing a move
 * restores the exact cell that was recorded — never one guessed from the
 * action name.
 *
 * The one rule that makes it safe is `canUndo`: the resource must still be at
 * the version the operation left it at. If anyone changed the record since —
 * including the same user through another surface — undo is refused with
 * CONFLICT rather than silently discarding that change. The version is checked
 * twice: here, against what was just read, and again inside the atomic write,
 * which also marks the undone operation in the same batch (B11's `markUndone`)
 * so an operation can never be marked undone by an audit row that was not
 * written.
 *
 * The undo itself is an ordinary operation row (kind `undo`), which is what
 * makes redo possible and what makes an undo visible in the history feed. Its
 * own `inverse` is `null`: an undo is never undone (`canUndo` refuses it as
 * `not-forward`) — `redo-operation` reverses it instead, reading the action and
 * arguments to re-apply from the forward operation this row points at. See
 * `docs/plan/DISCREPANCIES.md` for why B9's `{ type: "redo", … }` inverse is
 * not what is stored.
 */

import type {
  Event,
  FloorPlan,
  InverseCommand,
  Operation,
  ResourceType,
  SeatingTable,
} from "../../domain";
import {
  archiveEvent,
  archiveSeatingTable,
  canUndo,
  restoreEvent,
  restoreRoomSize,
  restoreSeatingTable,
  restoreSeatingTablePosition,
  restoreSeatingTableRotation,
  restoreSeatingTableShape,
  restoreSeatLabel,
} from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import { mayUndo, requireHistoryPermission } from "../history-policy";
import type { Dependencies } from "../ports";
import { applyDomain, type UndoRedoResult } from "./command";
import { loadFloorPlan } from "./floor-plan";

const ACTION = "undo-operation";

export interface UndoOperationInput {
  /** Id of the operation to reverse, from `list-recent-activity` or from the
   * `operationId` a command returned. */
  operationId: string;
}

/** B9's four refusals, with the messages B9 fixes. `already-undone` and
 * `conflict` are CONFLICT because the caller can recover by re-reading;
 * `irreversible` and `not-forward` are INVARIANT because no amount of
 * re-reading will make this operation undoable. */
function assertUndoable(op: Operation, currentVersion: number): void {
  const verdict = canUndo(op, currentVersion);
  if (verdict.ok) return;
  switch (verdict.reason) {
    case "already-undone":
      throw new AppError("CONFLICT", "Already undone");
    case "irreversible":
      throw new AppError("INVARIANT", "This operation cannot be undone");
    case "conflict":
      throw new AppError("CONFLICT", "Newer changes exist; undo refused");
    case "not-forward":
      throw new AppError("INVARIANT", "Use redo for an undo operation");
  }
}

/**
 * An operation whose `inverse` does not fit the resource it names — a
 * `restore-event` recorded against a table, or a missing inverse on an
 * operation `canUndo` accepted — is a corrupt row, not a caller's mistake, so
 * it is `INTERNAL` with the reason withheld (B5).
 */
function inverseMismatch(): AppError {
  return new AppError("INTERNAL", "Unexpected error");
}

/** The event half of B9 step 4. `tables` is only wanted by `restore-room-size`,
 * which may not shrink the floor out from under a table somebody has placed in
 * the meantime. */
function applyEventInverse(
  inverse: InverseCommand | null,
  event: Event,
  tables: readonly SeatingTable[],
  now: string,
): Event {
  switch (inverse?.type) {
    case "restore-event":
      return restoreEvent(event, now);
    case "archive-event":
      return archiveEvent(event, now);
    case "restore-room-size":
      return restoreRoomSize(event, inverse.previous, tables, now);
    default:
      throw inverseMismatch();
  }
}

/**
 * The seating half of B9 step 4.
 *
 * Most of these put the table back into *space* — a position, a rotation, a
 * shape, a chair — so they take the event's other tables and refuse when
 * those cells have been taken in the meantime: undo restores a recorded fact,
 * but it may not restore it on top of somebody else. `siblings` is therefore a
 * parameter rather than a lookup inside each branch, since only
 * `restore-seat-label` can do without it.
 */
function applySeatingTableInverse(
  inverse: InverseCommand | null,
  table: SeatingTable,
  plan: FloorPlan,
  now: string,
): SeatingTable {
  switch (inverse?.type) {
    case "restore-seating-table-position":
      return restoreSeatingTablePosition(table, inverse.previous, plan, now);
    case "restore-seating-table-rotation":
      return restoreSeatingTableRotation(table, inverse.previous, plan, now);
    case "restore-seating-table-shape":
      return restoreSeatingTableShape(table, inverse.previous, plan, now);
    case "restore-seat-label":
      return restoreSeatLabel(
        table,
        inverse.seat,
        inverse.previousLabel,
        plan,
        now,
      );
    case "restore-seating-table":
      return restoreSeatingTable(table, plan, now);
    case "archive-seating-table":
      return archiveSeatingTable(table, now);
    default:
      throw inverseMismatch();
  }
}

/** The audit row the undo writes about itself (B9 step 5). `payload` is `{}`
 * rather than `null` because there is nothing to replay from it: redo reads
 * the action and its arguments from the forward operation at
 * `relatedOperationId`. */
function undoOperationRow(input: {
  id: string;
  actor: Actor;
  undone: Operation;
  resourceType: ResourceType;
  resourceId: string;
  versionBefore: number;
  versionAfter: number;
  now: string;
}): Operation {
  return {
    id: input.id,
    orgId: input.actor.orgId,
    kind: "undo",
    action: ACTION,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    classification: "reversible",
    versionBefore: input.versionBefore,
    versionAfter: input.versionAfter,
    payload: {},
    inverse: null,
    relatedOperationId: input.undone.id,
    undoneByOperationId: null,
    performedBy: input.actor.userEmail,
    performedVia: input.actor.caller,
    performedAt: input.now,
  };
}

export async function undoOperation(
  deps: Dependencies,
  actor: Actor,
  input: UndoOperationInput,
): Promise<UndoRedoResult> {
  requireCapability(actor, "history:undo");

  // Scoped by organization like every other read, so an operation id from
  // another organization is indistinguishable from one that does not exist.
  const op = await deps.operations.getById(actor.orgId, input.operationId);
  if (!op) throw new AppError("NOT_FOUND", "Operation not found");

  if (op.resourceType === "event") {
    const event = await deps.events.getById(actor.orgId, op.resourceId);
    if (!event) throw new AppError("NOT_FOUND", "Event not found");
    assertUndoable(op, event.version);
    requireHistoryPermission(mayUndo(actor, op));

    if (op.inverse?.type === "undo-bootstrap") {
      return undoBootstrap(deps, actor, op, event, op.inverse);
    }

    const siblings = await deps.seatingTables.list(actor.orgId, {
      eventId: event.id,
      status: "active",
    });
    const now = deps.clock.now();
    const restored = applyDomain(() =>
      applyEventInverse(op.inverse, event, siblings, now),
    );
    const undoOp = undoOperationRow({
      id: deps.ids.next(),
      actor,
      undone: op,
      resourceType: "event",
      resourceId: event.id,
      versionBefore: event.version,
      versionAfter: restored.version,
      now,
    });

    await deps.events.commit({
      event: restored,
      expectedVersion: event.version,
      operation: undoOp,
      markUndone: op.id,
    });

    return {
      resource: restored,
      operationId: undoOp.id,
      resourceType: "event",
    };
  }

  // Only two resource types remain, so this is the tail rather than a third
  // `if`: TypeScript narrows `op.resourceType` to "seating_table" here.
  {
    const table = await deps.seatingTables.getById(actor.orgId, op.resourceId);
    if (!table) throw new AppError("NOT_FOUND", "Table not found");
    assertUndoable(op, table.version);
    requireHistoryPermission(mayUndo(actor, op));

    const { plan } = await loadFloorPlan(deps, actor.orgId, table.eventId);
    const now = deps.clock.now();
    const restored = applyDomain(() =>
      applySeatingTableInverse(op.inverse, table, plan, now),
    );
    const undoOp = undoOperationRow({
      id: deps.ids.next(),
      actor,
      undone: op,
      resourceType: "seating_table",
      resourceId: table.id,
      versionBefore: table.version,
      versionAfter: restored.version,
      now,
    });

    await deps.seatingTables.commit({
      table: restored,
      expectedVersion: table.version,
      operation: undoOp,
      markUndone: op.id,
    });

    return {
      resource: restored,
      operationId: undoOp.id,
      resourceType: "seating_table",
    };
  }
}

/**
 * Undoing a venue bootstrap: every table it placed comes off the plan and the
 * room goes back to the size it was.
 *
 * It is its own function rather than a branch of `applyEventInverse` because it
 * is the one inverse that is not a single record changing state — it writes the
 * event and a dozen tables, so it needs the repository method that does both at
 * once rather than `events.commit`.
 *
 * A table that is already archived, or that somebody has deleted from under us,
 * is skipped rather than being an error: the point of the undo is that the
 * layout is gone afterwards, and a table that is already gone satisfies that.
 */
async function undoBootstrap(
  deps: Dependencies,
  actor: Actor,
  op: Operation,
  event: Event,
  inverse: Extract<InverseCommand, { type: "undo-bootstrap" }>,
): Promise<UndoRedoResult> {
  const now = deps.clock.now();
  const found = await Promise.all(
    inverse.tableIds.map((id) => deps.seatingTables.getById(actor.orgId, id)),
  );
  const standing = found.filter(
    (table): table is SeatingTable => table?.status === "active",
  );
  const archived = standing.map((table) => ({
    table: applyDomain(() => archiveSeatingTable(table, now)),
    expectedVersion: table.version,
  }));

  // The tables are coming off, so nothing can be standing in the space the
  // smaller room is about to give up — but somebody may have added a table of
  // their own since, and `restoreRoomSize` is what refuses that.
  const remaining = (
    await deps.seatingTables.list(actor.orgId, {
      eventId: event.id,
      status: "active",
    })
  ).filter((table) => !inverse.tableIds.includes(table.id));
  const restored = applyDomain(() =>
    restoreRoomSize(event, inverse.previousRoom, remaining, now),
  );

  const undoOp = undoOperationRow({
    id: deps.ids.next(),
    actor,
    undone: op,
    resourceType: "event",
    resourceId: event.id,
    versionBefore: event.version,
    versionAfter: restored.version,
    now,
  });

  await deps.seatingTables.archiveLayout({
    event: restored,
    expectedVersion: event.version,
    tables: archived,
    operation: undoOp,
    markUndone: op.id,
  });

  return { resource: restored, operationId: undoOp.id, resourceType: "event" };
}
