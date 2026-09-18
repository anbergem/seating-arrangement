import type { Operation } from "../domain";
import type { Actor } from "./actor";
import { hasCapability, type Capability } from "./authorization";
import { AppError } from "./errors";

const FORWARD_CAPABILITIES: Readonly<Record<string, Capability>> = {
  "archive-event": "events:archive",
  "resize-room": "seating:write",
  "move-seating-table": "seating:write",
  "reshape-seating-table": "seating:write",
  "label-seat": "seating:write",
  "archive-seating-table": "seating:write",
};

/** History never grants a capability the underlying business action denies.
 * A member may compensate their own event creation; archiving somebody else's
 * event, or restoring an admin's archive, requires archive rights. Ordinary
 * seating changes may be reversed by any coworker who could have made them. */
export function mayUndo(actor: Actor, operation: Operation): boolean {
  if (!hasCapability(actor.role, "history:undo")) return false;
  switch (operation.inverse?.type) {
    case "archive-event":
      // A member may compensate the event they created, but archiving somebody
      // else's, or restoring an admin's archive, is an admin's business.
      return (
        hasCapability(actor.role, "events:archive") ||
        (operation.kind === "forward" &&
          operation.action === "create-event" &&
          operation.performedBy.toLowerCase() ===
            actor.userEmail.toLowerCase() &&
          hasCapability(actor.role, "events:create"))
      );
    case "restore-event":
      return hasCapability(actor.role, "events:archive");
    case "restore-room-size":
    case "undo-bootstrap":
    case "restore-seating-table-position":
    case "restore-seating-table-rotation":
    case "restore-seating-table-shape":
    case "restore-seat-label":
    case "restore-seat-presence":
    case "restore-seating-table":
    case "archive-seating-table":
      // Everyone who may change a floor plan may reverse a change to it:
      // there is no seating capability a role can hold one half of.
      return hasCapability(actor.role, "seating:write");
    default:
      return false;
  }
}

export function mayRedo(actor: Actor, forward: Operation): boolean {
  const capability = FORWARD_CAPABILITIES[forward.action];
  return (
    forward.kind === "forward" &&
    capability !== undefined &&
    hasCapability(actor.role, "history:undo") &&
    hasCapability(actor.role, capability)
  );
}

export function requireHistoryPermission(allowed: boolean): void {
  if (!allowed)
    throw new AppError("AUTHORIZATION", "You may not reverse this operation");
}
