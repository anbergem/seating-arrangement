/**
 * `SeatingTableRepository` against D1 / SQLite (blueprint B7, B11).
 *
 * The same shape as `events-repository.ts`, with the floor plan's own rule on
 * top: two tables of the same event may not stand on the same cell.
 *
 * That rule is not a check before the write, and it is not a predicate inside
 * it either. It is the primary key of `seating_cells`, `(org_id, event_id, x,
 * y)`. Every write that changes what a table covers clears that table's cells
 * and writes them again in the same atomic batch as the table row, and a cell
 * another table already holds violates the key and takes the whole batch down
 * with it.
 *
 * It has to be a constraint rather than a guard because the two writers are
 * touching *different rows*. A version guard asks "has this record changed",
 * and the honest answer for both of them is no — each has moved its own table
 * and neither has touched the other's. Only something that knows about the
 * cells themselves can see the collision, and in a database that is a unique
 * index.
 *
 * Three consequences worth stating, because they are the reasons this file
 * looks the way it does:
 *
 *   * **Every statement in a batch carries the same version guard**, the cell
 *     delete and inserts included. Otherwise a stale writer whose table update
 *     matched zero rows would still have rewritten its cells — a partial write,
 *     which is worse than a refused one.
 *   * **The cell statements come before the update**, because they are guarded
 *     on the version the caller read, and the update is what bumps it.
 *   * **A cell collision arrives as a thrown constraint error, not as zero rows
 *     affected**, so it is recognised by message the way a duplicate
 *     idempotency key already is (`isIdempotencyKeyViolation` in
 *     `src/application/use-cases/command.ts` documents the same trade-off).
 *     Being broad is safe: a false positive turns one failed write into a
 *     `CONFLICT`, which is what the caller should do about a failed write
 *     anyway.
 */

import { AppError } from "../../application/errors";
import type { SeatingTableRepository } from "../../application/ports";
import type { Cell, SeatingTable, SeatingTableStatus } from "../../domain";
import { cellsOf } from "../../domain";
import type { DbExecSource, Statement } from "./atomic";
import { resolveExec, runAtomic } from "./atomic";
import {
  idempotencyKeyStatement,
  operationForCreateStatement,
} from "./create-statements";
import { eventUpdateArgs } from "./mappers";
import {
  mapRows,
  operationInsertArgs,
  seatingTableInsertArgs,
  toSeatingTable,
} from "./mappers";
import {
  DELETE_SEATING_CELLS_IF_OPERATION,
  DELETE_SEATING_CELLS_IF_VERSION,
  INSERT_OPERATION_IF_BOTH_SEATING_TABLE_VERSIONS,
  INSERT_OPERATION_IF_EVENT_VERSION,
  INSERT_OPERATION_IF_SEATING_TABLE_VERSION,
  INSERT_SEATING_CELL_IF_OPERATION,
  INSERT_SEATING_CELL_IF_TABLE_EXISTS,
  INSERT_SEATING_CELL_IF_VERSION,
  INSERT_SEATING_TABLE_IF_ACTIVE_EVENT,
  MARK_OPERATION_UNDONE,
  SELECT_SEATING_TABLE_BY_ID,
  SELECT_SEATING_TABLES,
  SELECT_SEATING_TABLES_PARTS,
  UPDATE_EVENT_VERSIONED,
  UPDATE_SEATING_TABLE_IF_OPERATION,
  UPDATE_SEATING_TABLE_VERSIONED,
} from "./sql";

const CONFLICT_MESSAGE = "The record was changed by someone else";
const OCCUPIED_MESSAGE = "That space is already occupied";
const EVENT_MISSING_MESSAGE = "Event not found or archived";

/**
 * Whether a failed write looks like two tables reaching for the same cell.
 *
 * `@libsql/client` reports it as `SQLITE_CONSTRAINT_PRIMARYKEY: UNIQUE
 * constraint failed: seating_cells.org_id, seating_cells.event_id, …`; D1
 * words it differently, so the table name is what is matched rather than any
 * one driver's phrasing.
 */
function isCellCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("seating_cells") &&
    (message.includes("UNIQUE") ||
      message.includes("PRIMARY KEY") ||
      message.includes("constraint"))
  );
}

/** One insert per cell the table holds. `guard` is appended to each, so they
 * stand or fall with the rest of the batch. */
function cellInserts(
  table: SeatingTable,
  cells: readonly Cell[],
  insertSql: string,
  guard: readonly unknown[],
): Statement[] {
  return cells.map((cell) => ({
    sql: insertSql,
    args: [table.orgId, table.eventId, cell.x, cell.y, table.id, ...guard],
  }));
}

