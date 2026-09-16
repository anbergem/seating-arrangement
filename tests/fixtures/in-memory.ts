/**
 * In-memory implementation of `Dependencies` (blueprint B7, B11).
 *
 * Every use-case test builds one of these instead of touching D1: the
 * behaviour mirrors the real repositories closely enough that a use case
 * cannot tell the difference — `getById`/`list` filter by `orgId`, job
 * creation requires an active customer in the same org, `commit` is
 * version-guarded and CONFLICTs on a stale version, and the clock and id
 * generator are both fixed so tests stay deterministic.
 *
 * `state` is exposed directly so tests (and `tests/fixtures/scenario.ts`)
 * can seed or inspect it without going through the repository interfaces,
 * which run the same preconditions a real adapter would.
 *
 * Every `list` returns rows in the order the matching D1 statement in
 * `src/infrastructure/d1/sql.ts` does — customers by `name, id`, jobs by
 * `scheduled_at, id`, operations by `performed_at DESC, id DESC`. A `Map`
 * iterates in insertion order, which is not an order any database promises,
 * so without this a unit test and the integration test for the same use case
 * could disagree (DISCREPANCIES, 2026-09-06 T08).
 */

import type { Role } from "../../src/application/authorization";
import { AppError } from "../../src/application/errors";
import type {
  Clock,
  AccountingExport,
  AccountingExportRepository,
  CustomerRepository,
  Dependencies,
  IdempotencyStore,
  IdGenerator,
  JobRepository,
  MembershipReader,
  OperationRepository,
} from "../../src/application/ports";
import type { ExternalAccountingSystem } from "../../src/application/ports/external-accounting";
import type { Customer, Job, Operation, ResourceType } from "../../src/domain";
import { createMockAccountingSystem } from "../../src/infrastructure/mock/mock-accounting";

/** The clock value every `createInMemoryDependencies()` call uses unless
 * `options.now` overrides it — "today" in this fixture's fictional
 * timeline, and the same instant every other fixed constant in the codebase
 * (blueprint B12) is written against. */
const DEFAULT_NOW = "2026-09-06T12:00:00.000Z";

export interface InMemoryState {
  customers: Map<string, Customer>;
  jobs: Map<string, Job>;
  operations: Map<string, Operation>;
  /** Keyed by `orgId`, `action` and `key` joined with a space (see
   * `idempotencyMapKey` below) → the resourceId that call created. */
  idempotency: Map<string, string>;
  accountingExports: Map<string, AccountingExport>;
  /** Tests may install one one-shot mutation immediately before a guarded
   * job write to model an intervening request. */
  beforeJobCommit?: () => void | Promise<void>;
  /** orgId → (lower-cased email → role). */
  memberships: Map<string, Map<string, Role>>;
}

export interface InMemoryDependenciesOptions {
  /** Fixed `Clock.now()` value. Defaults to `DEFAULT_NOW`. */
  now?: string;
  /** Fixed sequence for `IdGenerator.next()`. Defaults to `id-1`, `id-2`, …
   * Throws once the sequence is exhausted rather than silently falling back,
   * so a test that asserts on ids notices an unexpected extra call. */
  ids?: string[];
  state?: InMemoryState;
  accounting?: ExternalAccountingSystem;
}

export interface InMemoryDependencies extends Dependencies {
  state: InMemoryState;
}

function idempotencyMapKey(orgId: string, action: string, key: string): string {
  return `${orgId} ${action} ${key}`;
}

/**
 * `ORDER BY <first> ASC, <second> ASC` for two string columns.
 *
 * Plain `<`/`>` rather than `localeCompare`, because SQLite's default
 * collation for a TEXT column is a byte comparison, and a locale-aware
 * comparison would order `["a", "B"]` differently from the database this
 * fixture stands in for.
 */
function byTextThenId(
  first: string,
  second: string,
  firstId: string,
  secondId: string,
): number {
  if (first !== second) return first < second ? -1 : 1;
  if (firstId === secondId) return 0;
  return firstId < secondId ? -1 : 1;
}

function createClock(now: string): Clock {
  return { now: () => now };
}

function createIdGenerator(fixedIds: string[] | undefined): IdGenerator {
  let sequence = 0;
  return {
    next: () => {
      sequence += 1;
      if (fixedIds) {
        const id = fixedIds[sequence - 1];
        if (id === undefined) {
          throw new Error(
            `in-memory id generator: no id provided for call #${sequence}`,
          );
        }
        return id;
      }
      return `id-${sequence}`;
    },
  };
}

function createMembershipReader(state: InMemoryState): MembershipReader {
  return {
    getRole: async (orgId, userEmail) => {
      const org = state.memberships.get(orgId);
      if (!org) return null;
      return org.get(userEmail.toLowerCase()) ?? null;
    },
    isMember: async (orgId, userEmail) => {
      const org = state.memberships.get(orgId);
      return org ? org.has(userEmail.toLowerCase()) : false;
    },
  };
}

