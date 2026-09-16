import { describe, expect, it } from "vitest";

import {
  archiveCustomer,
  createCustomer,
  DomainError,
  restoreCustomer,
  type Customer,
  type NewCustomerInput,
} from "../../../src/domain";

const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";

function baseInput(
  overrides: Partial<NewCustomerInput> = {},
): NewCustomerInput {
  return {
    id: "cus_1",
    orgId: "org_1",
    name: "Acme Services",
    createdBy: "owner@example.invalid",
    now,
    ...overrides,
  };
}

describe("createCustomer", () => {
  it("creates an active customer at version 1 with null optional fields", () => {
    const customer = createCustomer(baseInput());
    expect(customer).toEqual<Customer>({
      id: "cus_1",
      orgId: "org_1",
      name: "Acme Services",
      email: null,
      phone: null,
      notes: null,
      status: "active",
      version: 1,
      createdBy: "owner@example.invalid",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("trims the name and stores the trimmed value", () => {
    const customer = createCustomer(baseInput({ name: "  Acme Services  " }));
    expect(customer.name).toBe("Acme Services");
  });

  it("rejects a name that is empty after trimming", () => {
    expect(() => createCustomer(baseInput({ name: "   " }))).toThrow(
      DomainError,
    );
    expect(() => createCustomer(baseInput({ name: "   " }))).toThrow(
      "Customer name must be between 1 and 200 characters",
    );
  });

  it("rejects a name longer than 200 characters", () => {
    expect(() => createCustomer(baseInput({ name: "a".repeat(201) }))).toThrow(
      "Customer name must be between 1 and 200 characters",
    );
  });

  it("accepts a name at the 200 character boundary", () => {
    const customer = createCustomer(baseInput({ name: "a".repeat(200) }));
    expect(customer.name).toHaveLength(200);
  });

  it("lower-cases a valid email and stores it", () => {
    const customer = createCustomer(
      baseInput({ email: "Owner@Example.Invalid" }),
    );
    expect(customer.email).toBe("owner@example.invalid");
  });

  it("rejects a malformed email", () => {
    expect(() => createCustomer(baseInput({ email: "not-an-email" }))).toThrow(
      "Customer email must be a valid email address",
    );
  });

  it("accepts a phone at the 40 character boundary", () => {
    const customer = createCustomer(baseInput({ phone: "1".repeat(40) }));
    expect(customer.phone).toHaveLength(40);
  });

  it("rejects a phone longer than 40 characters", () => {
    expect(() => createCustomer(baseInput({ phone: "1".repeat(41) }))).toThrow(
      "Customer phone must be at most 40 characters",
    );
  });

  it("accepts notes at the 5000 character boundary", () => {
    const customer = createCustomer(baseInput({ notes: "n".repeat(5000) }));
    expect(customer.notes).toHaveLength(5000);
  });

  it("rejects notes longer than 5000 characters", () => {
    expect(() =>
      createCustomer(baseInput({ notes: "n".repeat(5001) })),
    ).toThrow("Customer notes must be at most 5000 characters");
  });
});

describe("archiveCustomer", () => {
  it("archives an active customer and bumps the version", () => {
    const customer = createCustomer(baseInput());
    const archived = archiveCustomer(customer, later);
    expect(archived.status).toBe("archived");
    expect(archived.version).toBe(2);
    expect(archived.updatedAt).toBe(later);
  });

  it("refuses to archive an already-archived customer", () => {
    const archived = archiveCustomer(createCustomer(baseInput()), later);
    expect(() => archiveCustomer(archived, later)).toThrow(DomainError);
    expect(() => archiveCustomer(archived, later)).toThrow(
      "Cannot archive a customer that is archived",
    );
  });
});

describe("restoreCustomer", () => {
  it("restores an archived customer to active and bumps the version", () => {
    const archived = archiveCustomer(createCustomer(baseInput()), later);
    const restored = restoreCustomer(archived, "2026-01-03T00:00:00.000Z");
    expect(restored.status).toBe("active");
    expect(restored.version).toBe(3);
    expect(restored.updatedAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("refuses to restore an already-active customer", () => {
    const customer = createCustomer(baseInput());
    expect(() => restoreCustomer(customer, later)).toThrow(DomainError);
    expect(() => restoreCustomer(customer, later)).toThrow(
      "Cannot restore a customer that is active",
    );
  });
});
