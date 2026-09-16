/**
 * The composition root (blueprint B16, decision D08).
 *
 * `runAppAction` (T08) calls `getDependencies()` once per action and hands the
 * result to a use case, so this is the only file in the application that knows
 * which adapter implements which port. Everything above it sees `Dependencies`
 * and nothing else.
 *
 * Two lifetimes are deliberately different:
 *
 * - The repository objects are memoised. They are stateless closures over a
 *   way to reach the database, so building them per request would be waste.
 * - The executor is not. `getDbExec()` is called inside every repository
 *   method, because on Workers it resolves the D1 binding of the request being
 *   served; a cached executor would outlive its request and, worse, could be
 *   handed to the next one.
 */

// The framework's own db module. It is imported here and in nothing else the
// application layer can reach, which is what keeps `@agent-native/*` out of
// every layer above this one (B2).
import { getDbExec } from "@agent-native/core/db";

import type { Dependencies } from "../application/ports";
import { createAccountingExportsRepository } from "./d1/accounting-exports-repository";
import type { DbExecLike } from "./d1/atomic";
import { createCustomersRepository } from "./d1/customers-repository";
import { createIdempotencyStore } from "./d1/idempotency-store";
import { createJobsRepository } from "./d1/jobs-repository";
import { createMembershipReader } from "./d1/membership-reader";
import { createOperationsRepository } from "./d1/operations-repository";
import { createMockAccountingSystem } from "./mock/mock-accounting";
import { randomIdGenerator } from "./random-ids";
import { systemClock } from "./system-clock";

/**
 * The executor for the request being served. `resolveExec` (see `d1/atomic.ts`)
 * takes care of the framework's lazy proxy; this only has to avoid holding on
 * to the result.
 */
function currentDbExec(): DbExecLike {
  return getDbExec();
}

/**
 * Placeholder until T27 wires `src/infrastructure/mock/mock-accounting.ts`.
 *
 * `Dependencies` has no optional fields — a use case must never have to ask
 * whether a port exists — so the field is filled with an adapter that refuses
 * loudly and in the port's own error type. Nothing in the application calls it
 * before T27 adds `send-job-to-accounting`.
 */
const accounting = createMockAccountingSystem();

let dependencies: Dependencies | undefined;

export function getDependencies(): Dependencies {
  dependencies ??= {
    clock: systemClock,
    ids: randomIdGenerator,
    membership: createMembershipReader(currentDbExec),
    customers: createCustomersRepository(currentDbExec),
    jobs: createJobsRepository(currentDbExec),
    operations: createOperationsRepository(currentDbExec),
    idempotency: createIdempotencyStore(currentDbExec),
    accounting,
    accountingExports: createAccountingExportsRepository(currentDbExec),
  };
  return dependencies;
}
