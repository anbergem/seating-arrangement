import { actionErrorMessage } from "@agent-native/core/client/hooks";

export type Translate = (
  key: string,
  params?: Record<string, unknown>,
) => string;

export function translatedActionError(error: unknown, t: Translate): string {
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  if (typeof code === "string") return t(`errors.${code}`);
  return actionErrorMessage(error) ?? t("errors.UNKNOWN");
}

export interface CommandResult<T> {
  resource: T;
  operationId: string;
}

export interface ActivityItem {
  id: string;
  action: string;
  kind: "forward" | "undo" | "redo";
  resourceType: "customer" | "job";
  resourceId: string;
  performedAt: string;
  performedBy: string;
  undoable: boolean;
  redoable: boolean;
}
