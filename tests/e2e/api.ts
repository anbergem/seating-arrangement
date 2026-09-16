import { expect, type APIRequestContext } from "@playwright/test";

/** The framework audit row (F11) as the `list-audit-events` action returns it. */
export interface AuditEvent {
  id: string;
  createdAt: number;
  action: string;
  caller: string;
  actorKind: string;
  actorEmail: string | null;
  orgId: string | null;
  targetType: string | null;
  targetId: string | null;
  status: string;
  summary: string | null;
}

/** An `operations` row as `list-recent-activity` returns it (B7). */
export interface ActivityItem {
  id: string;
  action: string;
  kind: "forward" | "undo" | "redo";
  resourceType: string;
  resourceId: string;
  undoable: boolean;
  redoable: boolean;
}

/** The framework's own audit trail for one job, newest first. */
export async function auditEventsForJob(
  request: APIRequestContext,
  jobId: string,
): Promise<AuditEvent[]> {
  const response = await request.get(
    `/_agent-native/actions/list-audit-events?targetType=job&targetId=${jobId}`,
  );
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { events?: AuditEvent[] };
  return body.events ?? [];
}

/** The app's own undo ledger, newest first. */
export async function recentActivity(
  request: APIRequestContext,
  limit = 20,
): Promise<ActivityItem[]> {
  const response = await request.get(
    `/_agent-native/actions/list-recent-activity?limit=${limit}`,
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as ActivityItem[];
}

/** The fields that must be identical whichever surface called the action; the
 * caller and the row's own identity are the only permitted differences (B18). */
export function auditShape(event: AuditEvent): Record<string, unknown> {
  return {
    action: event.action,
    actorKind: event.actorKind,
    actorEmail: event.actorEmail,
    orgId: event.orgId,
    targetType: event.targetType,
    targetId: event.targetId,
    status: event.status,
    summary: event.summary,
  };
}