export function createSeatingTablesRepository(
  source: DbExecSource,
): SeatingTableRepository {
  return {
    getById: async (orgId: string, id: string) => {
      const exec = await resolveExec(source);
      const { rows } = await exec.execute({
        sql: SELECT_SEATING_TABLE_BY_ID,
        args: [orgId, id],
      });
      const [table] = mapRows(rows, toSeatingTable);
      return table ?? null;
    },

    list: async (
      orgId: string,
      filter: { eventId?: string; status?: SeatingTableStatus },
    ) => {
      let sql = SELECT_SEATING_TABLES;
      const args: unknown[] = [orgId];
      if (filter.eventId !== undefined) {
        sql += SELECT_SEATING_TABLES_PARTS.eventId;
        args.push(filter.eventId);
      }
      if (filter.status !== undefined) {
        sql += SELECT_SEATING_TABLES_PARTS.status;
        args.push(filter.status);
      }
      sql += SELECT_SEATING_TABLES_PARTS.order;
      const exec = await resolveExec(source);
      const { rows } = await exec.execute({ sql, args });
      return mapRows(rows, toSeatingTable);
    },

    create: async ({ table, operation, idempotency }) => {
      // The cells are guarded on the table row existing rather than on a
      // version, because there is no previous version to guard on.
      // No cell delete: a table that is being created holds nothing yet.
      const statements: Statement[] = [
        {
          sql: INSERT_SEATING_TABLE_IF_ACTIVE_EVENT,
          args: [...seatingTableInsertArgs(table), table.orgId, table.eventId],
        },
        operationForCreateStatement(operation),
        ...cellInserts(
          table,
          cellsOf(table),
          INSERT_SEATING_CELL_IF_TABLE_EXISTS,
          [table.orgId, table.id],
        ),
      ];
      if (idempotency) {
        statements.push(
          idempotencyKeyStatement(operation, idempotency, table.createdAt),
        );
      }
      const exec = await resolveExec(source);
      let affected: number[];
      try {
        affected = await runAtomic(exec, statements);
      } catch (error) {
        if (isCellCollision(error)) {
          throw new AppError("CONFLICT", OCCUPIED_MESSAGE);
        }
        throw error;
      }
      // Only one guard can have refused this batch: the event was missing or
      // archived. A taken cell would have thrown above.
      if (affected[0] !== 1) {
        throw new AppError("NOT_FOUND", EVENT_MISSING_MESSAGE);
      }
    },

    /**
     * A whole venue layout in one write: every table, every table's cells, and
     * the event whose room may have had to grow to hold them.
     *
     * This is the one method that touches the events table, and it does so
     * deliberately. A layout and the floor it needs are a single fact — half a
     * bootstrap is a floor plan nobody asked for — and D1 has no interactive
     * transaction to assemble one out of two repository calls. So the event's
     * version guard and the table inserts go into the same atomic batch.
     *
     * Everything hangs off the event's `expectedVersion`: the audit row, which
     * goes first, and the event update, which goes last because it is what
     * moves the version on. A concurrent change to the event — another
     * bootstrap, an archive — takes the whole batch down.
     */
    createLayout: async ({ event, expectedVersion, tables, operation }) => {
      const guard = [event.orgId, event.id, expectedVersion];
      const statements: Statement[] = [
        {
          sql: INSERT_OPERATION_IF_EVENT_VERSION,
          args: [...operationInsertArgs(operation), ...guard],
        },
        ...tables.map((table) => ({
          sql: INSERT_SEATING_TABLE_IF_ACTIVE_EVENT,
          args: [...seatingTableInsertArgs(table), table.orgId, table.eventId],
        })),
        ...tables.flatMap((table) =>
          cellInserts(
            table,
            cellsOf(table),
            INSERT_SEATING_CELL_IF_TABLE_EXISTS,
            [table.orgId, table.id],
          ),
        ),
        {
          sql: UPDATE_EVENT_VERSIONED,
          args: [...eventUpdateArgs(event), ...guard],
        },
      ];
      let affected: number[];
      try {
        affected = await runAtomic(await resolveExec(source), statements);
      } catch (error) {
        if (isCellCollision(error)) {
          throw new AppError("CONFLICT", OCCUPIED_MESSAGE);
        }
        throw error;
      }
      // The audit row and the event update bracket the batch and both carry the
      // version guard, so either tells us the event moved on under us. Between
      // them, a table insert that matched nothing means the event was archived
      // in the same window.
      if (affected[0] !== 1 || affected[affected.length - 1] !== 1) {
        throw new AppError("CONFLICT", CONFLICT_MESSAGE);
      }
      if (tables.some((_, index) => affected[1 + index] !== 1)) {
        throw new AppError("NOT_FOUND", EVENT_MISSING_MESSAGE);
      }
    },

    /**
     * The other half of `createLayout`: takes a whole layout back off the plan
     * and puts the room back as it was, under one audit row.
     *
     * Each table carries its own version guard, because the tables have been on
     * the floor and may have been moved or renamed since. The event's guard is
     * what the audit row and the room update hang off, matching the forward
     * operation, whose subject was also the event.
     *
     * Archiving frees a table's cells, so the delete has no matching insert —
     * that is how the floor becomes free again.
     */
    archiveLayout: async ({
      event,
      expectedVersion,
      tables,
      operation,
      markUndone,
    }) => {
      const eventGuard = [event.orgId, event.id, expectedVersion];
      const statements: Statement[] = [
        {
          sql: INSERT_OPERATION_IF_EVENT_VERSION,
          args: [...operationInsertArgs(operation), ...eventGuard],
        },
        ...tables.flatMap(({ table, expectedVersion: was }) => {
          const guard = [table.orgId, table.id, was];
          return [
            {
              sql: DELETE_SEATING_CELLS_IF_VERSION,
              args: [table.orgId, table.id, ...guard],
            },
            {
              sql: UPDATE_SEATING_TABLE_VERSIONED,
              args: [
                table.name,
                table.kind,
                table.size,
                table.endSeats ? 1 : 0,
                table.rotation,
                table.gridX,
                table.gridY,
                JSON.stringify(table.seats),
                table.status,
                table.version,
                table.updatedAt,
                ...guard,
              ],
            },
          ];
        }),
        {
          sql: UPDATE_EVENT_VERSIONED,
          args: [...eventUpdateArgs(event), ...eventGuard],
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
      // The audit row is first and the room update is the last of the statements
      // that matter; each table's own update is every second statement in
      // between, after its cell delete.
      const updates = tables.map((_, index) => affected[2 + index * 2]);
      const roomUpdate = affected[1 + tables.length * 2];
      if (
        affected[0] !== 1 ||
        roomUpdate !== 1 ||
        updates.some((rows) => rows !== 1)
      ) {
        throw new AppError("CONFLICT", CONFLICT_MESSAGE);
      }
    },

    /**
     * Both halves of a seat move, in one batch: two table rows, two cell sets,
     * one audit row.
     *
     * Two ordering rules, and each is load-bearing:
     *
     *   * **The audit row comes first**, and it is the only statement that
     *     checks a version — both of them. Everything after it asks merely
     *     whether that row landed, which is what makes two version guards
     *     into one all-or-nothing batch. `sql.ts` has the longer argument.
     *   * **Both deletes come before either insert**, because a move can be
     *     one table *handing a cell to the other*. Two tables pushed together
     *     share the cells where they meet, and a name crossing that seam
     *     leaves a cell on one table and claims the same cell on the other.
     *     `seating_cells` is keyed on the cell, so the arriving insert
     *     violates the primary key unless the leaving delete has already run.
     *     Interleaving the statements per table would turn a legal move into
     *     "That space is already occupied".
     *
     * For a swap the delete and re-insert are a no-op net: both seats are
     * filled before and after, so the ledger is rewritten to itself. The
     * alternative — working out per seat what actually changed — would put
     * occupancy arithmetic back into this file, which is exactly what "every
     * commit restates occupancy" exists to avoid.
     */
    commitSeatMove: async ({ tables, operation, markUndone }) => {
      const [a, b] = tables;
      const resource = tables.find(
        (entry) => entry.table.id === operation.resourceId,
      );
      if (!resource) {
        // The caller built the operation row; naming a third table in it is a
        // programming error, not a race.
        throw new AppError("INTERNAL", "Unexpected error");
      }
      // The interlock every statement below hangs off: written only if both
      // tables are still at the versions the caller read.
      const written = [operation.orgId, operation.id];
      // Both tables are active — the domain refuses a move touching an
      // archived one — so each rewrites its cells unconditionally.
      const cellsA = cellsOf(a.table);
      const cellsB = cellsOf(b.table);
      const statements: Statement[] = [
        {
          sql: INSERT_OPERATION_IF_BOTH_SEATING_TABLE_VERSIONS,
          args: [
            ...operationInsertArgs(operation),
            a.table.orgId,
            a.table.id,
            a.expectedVersion,
            b.table.orgId,
            b.table.id,
            b.expectedVersion,
          ],
        },
        {
          sql: DELETE_SEATING_CELLS_IF_OPERATION,
          args: [a.table.orgId, a.table.id, ...written],
        },
        {
          sql: DELETE_SEATING_CELLS_IF_OPERATION,
          args: [b.table.orgId, b.table.id, ...written],
        },
        ...cellInserts(
          a.table,
          cellsA,
          INSERT_SEATING_CELL_IF_OPERATION,
          written,
        ),
        ...cellInserts(
          b.table,
          cellsB,
          INSERT_SEATING_CELL_IF_OPERATION,
          written,
        ),
        ...[a, b].map(({ table }) => ({
          sql: UPDATE_SEATING_TABLE_IF_OPERATION,
          args: [
            table.name,
            table.kind,
            table.size,
            table.endSeats ? 1 : 0,
            table.rotation,
            table.gridX,
            table.gridY,
            JSON.stringify(table.seats),
            table.status,
            table.version,
            table.updatedAt,
            table.orgId,
            table.id,
            ...written,
          ],
        })),
      ];
      if (markUndone) {
        statements.push({
          sql: MARK_OPERATION_UNDONE,
          args: [
            operation.id,
            operation.orgId,
            markUndone,
            operation.orgId,
            operation.id,
          ],
        });
      }
      let affected: number[];
      try {
        affected = await runAtomic(await resolveExec(source), statements);
      } catch (error) {
        if (isCellCollision(error)) {
          throw new AppError("CONFLICT", OCCUPIED_MESSAGE);
        }
        throw error;
      }
      // One check is enough, and it has to be this one: the audit row is the
      // only statement that looks at a version, and every other statement in
      // the batch asked whether it landed. The two updates are checked as
      // well because a row that is not there is not a conflict either caller
      // would recognise otherwise.
      const updateA = 3 + cellsA.length + cellsB.length;
      if (
        affected[0] !== 1 ||
        affected[updateA] !== 1 ||
        affected[updateA + 1] !== 1
      ) {
        throw new AppError("CONFLICT", CONFLICT_MESSAGE);
      }
    },

    commit: async ({ table, expectedVersion, operation, markUndone }) => {
      const guard = [table.orgId, table.id, expectedVersion];
      // The audit row goes first, guarded on the version the caller read; the
      // cell rewrite and the update carry the same predicate. Every statement
      // sees the same pre-image inside one transaction, so either all of them
      // apply or none does.
      // An archived table holds no cells: the delete stands and nothing is
      // written back, which is how its space becomes free.
      const cells = table.status === "active" ? cellsOf(table) : [];
      const statements: Statement[] = [
        {
          sql: INSERT_OPERATION_IF_SEATING_TABLE_VERSION,
          args: [...operationInsertArgs(operation), ...guard],
        },
        {
          sql: DELETE_SEATING_CELLS_IF_VERSION,
          args: [table.orgId, table.id, ...guard],
        },
        ...cellInserts(table, cells, INSERT_SEATING_CELL_IF_VERSION, guard),
        {
          sql: UPDATE_SEATING_TABLE_VERSIONED,
          args: [
            table.name,
            table.kind,
            table.size,
            table.endSeats ? 1 : 0,
            table.rotation,
            table.gridX,
            table.gridY,
            JSON.stringify(table.seats),
            table.status,
            table.version,
            table.updatedAt,
            ...guard,
          ],
        },
      ];
      if (markUndone) {
        statements.push({
          sql: MARK_OPERATION_UNDONE,
          args: [
            operation.id,
            table.orgId,
            markUndone,
            table.orgId,
            operation.id,
          ],
        });
      }
      let affected: number[];
      try {
        affected = await runAtomic(await resolveExec(source), statements);
      } catch (error) {
        if (isCellCollision(error)) {
          throw new AppError("CONFLICT", OCCUPIED_MESSAGE);
        }
        throw error;
      }
      // The audit row is first; the update sits after the delete and one
      // insert per cell. If either matched no row the version had moved on,
      // and nothing in between applied either.
      const updateAt = 2 + cells.length;
      if (affected[0] !== 1 || affected[updateAt] !== 1) {
        throw new AppError("CONFLICT", CONFLICT_MESSAGE);
      }
    },
  };
}
