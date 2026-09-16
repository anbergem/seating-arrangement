/**
 * The framework mounts its organization root as a prefix handler. Its final
 * POST branch creates an organization for both `/org` and unmatched tails, so
 * this policy has to run before that handler rather than only match the
 * documented root route.
 */
const ORG_PREFIX = "/_agent-native/org";

/**
 * POST routes the framework mounts under the organization prefix that are not
 * a way for a signed-in stranger to admit themselves. Tails are relative to the
 * mount point, so the policy holds under an `APP_BASE_PATH` deployment too.
 */
const ALLOWED_POST_TAILS = new Set([
  "/invitations",
  "/a2a-secret/sync",
  "/a2a-secret/receive",
]);

function isInvitationAcceptanceTail(tail: string): boolean {
  return /^\/invitations\/[^/]+\/accept$/.test(tail);
}

/**
 * The request path relative to the organization mount point.
 *
 * The framework's mount shim records the un-stripped path on
 * `event.context._mountedPathname` and rewrites `event.url.pathname` to the
 * tail. Either may be what this handler sees — the shim skips the rewrite on
 * runtimes where `event.url` is read-only — so accept both and normalise to a
 * tail. Anything that does not contain the prefix is already a tail; that
 * keeps an unrecognised shape denied rather than silently allowed.
 */
export function organizationRequestTail(
  mountedPathname: string | undefined,
  eventPathname: string,
): string {
  const source = mountedPathname ?? eventPathname;
  const index = source.indexOf(ORG_PREFIX);
  const tail = index === -1 ? source : source.slice(index + ORG_PREFIX.length);
  return tail.replace(/\/+$/, "");
}

/**
 * Only invitations can add a signed-in person to this application's company.
 * The explicit allow-list retains the framework's legitimate POST routes while
 * denying both its documented self-create endpoint and its prefix fallback.
 *
 * `PUT /domain` is denied too. It writes `organizations.allowed_domain`, and a
 * non-empty value makes the framework's Better Auth `user.create.after` hook
 * admit every new signup at that domain — self-admission through a route this
 * policy never sees. Refusing the write is what keeps the invite-only claim
 * true rather than conventional; clearing a domain that somehow got set is an
 * operator task against the database, not a Team page action.
 */
export function blocksOrganizationSelfAdmission(
  method: string,
  tail: string,
): boolean {
  if (method === "PUT") return tail === "/domain";
  if (method !== "POST") return false;
  return !(ALLOWED_POST_TAILS.has(tail) || isInvitationAcceptanceTail(tail));
}
