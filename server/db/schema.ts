// Typed mirror of the app-owned tables in `migrations/` (blueprint B10).
//
// This file is NOT the source of truth for the schema and it never creates or alters a
// table: `migrations/*.sql` is applied by `scripts/migrate.mjs`, in whichever dialect
// `DATABASE_URL` names (D05). Repositories issue raw
// parameterized SQL through `getDbExec()` rather than Drizzle (D07).
//
// It exists for two reasons: `createGetDb(schema)` in `./index.ts` needs a schema object,
// and `agent-native doctor`'s `db-tool-scoping` guard reads this file to confirm every
// app table carries `org_id`, which is what makes the agent's raw database tools safe.
//
// Constraints that Drizzle cannot express here (CHECK constraints, the composite
// `PRIMARY KEY (org_id, action, key)` on `idempotency_keys`, the compound foreign key from
// `seating_tables` to `events`, and the indexes) live in the migration only. Columns and
// their nullability are mirrored exactly.

import { integer, table, text } from "@agent-native/core/db/schema";

export const events = table("events", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  startsAt: text("starts_at").notNull(),
  // The floor this event's tables stand on, in grid cells.
  roomWidth: integer("room_width").notNull(),
  roomHeight: integer("room_height").notNull(),
  status: text("status", { enum: ["active", "archived"] }).notNull(),
  version: integer("version").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const seatingTables = table("seating_tables", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  eventId: text("event_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["rectangle", "round"] }).notNull(),
  // A rectangle's length, or a round table's diameter, in cells.
  size: integer("size").notNull(),
  // SQLite has no boolean; 0 or 1, per the migration's CHECK. Always 0 for a
  // round table, which has no ends to seat.
  endSeats: integer("end_seats").notNull(),
  // Quarter turns clockwise: 0, 90, 180 or 270. Always 0 for a round table,
  // whose square body turns into itself.
  rotation: integer("rotation").notNull(),
  gridX: integer("grid_x").notNull(),
  gridY: integer("grid_y").notNull(),
  // JSON text: the ordered seat list, `{label, present}` each. The footprint
  // is derived from the shape, so no width or height is stored.
  seats: text("seats").notNull(),
  status: text("status", { enum: ["active", "archived"] }).notNull(),
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
  resourceType: text("resource_type", {
    enum: ["event", "seating_table"],
  }).notNull(),
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
