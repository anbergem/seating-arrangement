/**
 * `list-recent-activity` (blueprint B8, B9).
 *
 * The history feed, newest first, with the two flags a caller needs to decide
 * whether to offer an Undo or a Redo button. Both flags are computed against
 * the resource's *current* version, which is the whole reason they cannot be
 * stored on the operation row: an operation stops being undoable the moment
 * someone else changes the same record, and nothing rewrites the old row when
 * that happens.
 *
 * Each distinct resource is loaded once, not once per operation: a busy job
 * accumulates many operations and they all resolve to the same version.
 *
 * The flags are an affordance, not the authority. `undo-operation` and
 * `redo-operation` (T10) re-check everything themselves, so a flag that has
 * gone stale between this read and the click costs a CONFLICT, not a wrong
 * write.
 */

import type { Operation, ResourceType } from "../../domain";
import { canUndo } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import { mayUndo, mayRedo, reopensCompletedJob } from "../history-policy";
import type { Dependencies } from "../ports";
import { isCreateOperation } from "./command";

export const DEFAULT_ACTIVITY_LIMIT = 20;
export const MAX_ACTIVITY_LIMIT = 100;

export interface ListRecentActivityInput {
  /** Defaults to 20, clamped to 100. */
  limit?: number;
  /** Give both `resourceType` and `resourceId`, or neither. */
  resourceType?: ResourceType;
  resourceId?: string;
}

export interface ActivityEntry extends Operation {
  /** `canUndo` says yes against the resource's current version (B9). */
  undoable: boolean;
  /** This is an undo that has not itself been reverted, still describes the
   * resource's current version, and reversed something other than a create, so
   * `redo-operation` can re-apply the forward command (B9). */
  redoable: boolean;
}

/** Key for the "load each resource once" map. Resource ids are unique per
 * table, not across tables, so the type belongs in the key. */
function resourceKey(type: ResourceType, id: string): string {
  return `${type}:${id}`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_ACTIVITY_LIMIT);
}

export async function listRecentActivity(
  deps: Dependencies,
  actor: Actor,
  input: ListRecentActivityInput = {},
): Promise<ActivityEntry[]> {
  requireCapability(actor, "history:read");

  // The port offers "recent for the organization" and "recent for one
  // resource"; there is no "recent for every job", and filtering a page of
  // rows after the fact would silently return fewer than `limit`.
  if ((input.resourceType === undefined) !== (input.resourceId === undefined)) {
    throw new AppError(
      "VALIDATION",
      "Give both resourceType and resourceId, or neither",
    );
  }

  const limit = clampLimit(input.limit);
  const operations =
    input.resourceType !== undefined && input.resourceId !== undefined
      ? await deps.operations.listForResource(
          actor.orgId,
          input.resourceType,
          input.resourceId,
          limit,
        )
      : await deps.operations.listRecent(actor.orgId, limit);

  const distinct = new Map<string, { type: ResourceType; id: string }>();
  for (const op of operations) {
    distinct.set(resourceKey(op.resourceType, op.resourceId), {
      type: op.resourceType,
      id: op.resourceId,
    });
  }

  /** Resource key → current version, or `null` when the row is gone. */
  const versions = new Map<string, number | null>(
    await Promise.all(
      Array.from(distinct, async ([key, resource]) => {
        const found =
          resource.type === "customer"
            ? await deps.customers.getById(actor.orgId, resource.id)
            : await deps.jobs.getById(actor.orgId, resource.id);
        return [key, found?.version ?? null] as const;
      }),
    ),
  );

  /**
   * The forward operation each still-open undo reversed, by its own id — B9's
   * third redo rule: a create's undo is a compensation and `redo-operation`
   * refuses it, so it must not be offered.
   *
   * Only the undos that already pass the first two rules are looked up, and
   * each distinct id once, so the common page (all forward operations) costs no
   * extra read at all.
   */
  const forwardIds = new Set<string>();
  for (const op of operations) {
    if (
      op.kind === "undo" &&
      op.undoneByOperationId === null &&
      op.relatedOperationId !== null &&
      op.versionAfter ===
        versions.get(resourceKey(op.resourceType, op.resourceId))
    ) {
      forwardIds.add(op.relatedOperationId);
    }
  }
  const forwards = new Map<string, Operation | null>(
    await Promise.all(
      Array.from(forwardIds, async (id) => {
        return [id, await deps.operations.getById(actor.orgId, id)] as const;
      }),
    ),
  );

  const reopeningIds = new Set(
    operations.filter(reopensCompletedJob).map((op) => op.resourceId),
  );
  const exportLocked = new Set(
    (
      await Promise.all(
        Array.from(reopeningIds, async (id) =>
          (await deps.accountingExports.getByJobId(actor.orgId, id))
            ? id
            : null,
        ),
      )
    ).filter((id): id is string => id !== null),
  );

  return operations.map((op) => {
    const version =
      versions.get(resourceKey(op.resourceType, op.resourceId)) ?? null;
    const forward =
      op.relatedOperationId !== null
        ? (forwards.get(op.relatedOperationId) ?? null)
        : null;
    return {
      ...op,
      undoable:
        version !== null &&
        canUndo(op, version).ok &&
        mayUndo(actor, op) &&
        !(reopensCompletedJob(op) && exportLocked.has(op.resourceId)),
      redoable:
        version !== null &&
        op.kind === "undo" &&
        op.undoneByOperationId === null &&
        op.versionAfter === version &&
        forward !== null &&
        !isCreateOperation(forward) &&
        mayRedo(actor, forward),
    };
  });
}
