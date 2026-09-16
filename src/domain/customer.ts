/**
 * Customer domain model (blueprint B4).
 *
 * Plain object plus pure functions: no I/O, no `Date.now()` — time is always an
 * argument (`now`) so every caller controls it and tests stay deterministic.
 * Every mutation returns a new object; nothing here mutates its input.
 */

import { DomainError } from "./errors";

export type CustomerStatus = "active" | "archived";

export interface Customer {
  id: string;
  orgId: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  status: CustomerStatus;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewCustomerInput {
  id: string;
  orgId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  createdBy: string;
  now: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PHONE_LENGTH = 40;
const MAX_NOTES_LENGTH = 5000;
const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 200;

/** Trimmed length 1..200; the trimmed value is what gets stored. */
function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME_LENGTH || trimmed.length > MAX_NAME_LENGTH) {
    throw new DomainError(
      "VALIDATION",
      `Customer name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters`,
    );
  }
  return trimmed;
}

/** `null`/`undefined` mean "no email"; otherwise it must match the shared email
 * pattern and is stored lower-cased. */
function normalizeEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  if (!EMAIL_PATTERN.test(email)) {
    throw new DomainError(
      "VALIDATION",
      "Customer email must be a valid email address",
    );
  }
  return email.toLowerCase();
}

function normalizePhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return null;
  if (phone.length > MAX_PHONE_LENGTH) {
    throw new DomainError(
      "VALIDATION",
      `Customer phone must be at most ${MAX_PHONE_LENGTH} characters`,
    );
  }
  return phone;
}

function normalizeNotes(notes: string | null | undefined): string | null {
  if (notes === null || notes === undefined) return null;
  if (notes.length > MAX_NOTES_LENGTH) {
    throw new DomainError(
      "VALIDATION",
      `Customer notes must be at most ${MAX_NOTES_LENGTH} characters`,
    );
  }
  return notes;
}

export function createCustomer(input: NewCustomerInput): Customer {
  return {
    id: input.id,
    orgId: input.orgId,
    name: normalizeName(input.name),
    email: normalizeEmail(input.email),
    phone: normalizePhone(input.phone),
    notes: normalizeNotes(input.notes),
    status: "active",
    version: 1,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function archiveCustomer(c: Customer, now: string): Customer {
  if (c.status === "archived") {
    throw new DomainError(
      "INVARIANT",
      "Cannot archive a customer that is archived",
    );
  }
  return { ...c, status: "archived", version: c.version + 1, updatedAt: now };
}

export function restoreCustomer(c: Customer, now: string): Customer {
  if (c.status === "active") {
    throw new DomainError(
      "INVARIANT",
      "Cannot restore a customer that is active",
    );
  }
  return { ...c, status: "active", version: c.version + 1, updatedAt: now };
}
