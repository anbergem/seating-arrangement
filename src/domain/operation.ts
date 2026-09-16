/**
 * Operation domain model (blueprint B4, B9).
 *
 * An `Operation` is the audit row every mutation produces, and the record undo
 * and redo (T10) replay. This file has no notion of persistence: it only
 * defines the shape and the pure rule for whether an operation may still be
 * undone (`canUndo`).
 */

import type { JobStatus } from "./job";

export type OperationKind = "forward" | "undo" | "redo";
export type OperationClassification =
  | "reversible"
  | "compensatable"
  | "irreversible";
export type ResourceType = "customer" | "job";

export interface Operation {
  id: string;
  orgId: string;
  kind: OperationKind;
  action: string; // action name, e.g. "complete-job"
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
  | {
      type: "restore-job-status";
      previous: {
        status: JobStatus;
        completedAt: string | null;
        archivedAt: string | null;
      };
    }
  | { type: "restore-job-schedule"; previousScheduledAt: string }
  | { type: "archive-job" } // compensation for create-job
  | { type: "restore-customer" }
  | { type: "archive-customer" }; // compensation for create-customer

export const OPERATION_CLASSIFICATION: Readonly<
  Record<string, OperationClassification>
> = {
  "create-customer": "compensatable",
  "archive-customer": "reversible",
  "create-job": "compensatable",
  "reschedule-job": "reversible",
  "start-job": "reversible",
  "complete-job": "reversible",
  "archive-job": "reversible",
  "send-job-to-accounting": "irreversible",
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
