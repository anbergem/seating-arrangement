/**
 * `OperationRepository` against D1 / SQLite (blueprint B7, B9, B11).
 *
 * Read-only: operation rows are written by `customers-repository.ts` and
 * `jobs-repository.ts`, inside the same atomic batch as the change they
 * describe, and marked undone by the batch that reverses them. There is no
 * write method here on purpose — an audit row that could be written on its own
 * could disagree with the resource it claims to describe.
 */

import type { OperationRepository } from "../../application/ports";
import type { ResourceType } from "../../domain";
import type { DbExecSource } from "./atomic";
import { resolveExec } from "./atomic";
import { mapRows, toOperation } from "./mappers";
import {
  SELECT_CREATE_OPERATION,
  SELECT_OPERATION_BY_ID,
  SELECT_OPERATIONS_FOR_RESOURCE,
  SELECT_RECENT_OPERATIONS,
} from "./sql";

export function createOperationsRepository(
  source: DbExecSource,
): OperationRepository {
  return {
    getById: async (orgId: string, id: string) => {
      const exec = await resolveExec(source);
      const { rows } = await exec.execute({
        sql: SELECT_OPERATION_BY_ID,
        args: [orgId, id],
      });
      const [operation] = mapRows(rows, toOperation);
      return operation ?? null;
    },

    listRecent: async (orgId: string, limit: number) => {
      const exec = await resolveExec(source);
      const { rows } = await exec.execute({
        sql: SELECT_RECENT_OPERATIONS,
        args: [orgId, limit],
      });
      return mapRows(rows, toOperation);
    },

    listForResource: async (
      orgId: string,
      type: ResourceType,
      id: string,
      limit: number,
    ) => {
      const exec = await resolveExec(source);
      const { rows } = await exec.execute({
        sql: SELECT_OPERATIONS_FOR_RESOURCE,
        args: [orgId, type, id, limit],
      });
      return mapRows(rows, toOperation);
    },

    findCreateOperation: async (
      orgId: string,
      type: ResourceType,
      id: string,
    ) => {
      const exec = await resolveExec(source);
      const { rows } = await exec.execute({
        sql: SELECT_CREATE_OPERATION,
        args: [orgId, type, id],
      });
      const [operation] = mapRows(rows, toOperation);
      return operation ?? null;
    },
  };
}
