/**
 * `IdempotencyStore` against D1 / SQLite (blueprint B7, decision D14).
 *
 * Read-only, like the operations repository: a key is written by the same
 * atomic batch that creates the resource it points at, so it can never name a
 * resource that does not exist. This side only answers "has this
 * `(action, key)` already produced something in this organization?".
 */

import type { IdempotencyStore } from "../../application/ports";
import type { DbExecSource } from "./atomic";
import { resolveExec } from "./atomic";
import { SELECT_IDEMPOTENCY_KEY } from "./sql";

export function createIdempotencyStore(source: DbExecSource): IdempotencyStore {
  return {
    find: async (orgId: string, action: string, key: string) => {
      const exec = await resolveExec(source);
      const { rows } = await exec.execute({
        sql: SELECT_IDEMPOTENCY_KEY,
        args: [orgId, action, key],
      });
      const row = rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      const resourceId = row["resource_id"];
      return typeof resourceId === "string" ? resourceId : null;
    },
  };
}
