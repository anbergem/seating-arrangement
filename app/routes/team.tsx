import { useT } from "@agent-native/core/client/i18n";

import { InviteOnlyTeamPage } from "@/components/InviteOnlyTeamPage";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `Team — ${APP_TITLE}` }];
}

/**
 * The team, and — for someone signed in without an organization — the invitations waiting
 * for them. This used to redirect to the Organization tab of the app's own settings page;
 * since framework 0.197 `/settings` is the framework's Settings, which has no such page and
 * sends an unknown one to Profile. That left nowhere to accept an invitation, which in an
 * invite-only app is the only way in. So the page is rendered here.
 */
export default function TeamRoute() {
  const t = useT();
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">{t("pages.teamTitle")}</h1>
      <InviteOnlyTeamPage />
    </div>
  );
}
