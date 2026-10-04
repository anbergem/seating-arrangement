import { useOrg } from "@agent-native/core/client/org";
import { RequireActiveOrg } from "@agent-native/toolkit/app/org";
import type { ReactNode } from "react";

/**
 * In an open application (D32), someone signed in without an organization gets the
 * framework's own screen for that: accept a pending invitation, or create an organization.
 *
 * The server says which kind of application this is — `access.orgCreation` on the
 * organization endpoint — so nothing about the mode is compiled into the browser bundle,
 * and one build behaves correctly wherever `MEMBERSHIP_MODE` differs. In an invite-only
 * application this renders its children untouched: the Team page already tells such a
 * person to ask for an invitation, and every other page answers 403 on its own.
 */
export function OrganizationGate({ children }: { children: ReactNode }) {
  const { data: org } = useOrg();
  if (org && !org.orgId && org.access?.orgCreation === "open") {
    return <RequireActiveOrg>{children}</RequireActiveOrg>;
  }
  return <>{children}</>;
}
