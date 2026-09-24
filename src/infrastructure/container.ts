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
 *   method, because it resolves against the framework's current request
 *   context; a cached executor would outlive its request and, worse, could be
 *   handed to the next one.
 */

// The framework's own db module. It is imported here and in nothing else the
// application layer can reach, which is what keeps `@agent-native/*` out of
// every layer above this one (B2).
import { getDbExec } from "@agent-native/core/db";

import type { Dependencies } from "../application/ports";
import { randomIdGenerator } from "./random-ids";
import type { DbExecLike } from "./sql/atomic";
import { createEventsRepository } from "./sql/events-repository";
import { createIdempotencyStore } from "./sql/idempotency-store";
import { createMembershipReader } from "./sql/membership-reader";
import { createOperationsRepository } from "./sql/operations-repository";
import { createSeatingTablesRepository } from "./sql/seating-tables-repository";
import { systemClock } from "./system-clock";

/**
 * The executor for the request being served. `resolveExec` (see `sql/atomic.ts`)
 * takes care of the framework's lazy proxy; this only has to avoid holding on
 * to the result.
 */
function currentDbExec(): DbExecLike {
  return getDbExec();
}

let dependencies: Dependencies | undefined;

export function getDependencies(): Dependencies {
  dependencies ??= {
    clock: systemClock,
    ids: randomIdGenerator,
    membership: createMembershipReader(currentDbExec),
    events: createEventsRepository(currentDbExec),
    seatingTables: createSeatingTablesRepository(currentDbExec),
    operations: createOperationsRepository(currentDbExec),
    idempotency: createIdempotencyStore(currentDbExec),
  };
  return dependencies;
}
