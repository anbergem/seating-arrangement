/**
 * Database rows in, domain objects out (blueprint B11).
 *
 * Rows arrive as plain objects with snake_case keys and driver-dependent value
 * types — D1 and libsql agree on strings but not always on how an INTEGER
 * comes back — so every field goes through a coercion that states what the
 * column is, rather than being trusted and cast. A row that cannot produce a
 * valid domain object is a bug in a migration or a writer, and `text()` and
 * friends throw so it surfaces at the one place that can name the column.
 *
 * The two JSON columns are the exception: `payload` and `inverse` hold text
 * this application wrote, but a hand-edited row or a half-written value must
 * not take down a whole activity list. Invalid JSON becomes `null` and a
 * warning naming the row (never its contents) — the operation stays visible in
 * history, it just cannot be undone.
 */

import type { AccountingExport } from "../../application/ports";
import type { AccountingInvoiceDraft } from "../../application/ports/external-accounting";
import type {
  Customer,
  CustomerStatus,
  InverseCommand,
  Job,
  JobStatus,
  Operation,
  OperationClassification,
  OperationKind,
  ResourceType,
} from "../../domain";
import { logWarning } from "../logging";

export type Row = Record<string, unknown>;

function fail(column: string, value: unknown): never {
  // The value is not in the message: a column that holds user text would end
  // up in a log line, and the column name is what a fix needs anyway.
  throw new Error(
    `database row: column "${column}" has an unusable ${typeof value} value`,
  );
}

function text(row: Row, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : fail(column, value);
}

function nullableText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : fail(column, value);
}

/** SQLite INTEGER columns come back as `number` on better-sqlite3 and may come
 * back as `bigint` depending on the driver's integer mode, so both are
 * accepted and narrowed to `number`. */
function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return fail(column, value);
}

/** The column is a CHECK-constrained enum in the schema (B10); this is the
 * TypeScript half of the same constraint. */
function enumeration<T extends string>(
  row: Row,
  column: string,
  allowed: readonly T[],
): T {
  const value = text(row, column);
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fail(column, value);
}

const CUSTOMER_STATUSES: readonly CustomerStatus[] = ["active", "archived"];
const JOB_STATUSES: readonly JobStatus[] = [
  "scheduled",
  "in_progress",
  "completed",
  "archived",
];
const OPERATION_KINDS: readonly OperationKind[] = ["forward", "undo", "redo"];
const RESOURCE_TYPES: readonly ResourceType[] = ["customer", "job"];
const CLASSIFICATIONS: readonly OperationClassification[] = [
  "reversible",
  "compensatable",
  "irreversible",
];

/**
 * Parses one of the two JSON columns. `null` in, `null` out; anything that is
 * not a JSON object (invalid text, or a bare string or array) is reported and
 * treated as absent, because every value this application stores in these
 * columns is an object.
 */
function jsonObject(
  row: Row,
  column: string,
  operationId: string,
  orgId: string,
): Record<string, unknown> | null {
  const raw = nullableText(row, column);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logWarning({
      event: "invalid-json-column",
      message: `operations.${column} is not valid JSON; the operation is readable but cannot be replayed`,
      orgId,
      details: { operationId, column },
    });
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    logWarning({
      event: "invalid-json-column",
      message: `operations.${column} is valid JSON but not an object; the operation is readable but cannot be replayed`,
      orgId,
      details: { operationId, column },
    });
    return null;
  }
  return parsed as Record<string, unknown>;
}

export function toCustomer(row: Row): Customer {
  return {
    id: text(row, "id"),
    orgId: text(row, "org_id"),
    name: text(row, "name"),
    email: nullableText(row, "email"),
    phone: nullableText(row, "phone"),
    notes: nullableText(row, "notes"),
    status: enumeration(row, "status", CUSTOMER_STATUSES),
    version: integer(row, "version"),
    createdBy: text(row, "created_by"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

export function toJob(row: Row): Job {
  return {
    id: text(row, "id"),
    orgId: text(row, "org_id"),
    customerId: text(row, "customer_id"),
    title: text(row, "title"),
    description: text(row, "description"),
    status: enumeration(row, "status", JOB_STATUSES),
    scheduledAt: text(row, "scheduled_at"),
    assignedTo: nullableText(row, "assigned_to"),
    completedAt: nullableText(row, "completed_at"),
    archivedAt: nullableText(row, "archived_at"),
    accountingReference: nullableText(row, "accounting_reference"),
    accountingSentAt: nullableText(row, "accounting_sent_at"),
    version: integer(row, "version"),
    createdBy: text(row, "created_by"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

export function toAccountingExport(row: Row): AccountingExport {
  const raw = text(row, "request_json");
  let request: unknown;
  try {
    request = JSON.parse(raw);
  } catch {
    throw new Error("database row: accounting export request_json is invalid");
  }
  return {
    orgId: text(row, "org_id"),
    jobId: text(row, "job_id"),
    idempotencyKey: text(row, "idempotency_key"),
    request: request as AccountingInvoiceDraft,
    status: enumeration(row, "status", ["pending", "completed"] as const),
    externalReference: nullableText(row, "external_reference"),
    operationId: nullableText(row, "operation_id"),
    requestedBy: text(row, "requested_by"),
    requestedAt: text(row, "requested_at"),
    completedAt: nullableText(row, "completed_at"),
  };
}

export function toOperation(row: Row): Operation {
  const id = text(row, "id");
  const orgId = text(row, "org_id");
  const inverse = jsonObject(row, "inverse", id, orgId);
  return {
    id,
    orgId,
    kind: enumeration(row, "kind", OPERATION_KINDS),
    action: text(row, "action"),
    resourceType: enumeration(row, "resource_type", RESOURCE_TYPES),
    resourceId: text(row, "resource_id"),
    classification: enumeration(row, "classification", CLASSIFICATIONS),
    versionBefore: integer(row, "version_before"),
    versionAfter: integer(row, "version_after"),
    payload: jsonObject(row, "payload", id, orgId),
    // The shape is this application's own write, checked by the domain's
    // discriminated union at the point of use (`undoOperation`, T10).
    inverse: inverse === null ? null : (inverse as unknown as InverseCommand),
    relatedOperationId: nullableText(row, "related_operation_id"),
    undoneByOperationId: nullableText(row, "undone_by_operation_id"),
    performedBy: text(row, "performed_by"),
    performedVia: text(row, "performed_via"),
    performedAt: text(row, "performed_at"),
  };
}

/** Rows come back as `unknown[]`; every statement in `sql.ts` selects an
 * explicit column list, so each element is one of the row shapes above. */
export function mapRows<T>(rows: unknown[], map: (row: Row) => T): T[] {
  return rows.map((row) => map(row as Row));
}

/**
 * The other direction, for the one write shape all three operation inserts
 * share: the values in `OPERATION_INSERT_VALUES` order, minus
 * `undone_by_operation_id`, which every insert writes as a literal `NULL`.
 * Each caller appends its own guard arguments after these.
 */
export function operationInsertArgs(operation: Operation): unknown[] {
  return [
    operation.id,
    operation.orgId,
    operation.kind,
    operation.action,
    operation.resourceType,
    operation.resourceId,
    operation.classification,
    operation.versionBefore,
    operation.versionAfter,
    operation.payload === null ? null : JSON.stringify(operation.payload),
    operation.inverse === null ? null : JSON.stringify(operation.inverse),
    operation.relatedOperationId,
    operation.performedBy,
    operation.performedVia,
    operation.performedAt,
  ];
}
