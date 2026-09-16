/**
 * `list-customers` (blueprint B8).
 *
 * Archived customers are hidden unless the caller asks for them: an archived
 * customer is still a real record — jobs point at it and its history is
 * readable — it just does not belong in the list someone picks a customer
 * from.
 */

import type { Customer, CustomerStatus } from "../../domain";
import type { Actor } from "../actor";
import { requireCapability } from "../authorization";
import type { Dependencies } from "../ports";

export interface ListCustomersInput {
  /** `false`/absent lists only active customers; `true` lists every one. */
  includeArchived?: boolean;
  /** Case-insensitive substring of the customer name. */
  search?: string;
}

export async function listCustomers(
  deps: Dependencies,
  actor: Actor,
  input: ListCustomersInput = {},
): Promise<Customer[]> {
  requireCapability(actor, "customers:read");

  const filter: { status?: CustomerStatus; search?: string } = {};
  if (input.includeArchived !== true) filter.status = "active";
  // A blank search is no search: passing it on would mean `LIKE '%%'` in one
  // repository and no filter at all in the other.
  const search = input.search?.trim();
  if (search) filter.search = search;

  return deps.customers.list(actor.orgId, filter);
}
