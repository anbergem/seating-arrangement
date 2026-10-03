/**
 * `EventRepository` against PostgreSQL / SQLite (blueprint B7, B11).
 *
 * Reads are filtered by `orgId`, so an event from another organization reads as
 * absent rather than as forbidden, and `commit` refuses a stale version with
 * CONFLICT. Nothing here knows which database it is talking to: `runAtomic`
 * picks `atomicBatch` or `transaction`, and the preconditions travel inside the
 * SQL (D07) rather than in application code between two statements.
 */

import { AppError } from "../../application/errors";
import type { EventRepository } from "../../application/ports";
import type { EventStatus } from "../../domain";
import type { DbExecSource, Statement } from "./atomic";
import { resolveExec, runAtomic } from "./atomic";
import {
  idempotencyKeyStatement,
  operationForCreateStatement,
} from "./create-statements";
import {
  eventInsertArgs,
  eventUpdateArgs,
  mapRows,
  operationInsertArgs,
  toEvent,
} from "./mappers";
import {
  INSERT_EVENT,
  INSERT_OPERATION_IF_EVENT_VERSION,
  MARK_OPERATION_UNDONE,
  SELECT_EVENT_BY_ID,
  SELECT_EVENTS,
  SELECT_EVENTS_PARTS,
  UPDATE_EVENT_VERSIONED,
} from "./sql";

const CONFLICT_MESSAGE = "The record was changed by someone else";

export function createEventsRepository(source: DbExecSource): EventRepository {
  return {
    getById: async (orgId: string, id: string) => {
      const exec = await resolveExec(source);
      const { rows } = await exec.execute({
        sql: SELECT_EVENT_BY_ID,
        args: [orgId, id],
      });
      const [event] = mapRows(rows, toEvent);
      return event ?? null;
    },

    list: async (orgId: string, filter: { status?: EventStatus }) => {
      let sql = SELECT_EVENTS;
      const args: unknown[] = [orgId];
      if (filter.status !== undefined) {
        sql += SELECT_EVENTS_PARTS.status;
        args.push(filter.status);
      }
      sql += SELECT_EVENTS_PARTS.order;
      const exec = await resolveExec(source);
      const { rows } = await exec.execute({ sql, args });
      return mapRows(rows, toEvent);
    },

    create: async ({ event, operation, idempotency }) => {
      const statements: Statement[] = [
        {
          sql: INSERT_EVENT,
          args: [...eventInsertArgs(event), event.orgId, event.id],
        },
        operationForCreateStatement(operation),
      ];
      if (idempotency) {
        statements.push(
          idempotencyKeyStatement(operation, idempotency, event.createdAt),
        );
      }
      await runAtomic(await resolveExec(source), statements);
    },

    commit: async ({ event, expectedVersion, operation, markUndone }) => {
      // The audit row goes first, guarded on the version the caller read; the
      // update carries the same predicate. Both statements see the same
      // pre-image inside one transaction, so either both apply or neither does.
      const statements: Statement[] = [
        {
          sql: INSERT_OPERATION_IF_EVENT_VERSION,
          args: [
            ...operationInsertArgs(operation),
            event.orgId,
            event.id,
            expectedVersion,
          ],
        },
        {
          sql: UPDATE_EVENT_VERSIONED,
          args: [
            ...eventUpdateArgs(event),
            event.orgId,
            event.id,
            expectedVersion,
          ],
        },
      ];
      if (markUndone) {
        statements.push({
          sql: MARK_OPERATION_UNDONE,
          args: [
            operation.id,
            event.orgId,
            markUndone,
            event.orgId,
            operation.id,
          ],
        });
      }
      const affected = await runAtomic(await resolveExec(source), statements);
      if (affected[0] !== 1 || affected[1] !== 1) {
        throw new AppError("CONFLICT", CONFLICT_MESSAGE);
      }
    },
  };
}
