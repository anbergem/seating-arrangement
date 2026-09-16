/**
 * `JobRepository` against D1 / SQLite (blueprint B7, B11).
 *
 * The same shape as `customers-repository.ts`, with one extra rule: a job may
 * only be created for a customer that exists, is active, and belongs to the
 * same organization. That check is inside `INSERT_JOB_IF_ACTIVE_CUSTOMER`
 * rather than a read before the write, so two requests cannot both pass it and
 * the archived-customer case cannot slip through a race (D07).
 *
 * The failure is reported as NOT_FOUND for all three reasons on purpose: a
 * caller in another organization must not be able to tell "there is no such
 * customer" from "there is one, but not yours".
 */

import { AppError } from "../../application/errors";
import type { JobRepository } from "../../application/ports";
import type { Job, JobStatus } from "../../domain";
import type { DbExecSource, Statement } from "./atomic";
import { resolveExec, runAtomic } from "./atomic";
import {
  idempotencyKeyStatement,
  operationForCreateStatement,
} from "./create-statements";
import { mapRows, operationInsertArgs, toJob } from "./mappers";
import {
  INSERT_JOB_IF_ACTIVE_CUSTOMER,
  INSERT_OPERATION_IF_VERSION,
  INSERT_OPERATION_IF_VERSION_WITHOUT_ACCOUNTING_EXPORT,
  MARK_OPERATION_UNDONE,
  SELECT_JOB_BY_ID,
  SELECT_JOBS,
  SELECT_JOBS_PARTS,
  UPDATE_JOB_VERSIONED,
  UPDATE_JOB_VERSIONED_WITHOUT_ACCOUNTING_EXPORT,
} from "./sql";

const CONFLICT_MESSAGE = "The record was changed by someone else";
const CUSTOMER_MISSING_MESSAGE = "Customer not found or archived";

function jobInsertArgs(job: Job): unknown[] {
  return [
    job.id,
    job.orgId,
    job.customerId,
    job.title,
    job.description,
    job.status,
    job.scheduledAt,
    job.assignedTo,
    job.completedAt,
    job.archivedAt,
    job.accountingReference,
    job.accountingSentAt,
    job.version,
    job.createdBy,
    job.createdAt,
    job.updatedAt,
  ];
}

export function createJobsRepository(source: DbExecSource): JobRepository {
  return {
    getById: async (orgId: string, id: string) => {
      const exec = await resolveExec(source);
      const { rows } = await exec.execute({
        sql: SELECT_JOB_BY_ID,
        args: [orgId, id],
      });
      const [job] = mapRows(rows, toJob);
      return job ?? null;
    },

    list: async (
      orgId: string,
      filter: {
        status?: JobStatus;
        customerId?: string;
        from?: string;
        to?: string;
      },
    ) => {
      let sql = SELECT_JOBS;
      const args: unknown[] = [orgId];
      if (filter.status !== undefined) {
        sql += SELECT_JOBS_PARTS.status;
        args.push(filter.status);
      }
      if (filter.customerId !== undefined) {
        sql += SELECT_JOBS_PARTS.customerId;
        args.push(filter.customerId);
      }
      if (filter.from !== undefined) {
        sql += SELECT_JOBS_PARTS.from;
        args.push(filter.from);
      }
      if (filter.to !== undefined) {
        sql += SELECT_JOBS_PARTS.to;
        args.push(filter.to);
      }
      sql += SELECT_JOBS_PARTS.order;

      const exec = await resolveExec(source);
      const { rows } = await exec.execute({ sql, args });
      return mapRows(rows, toJob);
    },

    create: async ({ job, operation, idempotency }) => {
      const statements: Statement[] = [
        {
          sql: INSERT_JOB_IF_ACTIVE_CUSTOMER,
          args: [...jobInsertArgs(job), job.orgId, job.customerId],
        },
        operationForCreateStatement(operation),
      ];
      if (idempotency) {
        statements.push(
          idempotencyKeyStatement(operation, idempotency, job.createdAt),
        );
      }

      const affected = await runAtomic(await resolveExec(source), statements);
      // The guard failed: no active customer with that id in this
      // organization. The audit row and the idempotency key were guarded on
      // the job existing, so nothing was written.
      if (affected[0] !== 1) {
        throw new AppError("NOT_FOUND", CUSTOMER_MISSING_MESSAGE);
      }
    },

    commit: async ({
      job,
      expectedVersion,
      operation,
      markUndone,
      requireNoAccountingExport,
    }) => {
      // The audit row goes first, guarded on the version the caller read; the
      // update carries the same predicate. Both statements see the same
      // pre-image inside one transaction, so either both apply or neither
      // does, whatever version the update would have written.
      const statements: Statement[] = [
        {
          sql: requireNoAccountingExport
            ? INSERT_OPERATION_IF_VERSION_WITHOUT_ACCOUNTING_EXPORT
            : INSERT_OPERATION_IF_VERSION,
          args: [
            ...operationInsertArgs(operation),
            job.orgId,
            job.id,
            expectedVersion,
            ...(requireNoAccountingExport ? [job.orgId, job.id] : []),
          ],
        },
        {
          sql: requireNoAccountingExport
            ? UPDATE_JOB_VERSIONED_WITHOUT_ACCOUNTING_EXPORT
            : UPDATE_JOB_VERSIONED,
          args: [
            job.status,
            job.scheduledAt,
            job.assignedTo,
            job.completedAt,
            job.archivedAt,
            job.accountingReference,
            job.accountingSentAt,
            job.version,
            job.updatedAt,
            job.orgId,
            job.id,
            expectedVersion,
            ...(requireNoAccountingExport
              ? [job.orgId, job.id, operation.orgId, operation.id]
              : []),
          ],
        },
      ];
      if (markUndone) {
        statements.push({
          sql: MARK_OPERATION_UNDONE,
          args: [operation.id, job.orgId, markUndone, job.orgId, operation.id],
        });
      }

      const affected = await runAtomic(await resolveExec(source), statements);
      if (affected[0] !== 1 || affected[1] !== 1) {
        throw new AppError("CONFLICT", CONFLICT_MESSAGE);
      }
    },
  };
}
