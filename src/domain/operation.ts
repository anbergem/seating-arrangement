/**
 * Operation domain model (blueprint B4, B9).
 *
 * An `Operation` is the audit row every mutation produces, and the record undo
 * and redo (T10) replay. This file has no notion of persistence: it only
 * defines the shape and the pure rule for whether an operation may still be
 * undone (`canUndo`).
 */

import type { Room, Rotation, Seat, TableShapeKind } from "./seating-table";

export type OperationKind = "forward" | "undo" | "redo";
export type OperationClassification =
  | "reversible"
  | "compensatable"
  | "irreversible";
export type ResourceType = "event" | "seating_table";

export interface Operation {
  id: string;
  orgId: string;
  kind: OperationKind;
  action: string; // action name, e.g. "label-seat"
  resourceType: ResourceType;
  resourceId: string;
  classification: OperationClassification;
  versionBefore: number;
  versionAfter: number;
  payload: Record<string, unknown> | null;
  inverse: InverseCommand | null; // how to undo this operation
  relatedOperationId: string | null; // undo → the forward op it undoes; redo → the undo op it reverts
  undoneByOperationId: string | null;
  performedBy: string;
  performedVia: string;
  performedAt: string;
}

export type InverseCommand =
  | { type: "restore-event" }
  | { type: "archive-event" } // compensation for create-event
  | {
      type: "restore-seating-table-position";
      previous: { gridX: number; gridY: number };
    }
  | {
      type: "restore-seating-table-rotation";
      previous: { rotation: Rotation; gridX: number; gridY: number };
    }
  | {
      type: "restore-seating-table-shape";
      previous: {
        kind: TableShapeKind;
        size: number;
        endSeats: boolean;
        seats: readonly Seat[];
      };
    }
  | { type: "restore-room-size"; previous: Room }
  // Compensation for `bootstrap-event-layout`, which creates many tables and
  // may enlarge the room. Both have to come back for the event to look as it
  // did, so one inverse carries both rather than leaving a grown room behind.
  | {
      type: "undo-bootstrap";
      tableIds: readonly string[];
      previousRoom: Room;
    }
  | { type: "restore-seat-label"; seat: number; previousLabel: string }
  // Undoing a `move-seat`: the name each of the two seats had before it. The
  // two seats may be on one table or on two, and `from.tableId !==
  // to.tableId` is what says which — a move across tables is written to two
  // rows and needs a second version guard, which rides in the operation's
  // payload rather than here, because an inverse says what to restore and not
  // what the writer may assume.
  | {
      type: "restore-seat-placement";
      from: { tableId: string; seat: number; label: string };
      to: { tableId: string; seat: number; label: string };
    }
  // Undoing a `shift-seats`: the name every chair the shift touched had
  // before it. A list rather than a rule, because the same shape has to
  // describe a bench that slid along and a table that turned right round —
  // and because replaying a permutation backwards would carry along any name
  // somebody has written on one of those chairs since.
  | {
      type: "restore-seat-labels";
      seats: readonly { tableId: string; seat: number; label: string }[];
    }
  | { type: "restore-seating-table" }
  | { type: "archive-seating-table" }; // compensation for create-seating-table

export const OPERATION_CLASSIFICATION: Readonly<
  Record<string, OperationClassification>
> = {
  "create-event": "compensatable",
  "archive-event": "reversible",
  "resize-room": "reversible",
  // It creates records, so its undo archives them and cannot be replayed —
  // the same rule `create-seating-table` follows.
  "bootstrap-event-layout": "compensatable",
  "create-seating-table": "compensatable",
  "move-seating-table": "reversible",
  "rotate-seating-table": "reversible",
  "reshape-seating-table": "reversible",
  "label-seat": "reversible",
  "move-seat": "reversible",
  "shift-seats": "reversible",
  "archive-seating-table": "reversible",
  "undo-operation": "reversible",
  "redo-operation": "reversible",
};

/**
 * Whether `op` may still be undone against the resource's `currentVersion`.
 * Checked in this order: only a `forward` or `redo` operation is a candidate
 * for undo at all (`not-forward`); an operation already undone cannot be
 * undone again (`already-undone`); an `irreversible` operation never can
 * (`irreversible`); and the resource must still be at the version this
 * operation left it at, or newer changes would be silently discarded
 * (`conflict`).
 */
export function canUndo(
  op: Operation,
  currentVersion: number,
):
  | { ok: true }
  | {
      ok: false;
      reason: "already-undone" | "irreversible" | "conflict" | "not-forward";
    } {
  if (op.kind !== "forward" && op.kind !== "redo") {
    return { ok: false, reason: "not-forward" };
  }
  if (op.undoneByOperationId !== null) {
    return { ok: false, reason: "already-undone" };
  }
  if (op.classification === "irreversible") {
    return { ok: false, reason: "irreversible" };
  }
  if (currentVersion !== op.versionAfter) {
    return { ok: false, reason: "conflict" };
  }
  return { ok: true };
}
