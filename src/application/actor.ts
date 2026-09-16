/**
 * The authenticated actor for one action call (blueprint B7, decision D10).
 *
 * Every use case receives an `Actor`, never a raw session: `resolveActor` is
 * the single place that turns "whatever the interface layer handed us" into
 * "a user, in an organization, with a role" — or throws the `AppError` that
 * explains why not. Actions never accept an `orgId` argument (D10): the
 * active organization always comes from the request context, and the role
 * is always looked up fresh from membership, never trusted from the caller.
 */

import type { Role } from "./authorization";
import { AppError } from "./errors";
import type { MembershipReader } from "./ports";

export interface Actor {
  userEmail: string;
  orgId: string;
  role: Role;
  caller: string;
}

/** What the interface layer can tell us before anything has been checked. */
export interface RawContext {
  userEmail?: string;
  orgId?: string | null;
  caller?: string;
}

/** `RawContext.caller` when the interface layer did not supply one. */
const DEFAULT_CALLER = "unknown";

/**
 * Resolves a `RawContext` into an `Actor`. Order matters: authentication is
 * checked before authorization, and "no active organization" before "not a
 * member of it" — the latter needs an `orgId` to check membership against.
 */
export async function resolveActor(
  raw: RawContext,
  membership: MembershipReader,
): Promise<Actor> {
  if (!raw.userEmail) {
    throw new AppError("AUTHENTICATION", "Sign in required");
  }
  if (!raw.orgId) {
    throw new AppError("AUTHORIZATION", "No active organization");
  }
  const role = await membership.getRole(raw.orgId, raw.userEmail);
  if (role === null) {
    throw new AppError(
      "AUTHORIZATION",
      "Not a member of the active organization",
    );
  }
  return {
    userEmail: raw.userEmail,
    orgId: raw.orgId,
    role,
    caller: raw.caller ?? DEFAULT_CALLER,
  };
}
