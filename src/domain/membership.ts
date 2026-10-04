/**
 * Who may become a member of this application, and how (decision D32).
 *
 * - `invite-only`: one company's application. Organizations are created by an operator
 *   (`scripts/bootstrap-org.mjs`) and the only way in is an invitation.
 * - `open`: anyone who can sign in may create an organization of their own and invite
 *   others into it. Organizations stay isolated from each other exactly as before — every
 *   statement is scoped to the caller's organization in either mode.
 *
 * Email-domain auto-join is refused in both modes: in an open application it would let one
 * organization absorb every new sign-up at a shared domain.
 */
export type MembershipMode = "invite-only" | "open";

/** The mode this application ships with. Change this line to change the application. */
export const APP_MEMBERSHIP_MODE: MembershipMode = "invite-only";

/**
 * How many organizations one person may own in an open application. A bound, not a
 * product decision: it keeps one account from filling the database with organizations.
 */
export const MAX_OWNED_ORGANIZATIONS = 3;

/** `undefined` for an unset value; throws nothing — the caller decides what unknown means. */
export function parseMembershipMode(
  raw: string | undefined,
): MembershipMode | undefined {
  return raw === "invite-only" || raw === "open" ? raw : undefined;
}

/** The other mode, for a test run that exercises the one the application does not ship. */
export function otherMembershipMode(mode: MembershipMode): MembershipMode {
  return mode === "open" ? "invite-only" : "open";
}
