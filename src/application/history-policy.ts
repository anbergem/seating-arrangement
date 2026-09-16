import type { Operation } from "../domain";
import type { Actor } from "./actor";
import { hasCapability, type Capability } from "./authorization";
import { AppError } from "./errors";

const FORWARD_CAPABILITIES: Readonly<Record<string, Capability>> = {
  "archive-customer": "customers:archive",
  "start-job": "jobs:transition",
  "complete-job": "jobs:transition",
  "archive-job": "jobs:transition",
  "reschedule-job": "jobs:reschedule",
};

/** History never grants a capability the underlying business action denies.
 * A member may compensate their own customer creation; archiving somebody
 * else's customer, or restoring an admin's archive, requires archive rights.
 * Ordinary job changes may be reversed by coworkers with the same capability. */
export function mayUndo(actor: Actor, operation: Operation): boolean {
  if (!hasCapability(actor.role, "history:undo")) return false;
  switch (operation.inverse?.type) {
    case "archive-customer":
      return (
        hasCapability(actor.role, "customers:archive") ||
        (operation.kind === "forward" &&
          operation.action === "create-customer" &&
          operation.performedBy.toLowerCase() ===
            actor.userEmail.toLowerCase() &&
          hasCapability(actor.role, "customers:create"))
      );
    case "restore-customer":
      return hasCapability(actor.role, "customers:archive");
    case "restore-job-schedule":
      return hasCapability(actor.role, "jobs:reschedule");
    case "restore-job-status":
    case "archive-job":
      return hasCapability(actor.role, "jobs:transition");
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

/** An invoice intent survives retries, so history cannot reopen its completed work. */
export function reopensCompletedJob(operation: Operation): boolean {
  return (
    operation.inverse?.type === "restore-job-status" &&
    (operation.inverse.previous.status === "scheduled" ||
      operation.inverse.previous.status === "in_progress")
  );
}
