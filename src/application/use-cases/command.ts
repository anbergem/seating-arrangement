/**
 * What the use cases in this directory share (blueprint B8, B9).
 *
 * The command files are otherwise self-contained, but these would be copied
 * verbatim into all of them, and each is the kind of thing that must never
 * drift between copies: what a command returns, how a duplicate idempotency
 * key is recognised, and what counts as a create.
 */

import type { Customer, Job, Operation, ResourceType } from "../../domain";
import { toAppError } from "../errors";

/** What every command returns: the resource as it now is, and the id of the
 * operation row that records the change — the handle `undo-operation` takes. */
export interface CommandResult<T> {
  resource: T;
  operationId: string;
}

/**
 * What `undoOperation` and `redoOperation` return (blueprint B9).
 *
 * Unlike every other command, these two are told which record to touch by an
 * operation id rather than by a typed argument, so the resource can be either
 * kind and the caller cannot know which from the arguments alone.
 * `resourceType` is therefore part of the result: the action's `audit.target`
 * needs a type and an id (B16), and a second lookup is the only other way to
 * learn the type.
 */
export interface UndoRedoResult extends CommandResult<Customer | Job> {
  resourceType: ResourceType;
}

/**
 * Runs a pure domain transition and converts its `DomainError` into the
 * matching `AppError` (`VALIDATION` → `VALIDATION`, `INVARIANT` →
 * `INVARIANT`), so a use case only ever throws `AppError` and a test can
 * assert on one error type. Anything that is not a `DomainError` becomes
 * `INTERNAL` with its message withheld, exactly as `runAppAction` would.
 */
export function applyDomain<T>(transition: () => T): T {
  try {
    return transition();
  } catch (err) {
    throw toAppError(err);
  }
}

/**
 * Whether a failed create looks like a lost race on the same idempotency key
 * (blueprint B8, decision D14).
 *
 * Two callers can pass the `find` lookup at the same time and both go on to
 * write; the `idempotency_keys` primary key `(org_id, action, key)` lets only
 * one of them land, and the loser's whole atomic batch is rolled back. The
 * loser must then answer with the resource the winner created, not with a
 * database error, so it retries the lookup once.
 *
 * The match is on the message because the driver's error shape is not part of
 * the port contract: `@libsql/client` reports the violation as
 * `SQLITE_CONSTRAINT_PRIMARYKEY: UNIQUE constraint failed:
 * idempotency_keys.org_id, idempotency_keys.action, idempotency_keys.key`.
 * Being broad is safe here: the caller only acts on `true` when the retried
 * lookup actually finds a resource, so a false positive costs one extra read
 * and then rethrows the original error.
 */
export function isIdempotencyKeyViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("idempotency_keys") ||
    message.includes("UNIQUE") ||
    message.includes("PRIMARY KEY")
  );
}

/**
 * Whether this operation row is the one that created its resource (blueprint
 * B9).
 *
 * `versionBefore === 0` is the definition: the resource did not exist before
 * the operation, which is true of `create-customer` and `create-job` and of
 * nothing else. It is also the predicate `findCreateOperation` uses in SQL, so
 * the two agree by construction.
 *
 * B9 needs this in two places: `redoOperation` refuses to redo a create's undo
 * (a create's inverse is a compensation, not something to re-apply), and
 * `listRecentActivity` reports such an undo as not `redoable`.
 */
export function isCreateOperation(op: Operation): boolean {
  return op.versionBefore === 0;
}
