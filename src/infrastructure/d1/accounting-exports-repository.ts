import { AppError } from "../../application/errors";
import type {
  AccountingExport,
  AccountingExportRepository,
} from "../../application/ports";
import type { DbExecSource, Statement } from "./atomic";
import { resolveExec, runAtomic } from "./atomic";
import { mapRows, operationInsertArgs, toAccountingExport } from "./mappers";
import {
  COMPLETE_ACCOUNTING_EXPORT,
  INSERT_ACCOUNTING_OPERATION_IF_PENDING,
  INSERT_PENDING_ACCOUNTING_EXPORT,
  RECORD_ACCOUNTING_ACCEPTANCE,
  SELECT_ACCOUNTING_EXPORT,
  UPDATE_JOB_VERSIONED_IF_OPERATION,
} from "./sql";

const CONFLICT_MESSAGE = "The record was changed by someone else";

export function createAccountingExportsRepository(
  source: DbExecSource,
): AccountingExportRepository {
  const getByJobId = async (
    orgId: string,
    jobId: string,
  ): Promise<AccountingExport | null> => {
    const exec = await resolveExec(source);
    const result = await exec.execute({
      sql: SELECT_ACCOUNTING_EXPORT,
      args: [orgId, jobId],
    });
    return mapRows(result.rows, toAccountingExport)[0] ?? null;
  };

  return {
    getByJobId,

    createPending: async ({ export: pending, expectedVersion }) => {
      const exec = await resolveExec(source);
      await exec.execute({
        sql: INSERT_PENDING_ACCOUNTING_EXPORT,
        args: [
          pending.orgId,
          pending.jobId,
          pending.idempotencyKey,
          JSON.stringify(pending.request),
          "pending",
          pending.requestedBy,
          pending.requestedAt,
          pending.orgId,
          pending.jobId,
          expectedVersion,
          "completed",
        ],
      });
      const stored = await getByJobId(pending.orgId, pending.jobId);
      if (!stored) throw new AppError("CONFLICT", CONFLICT_MESSAGE);
      return stored;
    },

    recordAccepted: async ({ orgId, jobId, externalReference }) => {
      const exec = await resolveExec(source);
      await exec.execute({
        sql: RECORD_ACCOUNTING_ACCEPTANCE,
        args: [externalReference, orgId, jobId, "pending", externalReference],
      });
      const stored = await getByJobId(orgId, jobId);
      if (!stored || stored.externalReference !== externalReference) {
        throw new AppError("CONFLICT", CONFLICT_MESSAGE);
      }
      return stored;
    },

    complete: async ({ export: pending, job, expectedVersion, operation }) => {
      if (!pending.externalReference) {
        throw new AppError("INTERNAL", "Unexpected error");
      }
      const statements: Statement[] = [
        {
          sql: INSERT_ACCOUNTING_OPERATION_IF_PENDING,
          args: [
            ...operationInsertArgs(operation),
            job.orgId,
            job.id,
            expectedVersion,
            pending.orgId,
            pending.jobId,
            "pending",
            pending.externalReference,
          ],
        },
        {
          sql: UPDATE_JOB_VERSIONED_IF_OPERATION,
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
            operation.orgId,
            operation.id,
          ],
        },
        {
          sql: COMPLETE_ACCOUNTING_EXPORT,
          args: [
            "completed",
            operation.id,
            operation.performedAt,
            pending.orgId,
            pending.jobId,
            "pending",
            pending.externalReference,
            operation.orgId,
            operation.id,
          ],
        },
      ];
      const affected = await runAtomic(await resolveExec(source), statements);
      if (affected.some((count) => count !== 1)) {
        throw new AppError("CONFLICT", CONFLICT_MESSAGE);
      }
    },
  };
}
