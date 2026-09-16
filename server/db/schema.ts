// Typed mirror of the app-owned tables in `migrations/0001_init.sql` (blueprint B10).
//
// This file is NOT the source of truth for the schema and it never creates or alters a
// table: `migrations/*.sql` is applied by `wrangler d1 migrations apply` on D1 and by
// `scripts/migrate-local.mjs` on the local SQLite file (D05). Repositories issue raw
// parameterized SQL through `getDbExec()` rather than Drizzle (D07).
//
// It exists for two reasons: `createGetDb(schema)` in `./index.ts` needs a schema object,
// and `agent-native doctor`'s `db-tool-scoping` guard reads this file to confirm every
// app table carries `org_id`, which is what makes the agent's raw database tools safe.
//
// Constraints that Drizzle cannot express here (CHECK constraints, the composite
// `PRIMARY KEY (org_id, action, key)` on `idempotency_keys`, the compound foreign key from
// `jobs` to `customers`, and the indexes) live in the migration only. Columns and their
// nullability are mirrored exactly.

import { integer, table, text } from "@agent-native/core/db/schema";

export const customers = table("customers", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  notes: text("notes"),
  status: text("status", { enum: ["active", "archived"] }).notNull(),
  version: integer("version").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const jobs = table("jobs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  customerId: text("customer_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status", {
    enum: ["scheduled", "in_progress", "completed", "archived"],
  }).notNull(),
  scheduledAt: text("scheduled_at").notNull(),
  assignedTo: text("assigned_to"),
  completedAt: text("completed_at"),
  archivedAt: text("archived_at"),
  accountingReference: text("accounting_reference"),
  accountingSentAt: text("accounting_sent_at"),
  version: integer("version").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const operations = table("operations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  kind: text("kind", { enum: ["forward", "undo", "redo"] }).notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type", { enum: ["customer", "job"] }).notNull(),
  resourceId: text("resource_id").notNull(),
  classification: text("classification", {
    enum: ["reversible", "compensatable", "irreversible"],
  }).notNull(),
  versionBefore: integer("version_before").notNull(),
  versionAfter: integer("version_after").notNull(),
  // JSON text.
  payload: text("payload"),
  // JSON text.
  inverse: text("inverse"),
  relatedOperationId: text("related_operation_id"),
  undoneByOperationId: text("undone_by_operation_id"),
  performedBy: text("performed_by").notNull(),
  performedVia: text("performed_via").notNull(),
  performedAt: text("performed_at").notNull(),
});

export const idempotencyKeys = table("idempotency_keys", {
  orgId: text("org_id").notNull(),
  action: text("action").notNull(),
  key: text("key").notNull(),
  resourceId: text("resource_id").notNull(),
  createdAt: text("created_at").notNull(),
});

export const accountingExports = table("accounting_exports", {
  orgId: text("org_id").notNull(),
  jobId: text("job_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestJson: text("request_json").notNull(),
  status: text("status", { enum: ["pending", "completed"] }).notNull(),
  externalReference: text("external_reference"),
  operationId: text("operation_id"),
  requestedBy: text("requested_by").notNull(),
  requestedAt: text("requested_at").notNull(),
  completedAt: text("completed_at"),
});
