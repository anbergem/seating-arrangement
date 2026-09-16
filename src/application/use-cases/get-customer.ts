/**
 * `get-customer` (blueprint B8).
 *
 * A customer in another organization is reported as NOT_FOUND, not as
 * AUTHORIZATION: the repository scopes every read by `orgId`, so this use case
 * cannot even tell the two apart — which is the point (D10). A caller must not
 * be able to learn that an id exists somewhere else.
 */

import type { Customer } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";

export interface GetCustomerInput {
  customerId: string;
}

export async function getCustomer(
  deps: Dependencies,
  actor: Actor,
  input: GetCustomerInput,
): Promise<Customer> {
  requireCapability(actor, "customers:read");

  const customer = await deps.customers.getById(actor.orgId, input.customerId);
  if (!customer) throw new AppError("NOT_FOUND", "Customer not found");
  return customer;
}
