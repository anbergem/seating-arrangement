/**
 * Database rows in, domain objects out (blueprint B11).
 *
 * Rows arrive as plain objects with snake_case keys and driver-dependent value
 * types — PostgreSQL and SQLite agree on strings but not always on how an INTEGER
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

import type {
  Event,
  EventStatus,
  InverseCommand,
  Operation,
  OperationClassification,
  OperationKind,
  ResourceType,
  Seat,
  Rotation,
  SeatingTable,
  SeatingTableStatus,
  TableShape,
  TableShapeKind,
} from "../../domain";
import { ROTATIONS, seatCount, TABLE_SHAPE_KINDS } from "../../domain";
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

/** SQLite has no boolean: the column is `INTEGER NOT NULL CHECK (c IN (0, 1))`
 * and comes back as a number, or as a bigint on a driver in that integer mode.
 * A value outside 0/1 is a corrupt row, not a truthiness question. */
function boolean(row: Row, column: string): boolean {
  const value = integer(row, column);
  if (value === 0) return false;
  if (value === 1) return true;
  return fail(column, row[column]);
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

const OPERATION_KINDS: readonly OperationKind[] = ["forward", "undo", "redo"];
const RESOURCE_TYPES: readonly ResourceType[] = ["event", "seating_table"];
const EVENT_STATUSES: readonly EventStatus[] = ["active", "archived"];
const SEATING_TABLE_STATUSES: readonly SeatingTableStatus[] = [
  "active",
  "archived",
];
const SHAPE_KINDS: readonly TableShapeKind[] = TABLE_SHAPE_KINDS;
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

/**
 * Parses the `seats` column, strictly.
 *
 * Unlike `operations.payload`, this is not optional decoration: a seating table
 * whose seats cannot be read is not a domain object at all, so a bad value
 * throws the way every other column does rather than degrading to `null`. The
 * seat list is also cross-checked against the columns that determine its
 * shape, so a row whose JSON and whose `kind`/`size`/`end_seats` disagree is
 * refused here instead of producing a table that renders wrong.
 */
/** The arm lengths, as stored. Their number and range are the domain's
 * business; all this insists on is a short array of whole numbers. */
/**
 * The authored half of each seat, in the same clockwise order the shape
 * derives. The count is cross-checked against the shape, so a row whose seats
 * and whose kind, size and end seats disagree is refused here rather than
 * rendering wrong.
 */
function seats(row: Row, shape: TableShape): Seat[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(row, "seats"));
  } catch {
    return fail("seats", row.seats);
  }
  if (!Array.isArray(parsed) || parsed.length !== seatCount(shape)) {
    return fail("seats", row.seats);
  }
  return parsed.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return fail("seats", row.seats);
    }
    const label = (entry as Record<string, unknown>).label;
    if (typeof label !== "string") {
      return fail("seats", row.seats);
    }
    return { label };
  });
}

export function toEvent(row: Row): Event {
  return {
    id: text(row, "id"),
    orgId: text(row, "org_id"),
    name: text(row, "name"),
    startsAt: text(row, "starts_at"),
    roomWidth: integer(row, "room_width"),
    roomHeight: integer(row, "room_height"),
    status: enumeration(row, "status", EVENT_STATUSES),
    version: integer(row, "version"),
    createdBy: text(row, "created_by"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

export function toSeatingTable(row: Row): SeatingTable {
  const rotation = integer(row, "rotation");
  if (!(ROTATIONS as readonly number[]).includes(rotation)) {
    fail("rotation", row.rotation);
  }
  const shape: TableShape = {
    kind: enumeration(row, "kind", SHAPE_KINDS),
    size: integer(row, "size"),
    endSeats: boolean(row, "end_seats"),
    rotation: rotation as Rotation,
  };
  return {
    id: text(row, "id"),
    orgId: text(row, "org_id"),
    eventId: text(row, "event_id"),
    name: text(row, "name"),
    ...shape,
    gridX: integer(row, "grid_x"),
    gridY: integer(row, "grid_y"),
    seats: seats(row, shape),
    status: enumeration(row, "status", SEATING_TABLE_STATUSES),
    version: integer(row, "version"),
    createdBy: text(row, "created_by"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

/** The writer-side argument order for `INSERT_EVENT`, written once. */
export function eventInsertArgs(event: Event): unknown[] {
  return [
    event.id,
    event.orgId,
    event.name,
    event.startsAt,
    event.roomWidth,
    event.roomHeight,
    event.status,
    event.version,
    event.createdBy,
    event.createdAt,
    event.updatedAt,
  ];
}

/** The writer-side argument order for `UPDATE_EVENT_VERSIONED`'s SET list,
 * written once. The three guard arguments are the caller's. */
export function eventUpdateArgs(event: Event): unknown[] {
  return [
    event.name,
    event.startsAt,
    event.roomWidth,
    event.roomHeight,
    event.status,
    event.version,
    event.updatedAt,
  ];
}

/** The writer-side argument order for `INSERT_SEATING_TABLE_IF_ACTIVE_EVENT`,
 * written once. */
export function seatingTableInsertArgs(table: SeatingTable): unknown[] {
  return [
    table.id,
    table.orgId,
    table.eventId,
    table.name,
    table.kind,
    table.size,
    table.endSeats ? 1 : 0,
    table.rotation,
    table.gridX,
    table.gridY,
    JSON.stringify(table.seats),
    table.status,
    table.version,
    table.createdBy,
    table.createdAt,
    table.updatedAt,
  ];
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
