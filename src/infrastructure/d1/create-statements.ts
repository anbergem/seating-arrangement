/**
 * The two statements a `create` shares between customers and jobs (B11).
 *
 * Both repositories write the same three-statement batch — insert the
 * resource, then its audit row, then the optional idempotency key — and the
 * last two differ only in which table the first statement touched. They live
 * here so the argument order, which is the easy thing to get wrong, is written
 * once.
 */

import type { Operation } from "../../domain";
import type { Statement } from "./atomic";
import { operationInsertArgs } from "./mappers";
import {
  INSERT_IDEMPOTENCY_KEY,
  INSERT_OPERATION_IF_RESOURCE_EXISTS,
} from "./sql";

/**
 * The audit row for a create, guarded on the resource the statement before it
 * was meant to insert being there — so an insert the database refused (an
 * archived customer, a replayed create) leaves no history behind.
 *
 * The guard has one branch per resource type and the type is passed twice, so
 * exactly one branch can match.
 */
export function operationForCreateStatement(operation: Operation): Statement {
  return {
    sql: INSERT_OPERATION_IF_RESOURCE_EXISTS,
    args: [
      ...operationInsertArgs(operation),
      operation.orgId,
      operation.resourceId,
      operation.resourceType,
      operation.orgId,
      operation.resourceId,
      operation.resourceType,
    ],
  };
}

/**
 * Records that this `(action, key)` produced this resource, guarded on the
 * audit row above having been written. A key must never outlive a create that
 * did not happen: the caller's retry would then be answered with the id of a
 * resource that does not exist (D14).
 */
export function idempotencyKeyStatement(
  operation: Operation,
  idempotency: { action: string; key: string },
  createdAt: string,
): Statement {
  return {
    sql: INSERT_IDEMPOTENCY_KEY,
    args: [
      operation.orgId,
      idempotency.action,
      idempotency.key,
      operation.resourceId,
      createdAt,
      operation.orgId,
      operation.id,
    ],
  };
}
