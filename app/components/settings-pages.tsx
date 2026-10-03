import { OrgAuthenticationPage } from "@agent-native/toolkit/app/org";
import {
  CORE_SETTINGS_PAGES,
  registerSettingsPages,
  type SettingsPageDefinition,
} from "@agent-native/toolkit/app/settings";

/**
 * Which of the framework's Settings pages this app shows.
 *
 * Since framework 0.197 `/settings` is the framework's own Settings, with a page for every
 * feature the framework has. Pages for features this app does not offer are hidden:
 * automations, channels, labs, integrations and skills are not part of it, and neither is
 * API keys, which holds keys for services this app does not call. The agent's own provider
 * key is saved on the Model page, which stays (D31). Hiding is presentation
 * only — every action behind a page still enforces its own permissions on the server.
 */
const HIDDEN_PAGE_IDS = new Set([
  "automations",
  "channels",
  "labs",
  "integrations",
  "api-keys",
  "sub-agents",
  "skills",
  "files",
  "personalization",
  "creative-context",
  "apps",
  "infra",
]);

/**
 * Organization › Authentication without the two sections this app cannot honour: email-domain
 * auto-join, which membership-by-invitation forbids and the server refuses
 * (`server/organization-request-policy.ts`), and the cross-app shared secret, for an A2A
 * surface this app does not have (D24). The `invite-only-team` rules in app/global.css hide
 * them; the sign-in policy, which "Require Google sign-in" lives in, stays.
 */
function InviteOnlyAuthenticationPage() {
  return (
    <div className="invite-only-team">
      <OrgAuthenticationPage />
    </div>
  );
}

registerSettingsPages(
  CORE_SETTINGS_PAGES.flatMap((page): SettingsPageDefinition[] => {
    if (HIDDEN_PAGE_IDS.has(page.id))
      return [{ ...page, visible: () => false }];
    if (page.id === "auth")
      return [{ ...page, component: InviteOnlyAuthenticationPage }];
    return [];
  }),
);
