/**
 * `archive-customer` (blueprint B8, B6).
 *
 * The admin-only demonstration: `customers:archive` is the one customer
 * capability a `member` does not have (B6). Reversible — the recorded inverse
 * restores the customer — and refused outright when the customer is already
 * archived, which is the domain's rule, not this file's.
 *
 * `expectedVersion` is the caller's optimistic lock: when given, it must match
 * what is stored *now*, before anything is written. The repository re-checks
 * the same version inside the atomic write, so a change that lands between
 * this read and that write is still refused.
 */

import type { Customer, Operation } from "../../domain";
import { archiveCustomer as archiveCustomerDomain } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";
import { applyDomain, type CommandResult } from "./command";

export interface ArchiveCustomerInput {
  customerId: string;
  /** Version the caller last saw; the call fails with CONFLICT if it changed. */
  expectedVersion?: number;
}

export async function archiveCustomer(
  deps: Dependencies,
  actor: Actor,
  input: ArchiveCustomerInput,
): Promise<CommandResult<Customer>> {
  requireCapability(actor, "customers:archive");

  const customer = await deps.customers.getById(actor.orgId, input.customerId);
  if (!customer) throw new AppError("NOT_FOUND", "Customer not found");
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== customer.version
  ) {
    throw new AppError("CONFLICT", "The customer was changed by someone else");
  }

  const now = deps.clock.now();
  const next = applyDomain(() => archiveCustomerDomain(customer, now));

  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "archive-customer",
    resourceType: "customer",
    resourceId: customer.id,
    classification: "reversible",
    versionBefore: customer.version,
    versionAfter: next.version,
    payload: {},
    inverse: { type: "restore-customer" },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };

  await deps.customers.commit({
    customer: next,
    expectedVersion: customer.version,
    operation,
  });

  return { resource: next, operationId: operation.id };
}
