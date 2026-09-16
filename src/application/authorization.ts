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
  | "customers:read"
  | "customers:create"
  | "customers:archive"
  | "jobs:read"
  | "jobs:create"
  | "jobs:transition"
  | "jobs:reschedule"
  | "jobs:export"
  | "history:read"
  | "history:undo";

const MEMBER_CAPABILITIES: readonly Capability[] = [
  "customers:read",
  "customers:create",
  "jobs:read",
  "jobs:create",
  "jobs:transition",
  "jobs:reschedule",
  "history:read",
  "history:undo",
];

// `archive-customer` and `send-job-to-accounting` are the admin-only
// demonstrations the blueprint calls for; `owner` currently grants the same
// set as `admin` and is kept as its own entry because the blueprint names it
// separately and a future task may split them.
const ADMIN_CAPABILITIES: readonly Capability[] = [
  ...MEMBER_CAPABILITIES,
  "customers:archive",
  "jobs:export",
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
