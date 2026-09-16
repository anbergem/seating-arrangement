/**
 * `CustomerRepository` against D1 / SQLite (blueprint B7, B11).
 *
 * Mirrors `tests/fixtures/in-memory.ts` exactly, because every use-case test
 * runs against that one and every integration test against this one: reads are
 * filtered by `orgId` (a customer from another organization reads as absent,
 * never as forbidden), and `commit` refuses a stale version with CONFLICT.
 *
 * Nothing here knows which database it is talking to. `runAtomic` picks
 * `atomicBatch` or `transaction`, and the preconditions travel inside the SQL
 * (D07) because D1 cannot hold a transaction open across a check.
 */

import { AppError } from "../../application/errors";
import type { CustomerRepository } from "../../application/ports";
import type { Customer, CustomerStatus } from "../../domain";
import type { DbExecSource, Statement } from "./atomic";
import { resolveExec, runAtomic } from "./atomic";
import {
  idempotencyKeyStatement,
  operationForCreateStatement,
} from "./create-statements";
import { mapRows, operationInsertArgs, toCustomer } from "./mappers";
import {
  INSERT_CUSTOMER,
  INSERT_OPERATION_IF_CUSTOMER_VERSION,
  MARK_OPERATION_UNDONE,
  SELECT_CUSTOMER_BY_ID,
  SELECT_CUSTOMERS,
  SELECT_CUSTOMERS_PARTS,
  UPDATE_CUSTOMER_VERSIONED,
} from "./sql";

/** The message every version conflict carries (B11); the caller sees the same
 * sentence whether the row moved on or vanished. */
const CONFLICT_MESSAGE = "The record was changed by someone else";

/**
 * `LIKE` treats `%` and `_` as wildcards, so a search for "50% off" would
 * match far more than it should. The escape character is `\`, declared by the
 * `ESCAPE` clause in `SELECT_CUSTOMERS_PARTS.search`.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function customerInsertArgs(customer: Customer): unknown[] {
  return [
    customer.id,
    customer.orgId,
    customer.name,
    customer.email,
    customer.phone,
    customer.notes,
    customer.status,
    customer.version,
    customer.createdBy,
    customer.createdAt,
    customer.updatedAt,
  ];
}

export function createCustomersRepository(
  source: DbExecSource,
): CustomerRepository {
  return {
    getById: async (orgId: string, id: string) => {
      const exec = await resolveExec(source);
      const { rows } = await exec.execute({
        sql: SELECT_CUSTOMER_BY_ID,
        args: [orgId, id],
      });
      const [customer] = mapRows(rows, toCustomer);
      return customer ?? null;
    },

    list: async (
      orgId: string,
      filter: { status?: CustomerStatus; search?: string },
    ) => {
      let sql = SELECT_CUSTOMERS;
      const args: unknown[] = [orgId];
      if (filter.status !== undefined) {
        sql += SELECT_CUSTOMERS_PARTS.status;
        args.push(filter.status);
      }
      if (filter.search !== undefined && filter.search !== "") {
        sql += SELECT_CUSTOMERS_PARTS.search;
        args.push(`%${escapeLike(filter.search.toLowerCase())}%`);
      }
      sql += SELECT_CUSTOMERS_PARTS.order;

      const exec = await resolveExec(source);
      const { rows } = await exec.execute({ sql, args });
      return mapRows(rows, toCustomer);
    },

    create: async ({ customer, operation, idempotency }) => {
      const statements: Statement[] = [
        {
          sql: INSERT_CUSTOMER,
          args: [...customerInsertArgs(customer), customer.orgId, customer.id],
        },
        operationForCreateStatement(operation),
      ];
      if (idempotency) {
        statements.push(
          idempotencyKeyStatement(operation, idempotency, customer.createdAt),
        );
      }

      const affected = await runAtomic(await resolveExec(source), statements);
      // Zero rows means a customer with this id already exists. Ids are
      // `crypto.randomUUID()` values (B3), so this is a replayed batch rather
      // than a collision — and a replay repeats the operation id too, which
      // the operations primary key rejects, aborting the batch before
      // anything lands.
      if (affected[0] !== 1) throw new AppError("CONFLICT", CONFLICT_MESSAGE);
    },

    commit: async ({ customer, expectedVersion, operation, markUndone }) => {
      // Audit row first, guarded on the version the caller read, then the
      // update carrying the same predicate — see `jobs-repository.ts` for why
      // the order matters. A stale commit writes nothing at all, and this is
      // the only report of it.
      const statements: Statement[] = [
        {
          sql: INSERT_OPERATION_IF_CUSTOMER_VERSION,
          args: [
            ...operationInsertArgs(operation),
            customer.orgId,
            customer.id,
            expectedVersion,
          ],
        },
        {
          sql: UPDATE_CUSTOMER_VERSIONED,
          args: [
            customer.name,
            customer.email,
            customer.phone,
            customer.notes,
            customer.status,
            customer.version,
            customer.updatedAt,
            customer.orgId,
            customer.id,
            expectedVersion,
          ],
        },
      ];
      if (markUndone) {
        statements.push({
          sql: MARK_OPERATION_UNDONE,
          args: [
            operation.id,
            customer.orgId,
            markUndone,
            customer.orgId,
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
