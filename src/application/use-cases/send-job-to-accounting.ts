import type { Job, Operation } from "../../domain";
import { reconcileAccountingExport } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { AccountingExport, Dependencies } from "../ports";
import { ExternalSystemError } from "../ports/external-accounting";
import { applyDomain, type CommandResult } from "./command";

export interface SendJobToAccountingInput {
  jobId: string;
  expectedVersion?: number;
}

export interface SendJobToAccountingResult extends CommandResult<Job> {
  externalReference: string;
}

function completedResult(
  job: Job | null,
  request: AccountingExport,
): SendJobToAccountingResult {
  if (!job || !request.externalReference || !request.operationId) {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return {
    resource: job,
    operationId: request.operationId,
    externalReference: request.externalReference,
  };
}

export async function sendJobToAccounting(
  deps: Dependencies,
  actor: Actor,
  input: SendJobToAccountingInput,
): Promise<SendJobToAccountingResult> {
  requireCapability(actor, "jobs:export");

  let request = await deps.accountingExports.getByJobId(
    actor.orgId,
    input.jobId,
  );
  if (request?.status === "completed") {
    return completedResult(
      await deps.jobs.getById(actor.orgId, input.jobId),
      request,
    );
  }

  if (!request) {
    const job = await deps.jobs.getById(actor.orgId, input.jobId);
    if (!job) throw new AppError("NOT_FOUND", "Job not found");
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== job.version
    ) {
      throw new AppError("CONFLICT", "The job was changed by someone else");
    }
    if (job.status !== "completed") {
      throw new AppError(
        "INVARIANT",
        `Cannot send to accounting a job that is ${job.status}`,
      );
    }
    if (job.accountingReference !== null || !job.completedAt) {
      throw new AppError("INVARIANT", "Job was already sent to accounting");
    }
    const customer = await deps.customers.getById(actor.orgId, job.customerId);
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found");
    const now = deps.clock.now();
    const pending: AccountingExport = {
      orgId: actor.orgId,
      jobId: job.id,
      idempotencyKey: `job:${job.id}`,
      request: {
        idempotencyKey: `job:${job.id}`,
        orgId: actor.orgId,
        customer: { id: customer.id, name: customer.name },
        job: { id: job.id, title: job.title, completedAt: job.completedAt },
      },
      status: "pending",
      externalReference: null,
      operationId: null,
      requestedBy: actor.userEmail,
      requestedAt: now,
      completedAt: null,
    };
    request = await deps.accountingExports.createPending({
      export: pending,
      expectedVersion: job.version,
    });
    if (request.status === "completed") {
      return completedResult(
        await deps.jobs.getById(actor.orgId, input.jobId),
        request,
      );
    }
  }

  let vendorResult: Awaited<
    ReturnType<Dependencies["accounting"]["createInvoiceDraft"]>
  >;
  try {
    vendorResult = await deps.accounting.createInvoiceDraft(request.request);
  } catch (error) {
    if (error instanceof ExternalSystemError) {
      throw new AppError(
        "EXTERNAL",
        `Accounting system unavailable: ${error.message}. Retry will reconcile the pending request.`,
      );
    }
    throw new AppError("INTERNAL", "Unexpected error");
  }

  request = await deps.accountingExports.recordAccepted({
    orgId: request.orgId,
    jobId: request.jobId,
    externalReference: vendorResult.externalReference,
  });
  if (request.status === "completed") {
    return completedResult(
      await deps.jobs.getById(actor.orgId, input.jobId),
      request,
    );
  }

  const current = await deps.jobs.getById(actor.orgId, input.jobId);
  if (!current) throw new AppError("NOT_FOUND", "Job not found");
  const now = deps.clock.now();
  const next = applyDomain(() =>
    reconcileAccountingExport(current, vendorResult.externalReference, now),
  );
  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "send-job-to-accounting",
    resourceType: "job",
    resourceId: current.id,
    classification: "irreversible",
    versionBefore: current.version,
    versionAfter: next.version,
    payload: {
      externalReference: vendorResult.externalReference,
      idempotencyKey: request.idempotencyKey,
    },
    inverse: null,
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  try {
    await deps.accountingExports.complete({
      export: request,
      job: next,
      expectedVersion: current.version,
      operation,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "CONFLICT") {
      const winner = await deps.accountingExports.getByJobId(
        actor.orgId,
        input.jobId,
      );
      if (winner?.status === "completed") {
        return completedResult(
          await deps.jobs.getById(actor.orgId, input.jobId),
          winner,
        );
      }
    }
    throw error;
  }
  return {
    resource: next,
    operationId: operation.id,
    externalReference: vendorResult.externalReference,
  };
}