function applyMarkUndone(
  state: InMemoryState,
  markUndone: string | undefined,
  undoneBy: string,
): void {
  if (!markUndone) return;
  const op = state.operations.get(markUndone);
  if (op)
    state.operations.set(markUndone, { ...op, undoneByOperationId: undoneBy });
}

function createCustomerRepository(state: InMemoryState): CustomerRepository {
  return {
    getById: async (orgId, id) => {
      const found = state.customers.get(id);
      return found && found.orgId === orgId ? found : null;
    },
    list: async (orgId, filter) => {
      return (
        Array.from(state.customers.values())
          .filter((c) => c.orgId === orgId)
          .filter((c) => (filter.status ? c.status === filter.status : true))
          .filter((c) =>
            filter.search
              ? c.name.toLowerCase().includes(filter.search.toLowerCase())
              : true,
          )
          // `SELECT_CUSTOMERS_PARTS.order`: ORDER BY name ASC, id ASC.
          .sort((a, b) => byTextThenId(a.name, b.name, a.id, b.id))
      );
    },
    create: async ({ customer, operation, idempotency }) => {
      state.customers.set(customer.id, customer);
      state.operations.set(operation.id, operation);
      if (idempotency) {
        state.idempotency.set(
          idempotencyMapKey(
            customer.orgId,
            idempotency.action,
            idempotency.key,
          ),
          customer.id,
        );
      }
    },
    commit: async ({ customer, expectedVersion, operation, markUndone }) => {
      const existing = state.customers.get(customer.id);
      if (
        !existing ||
        existing.orgId !== customer.orgId ||
        existing.version !== expectedVersion
      ) {
        throw new AppError(
          "CONFLICT",
          "The record was changed by someone else",
        );
      }
      state.customers.set(customer.id, customer);
      state.operations.set(operation.id, operation);
      applyMarkUndone(state, markUndone, operation.id);
    },
  };
}

function createJobRepository(state: InMemoryState): JobRepository {
  return {
    getById: async (orgId, id) => {
      const found = state.jobs.get(id);
      return found && found.orgId === orgId ? found : null;
    },
    list: async (orgId, filter) => {
      return (
        Array.from(state.jobs.values())
          .filter((j) => j.orgId === orgId)
          .filter((j) => (filter.status ? j.status === filter.status : true))
          .filter((j) =>
            filter.customerId ? j.customerId === filter.customerId : true,
          )
          // Half-open window, the same as `SELECT_JOBS_PARTS` in
          // `src/infrastructure/d1/sql.ts`: `from` inclusive, `to` exclusive.
          .filter((j) => (filter.from ? j.scheduledAt >= filter.from : true))
          .filter((j) => (filter.to ? j.scheduledAt < filter.to : true))
          // `SELECT_JOBS_PARTS.order`: ORDER BY scheduled_at ASC, id ASC.
          .sort((a, b) =>
            byTextThenId(a.scheduledAt, b.scheduledAt, a.id, b.id),
          )
      );
    },
    create: async ({ job, operation, idempotency }) => {
      const customer = state.customers.get(job.customerId);
      if (
        !customer ||
        customer.orgId !== job.orgId ||
        customer.status !== "active"
      ) {
        throw new AppError("NOT_FOUND", "Customer not found or archived");
      }
      state.jobs.set(job.id, job);
      state.operations.set(operation.id, operation);
      if (idempotency) {
        state.idempotency.set(
          idempotencyMapKey(job.orgId, idempotency.action, idempotency.key),
          job.id,
        );
      }
    },
    commit: async ({
      job,
      expectedVersion,
      operation,
      markUndone,
      requireNoAccountingExport,
    }) => {
      const hook = state.beforeJobCommit;
      state.beforeJobCommit = undefined;
      await hook?.();
      const existing = state.jobs.get(job.id);
      if (
        !existing ||
        existing.orgId !== job.orgId ||
        existing.version !== expectedVersion ||
        (requireNoAccountingExport &&
          state.accountingExports.has(`${job.orgId} ${job.id}`))
      ) {
        throw new AppError(
          "CONFLICT",
          "The record was changed by someone else",
        );
      }
      state.jobs.set(job.id, job);
      state.operations.set(operation.id, operation);
      applyMarkUndone(state, markUndone, operation.id);
    },
  };
}

function accountingExportMapKey(orgId: string, jobId: string): string {
  return `${orgId} ${jobId}`;
}

