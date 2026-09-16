/**
 * `create-customer` (blueprint B8, decision D14).
 *
 * A create is *compensatable*, not reversible: there is no delete anywhere in
 * this application, so undoing one archives the customer instead. That is what
 * the recorded inverse says, and it is why `versionBefore` is 0 — the resource
 * did not exist before this operation.
 *
 * `idempotencyKey` makes a retried call safe (D14). The key is looked up
 * first; the write that follows carries the key in the same atomic batch as
 * the customer and its operation row, so a key can never name a customer that
 * was not created. Two callers can still pass the lookup at the same time, and
 * the one whose insert loses the primary key on `idempotency_keys` retries the
 * lookup once rather than reporting a database error.
 */

import type { Customer, Operation } from "../../domain";
import { createCustomer as createCustomerDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import {
  applyDomain,
  isIdempotencyKeyViolation,
  type CommandResult,
} from "./command";

const ACTION = "create-customer";

export interface CreateCustomerInput {
  name: string;
  email?: string;
  phone?: string;
  notes?: string;
  /** Repeat the same key to retry safely: the second call returns the customer
   * the first one created. */
  idempotencyKey?: string;
}

/**
 * The result of the create this `(action, key)` already performed, or `null`
 * when the key has not been used in this organization yet.
 *
 * A key that names a customer whose creating operation cannot be found is an
 * inconsistency the atomic write is designed to make impossible, so it is
 * reported as `INTERNAL` rather than answered with a second create.
 */
async function findCompletedCreate(
  deps: Dependencies,
  orgId: string,
  key: string,
): Promise<CommandResult<Customer> | null> {
  const resourceId = await deps.idempotency.find(orgId, ACTION, key);
  if (resourceId === null) return null;

  const customer = await deps.customers.getById(orgId, resourceId);
  const created = await deps.operations.findCreateOperation(
    orgId,
    "customer",
    resourceId,
  );
  if (!customer || !created) {
    throw new AppError("INTERNAL", "Unexpected error");
  }
  return { resource: customer, operationId: created.id };
}

export async function createCustomer(
  deps: Dependencies,
  actor: Actor,
  input: CreateCustomerInput,
): Promise<CommandResult<Customer>> {
  requireCapability(actor, "customers:create");

  const { idempotencyKey, ...payload } = input;

  if (idempotencyKey !== undefined) {
    const existing = await findCompletedCreate(
      deps,
      actor.orgId,
      idempotencyKey,
    );
    if (existing) return existing;
  }

  const now = deps.clock.now();
  const customer = applyDomain(() =>
    createCustomerDomain({
      id: deps.ids.next(),
      orgId: actor.orgId,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      notes: input.notes ?? null,
      createdBy: actor.userEmail,
      now,
    }),
  );

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: ACTION,
    resourceType: "customer",
    resourceId: customer.id,
    classification: "compensatable",
    versionBefore: 0,
    versionAfter: customer.version,
    payload,
    inverse: { type: "archive-customer" },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  try {
    await deps.customers.create({
      customer,
      operation,
      ...(idempotencyKey !== undefined
        ? { idempotency: { action: ACTION, key: idempotencyKey } }
        : {}),
    });
  } catch (err) {
    if (idempotencyKey !== undefined && isIdempotencyKeyViolation(err)) {
      const existing = await findCompletedCreate(
        deps,
        actor.orgId,
        idempotencyKey,
      );
      if (existing) return existing;
    }
    throw err;
  }

  return { resource: customer, operationId: operation.id };
}
