import { appApiPath } from "@agent-native/core/client/api-path";
import { useT } from "@agent-native/core/client/i18n";
import { useQuery } from "@tanstack/react-query";

import { cn } from "@/lib/utils";

/** The environment classes that carry a label. Production is absent on purpose. */
type LabelledEnvironment = "local" | "ci" | "staging";

function isLabelled(value: unknown): value is LabelledEnvironment {
  return value === "local" || value === "ci" || value === "staging";
}

// Colours outside the design tokens on purpose: the strip's whole job is to look
// unlike the app, and unlike the other environments.
const STYLES: Record<LabelledEnvironment, string> = {
  local: "bg-sky-600 text-white",
  ci: "bg-violet-600 text-white",
  staging: "bg-amber-400 text-amber-950",
};

/**
 * A strip across the top of every signed-in page naming the environment, in
 * every environment but production.
 *
 * The class is asked of the server (`/api/environment`) rather than compiled in,
 * because the same build is promoted from staging to production. Anything but a
 * labelled class — production, an error, a signed-out response — renders nothing,
 * so a failure can only ever hide the strip, never put one on production.
 */
export function EnvironmentBanner() {
  const t = useT();
  const { data: environment } = useQuery({
    queryKey: ["app-environment"],
    queryFn: async (): Promise<LabelledEnvironment | null> => {
      const response = await fetch(appApiPath("/environment"));
      if (!response.ok) return null;
      const body: unknown = await response.json();
      const value = (body as { environment?: unknown } | null)?.environment;
      return isLabelled(value) ? value : null;
    },
    // Fixed for the life of the process that answered it.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  if (!environment) return null;

  const label =
    environment === "staging"
      ? t("environment.staging")
      : environment === "ci"
        ? t("environment.ci")
        : t("environment.development");

  return (
    <div
      role="note"
      data-testid="environment-banner"
      data-environment={environment}
      className={cn(
        "flex h-6 shrink-0 items-center justify-center px-3 text-xs font-semibold tracking-wide",
        STYLES[environment],
      )}
    >
      {label}
    </div>
  );
}
