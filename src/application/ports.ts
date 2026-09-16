/**
 * Outbound ports the application layer depends on (blueprint B7).
 *
 * Every port here is an interface with no framework or I/O detail leaking
 * through. `src/infrastructure/d1` (T07) implements them against D1;
 * `tests/fixtures/in-memory.ts` implements them in memory for unit tests.
 * `Dependencies` is the one bag every use case takes, so a use case's only
 * inputs are `(deps, actor, input)`.
 *
 * `ExternalAccountingSystem` (and its error type) lives in its own file,
 * `./ports/external-accounting`, per blueprint B22; it is re-exported here
 * so `Dependencies` can reference it and so callers may still import
 * everything from this one module.
 */

import type {
  Customer,
  CustomerStatus,
  Job,
  JobStatus,
  Operation,
  ResourceType,
} from "../domain";
import type { Role } from "./authorization";
import type { ExternalAccountingSystem } from "./ports/external-accounting";
import type { AccountingInvoiceDraft } from "./ports/external-accounting";

export * from "./ports/external-accounting";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(): string;
}

export interface MembershipReader {
  getRole(orgId: string, userEmail: string): Promise<Role | null>;
  isMember(orgId: string, userEmail: string): Promise<boolean>;
}

export interface CustomerRepository {
  getById(orgId: string, id: string): Promise<Customer | null>;
  list(
    orgId: string,
    filter: { status?: CustomerStatus; search?: string },
  ): Promise<Customer[]>;
  create(input: {
    customer: Customer;
    operation: Operation;
    idempotency?: { action: string; key: string };
  }): Promise<void>;
  /** Throws `AppError("CONFLICT", …)` when the stored version does not
   * match `expectedVersion` (blueprint B11). */
  commit(input: {
    customer: Customer;
    expectedVersion: number;
    operation: Operation;
    markUndone?: string;
  }): Promise<void>;
}

export interface JobRepository {
  getById(orgId: string, id: string): Promise<Job | null>;
  list(
    orgId: string,
    filter: {
      status?: JobStatus;
      customerId?: string;
      from?: string;
      to?: string;
    },
  ): Promise<Job[]>;
  /** Throws `AppError("NOT_FOUND", "Customer not found or archived")`
   * unless the customer exists, is in the same org and is active
   * (blueprint B11). */
  create(input: {
    job: Job;
    operation: Operation;
    idempotency?: { action: string; key: string };
  }): Promise<void>;
  /** Throws `AppError("CONFLICT", …)` when the stored version does not
   * match `expectedVersion` (blueprint B11). */
  commit(input: {
    job: Job;
    expectedVersion: number;
    operation: Operation;
    markUndone?: string;
    requireNoAccountingExport?: boolean;
  }): Promise<void>;
}

export interface OperationRepository {
  getById(orgId: string, id: string): Promise<Operation | null>;
  listRecent(orgId: string, limit: number): Promise<Operation[]>;
  listForResource(
    orgId: string,
    type: ResourceType,
    id: string,
    limit: number,
  ): Promise<Operation[]>;
  /** The `forward` operation that created this resource — the one row with
   * `versionBefore === 0` — or `null` when the resource has none. Read by an
   * idempotent create's replay, which owes the caller the `operationId` of the
   * create that already happened and cannot find it through the newest-first,
   * limited `listForResource` (B7). */
  findCreateOperation(
    orgId: string,
    type: ResourceType,
    id: string,
  ): Promise<Operation | null>;
}

export interface IdempotencyStore {
  /** Returns the `resourceId` a prior call with this `(action, key)`
   * created, or `null` when the key has not been used yet. */
  find(orgId: string, action: string, key: string): Promise<string | null>;
}

export type AccountingExportStatus = "pending" | "completed";

export interface AccountingExport {
  orgId: string;
  jobId: string;
  idempotencyKey: string;
  request: AccountingInvoiceDraft;
  status: AccountingExportStatus;
  externalReference: string | null;
  operationId: string | null;
  requestedBy: string;
  requestedAt: string;
  completedAt: string | null;
}

export interface AccountingExportRepository {
  getByJobId(orgId: string, jobId: string): Promise<AccountingExport | null>;
  /** Inserts only while the named job is completed, unsent and at the
   * expected version. A concurrent winner is returned instead. */
  createPending(input: {
    export: AccountingExport;
    expectedVersion: number;
  }): Promise<AccountingExport>;
  /** Persists a vendor identity before attempting the local completion. */
  recordAccepted(input: {
    orgId: string;
    jobId: string;
    externalReference: string;
  }): Promise<AccountingExport>;
  /** Atomically updates the current job, records the irreversible operation,
   * and marks the request completed. Throws CONFLICT on a stale job version. */
  complete(input: {
    export: AccountingExport;
    job: Job;
    expectedVersion: number;
    operation: Operation;
  }): Promise<void>;
}

export interface Dependencies {
  clock: Clock;
  ids: IdGenerator;
  membership: MembershipReader;
  customers: CustomerRepository;
  jobs: JobRepository;
  operations: OperationRepository;
  idempotency: IdempotencyStore;
  accounting: ExternalAccountingSystem;
  accountingExports: AccountingExportRepository;
}
