import { getDbExec } from "@agent-native/core/db";
import {
  defineNitroPlugin,
  getH3App,
  getSession,
} from "@agent-native/core/server";
import { createError, defineEventHandler, getMethod } from "h3";

import { MAX_OWNED_ORGANIZATIONS } from "../../src/domain/membership";
import { readMembershipMode } from "../../src/infrastructure/env";
import {
  blocksOrganizationSelfAdmission,
  isOrganizationCreation,
  organizationRequestTail,
} from "../organization-request-policy";

/** How many organizations this person owns. Framework table, so no `org_id` scope applies. */
async function ownedOrganizationCount(email: string): Promise<number> {
  const { rows } = await getDbExec().execute({
    sql: `SELECT COUNT(*) AS "owned" FROM org_members WHERE LOWER(email) = ? AND role = 'owner'`,
    args: [email.trim().toLowerCase()],
  });
  const row = rows[0] as { owned?: unknown } | undefined;
  return Number(row?.owned ?? 0);
}

export default defineNitroPlugin((nitroApp) => {
  const mode = readMembershipMode();
  getH3App(nitroApp).use(
    "/_agent-native/org",
    defineEventHandler(async (event) => {
      // Anonymous callers continue to the framework auth handler and receive its
      // normal 401 response. This plugin precedes the org prefix fallback.
      const session = await getSession(event);
      if (!session) return;
      const mounted: unknown = event.context._mountedPathname;
      const tail = organizationRequestTail(
        typeof mounted === "string" ? mounted : undefined,
        event.url?.pathname ?? "",
      );
      const method = getMethod(event);
      if (blocksOrganizationSelfAdmission(method, tail, mode)) {
        throw createError({
          statusCode: 403,
          statusMessage:
            mode === "open"
              ? "This organization route is not available"
              : "Organization membership requires an invitation",
        });
      }
      // Open membership (D32): creating is allowed, without limit it would not be safe.
      if (mode === "open" && isOrganizationCreation(method, tail)) {
        const email = typeof session.email === "string" ? session.email : "";
        if (
          !email ||
          (await ownedOrganizationCount(email)) >= MAX_OWNED_ORGANIZATIONS
        ) {
          throw createError({
            statusCode: 403,
            statusMessage: `You can own at most ${MAX_OWNED_ORGANIZATIONS} organizations`,
          });
        }
      }
    }),
  );
});
