/**
 * `MembershipReader` against the framework's `org_members` table (F6, B11).
 *
 * The framework puts no role on the request context, so this is where an
 * actor's role comes from on every single action call (D10): the role is never
 * taken from the caller, and never cached, so revoking a membership takes
 * effect on the next request.
 *
 * This is the one table in the application that the framework owns rather than
 * `migrations/`. It is read here and never written.
 */

import type { Role } from "../../application/authorization";
import type { MembershipReader } from "../../application/ports";
import { logWarning } from "../logging";
import type { DbExecSource } from "./atomic";
import { resolveExec } from "./atomic";
import { SELECT_MEMBER_ROLE } from "./sql";

const ROLES: readonly Role[] = ["owner", "admin", "member"];

/**
 * The column is free text in the framework's schema, so the value is matched
 * case-insensitively against the three roles F6 defines and anything else is
 * treated as no membership at all. Failing closed matters: an unrecognised
 * role must never fall through to a default set of capabilities.
 */
function toRole(value: unknown, orgId: string): Role | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  const role = ROLES.find((candidate) => candidate === normalized);
  if (role === undefined) {
    logWarning({
      event: "unknown-member-role",
      message:
        "org_members.role is not one of owner, admin or member; the membership is ignored",
      orgId,
    });
    return null;
  }
  return role;
}

export function createMembershipReader(source: DbExecSource): MembershipReader {
  const getRole = async (
    orgId: string,
    userEmail: string,
  ): Promise<Role | null> => {
    const exec = await resolveExec(source);
    const { rows } = await exec.execute({
      sql: SELECT_MEMBER_ROLE,
      args: [orgId, userEmail],
    });
    const row = rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toRole(row["role"], orgId);
  };

  return {
    getRole,
    isMember: async (orgId: string, userEmail: string) =>
      (await getRole(orgId, userEmail)) !== null,
  };
}
