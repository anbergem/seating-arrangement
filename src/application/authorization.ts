/**
 * Role-to-capability policy (blueprint B6, decision D09).
 *
 * The framework offers an `authorize` hook on `defineAction`, but D09
 * deliberately does not use it: every use case instead calls
 * `requireCapability` on itself, right after resolving the actor, against
 * this one policy module. That keeps the check unit-testable with plain
 * in-memory doubles and identical on every surface — UI, agent, MCP, HTTP.
 */

import type { Actor } from "./actor";
import { AppError } from "./errors";

export type Role = "owner" | "admin" | "member";

export type Capability =
  | "events:read"
  | "events:create"
  | "events:archive"
  | "seating:read"
  | "seating:write"
  | "history:read"
  | "history:undo";

const MEMBER_CAPABILITIES: readonly Capability[] = [
  "events:read",
  "events:create",
  "seating:read",
  "seating:write",
  "history:read",
  "history:undo",
];

// Archiving an event is the admin-only capability: it takes a whole floor plan
// out of the working set at once, where every other seating change touches one
// table. `owner` currently grants the same set as `admin` and is kept as its
// own entry because a future task may split them.
const ADMIN_CAPABILITIES: readonly Capability[] = [
  ...MEMBER_CAPABILITIES,
  "events:archive",
];

const OWNER_CAPABILITIES: readonly Capability[] = ADMIN_CAPABILITIES;

export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> =
  {
    member: MEMBER_CAPABILITIES,
    admin: ADMIN_CAPABILITIES,
    owner: OWNER_CAPABILITIES,
  };

export function hasCapability(role: Role, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(cap);
}

/** Throws `AppError("AUTHORIZATION", "Role <role> may not <cap>")` unless
 * `actor.role` has `cap`. This is the only place that message is built, so
 * every surface reports the same denial. */
export function requireCapability(actor: Actor, cap: Capability): void {
  if (!hasCapability(actor.role, cap)) {
    throw new AppError("AUTHORIZATION", `Role ${actor.role} may not ${cap}`);
  }
}
