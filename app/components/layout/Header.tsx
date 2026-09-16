import { AgentToggleButton } from "@agent-native/core/client/agent-chat";
import { useSession } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { OrgSwitcher } from "@agent-native/core/client/org";
import {
  useHeaderTitle,
  useHeaderActions,
} from "@agent-native/toolkit/app-shell";
import { IconMenu2 } from "@tabler/icons-react";
import { useLocation } from "react-router";

import { APP_TITLE } from "@/lib/app-config";

const pageTitleKeys: Record<string, string> = {
  "/activity": "navigation.activity",
  "/customers": "navigation.customers",
  "/home": "navigation.chat",
  "/jobs": "navigation.jobs",
  "/observability": "navigation.observability",
  "/agent": "settings.agentTitle",
  "/settings": "navigation.settings",
};

function resolveTitle(pathname: string, t: (key: string) => string): string {
  if (pageTitleKeys[pathname]) return t(pageTitleKeys[pathname]);
  if (pathname.startsWith("/jobs/")) return t("navigation.jobs");
  if (pathname.startsWith("/customers/")) return t("navigation.customers");
  return APP_TITLE;
}

interface HeaderProps {
  onOpenMobileSidebar?: () => void;
}

export function Header({ onOpenMobileSidebar }: HeaderProps) {
  const location = useLocation();
  const t = useT();
  const title = useHeaderTitle();
  const actions = useHeaderActions();
  const { session } = useSession();

  return (
    <header className="flex h-12 items-center gap-3 border-b border-border bg-background px-4 lg:px-6 shrink-0">
      {onOpenMobileSidebar && (
        <button
          type="button"
          onClick={onOpenMobileSidebar}
          aria-label={t("navigation.openNavigation")}
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent md:hidden"
        >
          <IconMenu2 className="h-4 w-4" />
        </button>
      )}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {title ?? (
          <h1 className="text-lg font-semibold tracking-tight truncate">
            {resolveTitle(location.pathname, t)}
          </h1>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {session?.email}
        </span>
        {/* Not `compact`/`hideWhenSingle`: the active organization name has to be
            visible chrome, because every action is scoped to it (B17, T16). */}
        <OrgSwitcher />
        {actions}
        <AgentToggleButton />
      </div>
    </header>
  );
}