function createAccountingExportRepository(
  state: InMemoryState,
): AccountingExportRepository {
  return {
    getByJobId: async (orgId, jobId) =>
      state.accountingExports.get(accountingExportMapKey(orgId, jobId)) ?? null,
    createPending: async ({ export: pending, expectedVersion }) => {
      const key = accountingExportMapKey(pending.orgId, pending.jobId);
      const winner = state.accountingExports.get(key);
      if (winner) return winner;
      const job = state.jobs.get(pending.jobId);
      if (
        !job ||
        job.orgId !== pending.orgId ||
        job.version !== expectedVersion ||
        job.status !== "completed" ||
        job.accountingReference !== null
      ) {
        throw new AppError(
          "CONFLICT",
          "The record was changed by someone else",
        );
      }
      state.accountingExports.set(key, pending);
      return pending;
    },
    recordAccepted: async ({ orgId, jobId, externalReference }) => {
      const key = accountingExportMapKey(orgId, jobId);
      const pending = state.accountingExports.get(key);
      if (
        !pending ||
        (pending.externalReference !== null &&
          pending.externalReference !== externalReference)
      ) {
        throw new AppError(
          "CONFLICT",
          "The record was changed by someone else",
        );
      }
      const accepted = {
        ...pending,
        externalReference: pending.externalReference ?? externalReference,
      };
      state.accountingExports.set(key, accepted);
      return accepted;
    },
    complete: async ({ export: pending, job, expectedVersion, operation }) => {
      const hook = state.beforeJobCommit;
      state.beforeJobCommit = undefined;
      await hook?.();
      const key = accountingExportMapKey(pending.orgId, pending.jobId);
      const stored = state.accountingExports.get(key);
      const current = state.jobs.get(job.id);
      if (
        !stored ||
        stored.status !== "pending" ||
        stored.externalReference !== pending.externalReference ||
        !current ||
        current.orgId !== job.orgId ||
        current.version !== expectedVersion
      ) {
        throw new AppError(
          "CONFLICT",
          "The record was changed by someone else",
        );
      }
      state.jobs.set(job.id, job);
      state.operations.set(operation.id, operation);
      state.accountingExports.set(key, {
        ...stored,
        status: "completed",
        operationId: operation.id,
        completedAt: operation.performedAt,
      });
    },
  };
}

/** Newest first, matching what "recent activity" means for both
 * `listRecent` and `listForResource` — and matching
 * `SELECT_RECENT_OPERATIONS`/`SELECT_OPERATIONS_FOR_RESOURCE`, which are
 * `ORDER BY performed_at DESC, id DESC`. The `id` tiebreak matters here: the
 * seeded scenario writes several operations at the same instant, so without
 * it the page boundary of a `limit`ed list would be insertion order. */
function byMostRecentFirst(a: Operation, b: Operation): number {
  return -byTextThenId(a.performedAt, b.performedAt, a.id, b.id);
}

function createOperationRepository(state: InMemoryState): OperationRepository {
  return {
    getById: async (orgId, id) => {
      const found = state.operations.get(id);
      return found && found.orgId === orgId ? found : null;
    },
    listRecent: async (orgId, limit) => {
      return Array.from(state.operations.values())
        .filter((op) => op.orgId === orgId)
        .sort(byMostRecentFirst)
        .slice(0, limit);
    },
    listForResource: async (
      orgId: string,
      type: ResourceType,
      id: string,
      limit: number,
    ) => {
      return Array.from(state.operations.values())
        .filter(
          (op) =>
            op.orgId === orgId &&
            op.resourceType === type &&
            op.resourceId === id,
        )
        .sort(byMostRecentFirst)
        .slice(0, limit);
    },
    // `versionBefore === 0` identifies a create, the same predicate
    // `SELECT_CREATE_OPERATION` uses.
    findCreateOperation: async (
      orgId: string,
      type: ResourceType,
      id: string,
    ) => {
      return (
        Array.from(state.operations.values()).find(
          (op) =>
            op.orgId === orgId &&
            op.resourceType === type &&
            op.resourceId === id &&
            op.kind === "forward" &&
            op.versionBefore === 0,
        ) ?? null
      );
    },
  };
}

function createIdempotencyStore(state: InMemoryState): IdempotencyStore {
  return {
    find: async (orgId, action, key) => {
      return (
        state.idempotency.get(idempotencyMapKey(orgId, action, key)) ?? null
      );
    },
  };
}

/**
 * Trivial stand-in for the real vendor adapter (blueprint B22), just enough
 * to make `Dependencies` complete for tests that do not exercise
 * `sendJobToAccounting` themselves. T27 adds the real, independently tested
 * mock at `src/infrastructure/mock/mock-accounting.ts`.
 */
export function createInMemoryDependencies(
  options: InMemoryDependenciesOptions = {},
): InMemoryDependencies {
  const state: InMemoryState = options.state ?? {
    customers: new Map(),
    jobs: new Map(),
    operations: new Map(),
    idempotency: new Map(),
    accountingExports: new Map(),
    memberships: new Map(),
  };

  return {
    clock: createClock(options.now ?? DEFAULT_NOW),
    ids: createIdGenerator(options.ids),
    membership: createMembershipReader(state),
    customers: createCustomerRepository(state),
    jobs: createJobRepository(state),
    operations: createOperationRepository(state),
    idempotency: createIdempotencyStore(state),
    accounting: options.accounting ?? createMockAccountingSystem(),
    accountingExports: createAccountingExportRepository(state),
    state,
  };
}
