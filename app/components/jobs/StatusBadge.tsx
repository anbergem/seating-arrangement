import { useT } from "@agent-native/core/client/i18n";

import type { JobStatus } from "./types";

export function StatusBadge({
  status,
  testId,
}: {
  status: JobStatus | "active";
  testId?: string;
}) {
  const t = useT();
  return (
    <span
      className="inline-flex rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
      data-testid={testId}
    >
      {t(`status.${status}`)}
    </span>
  );
}
