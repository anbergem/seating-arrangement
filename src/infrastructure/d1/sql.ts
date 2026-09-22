/**
 * Every SQL statement this application issues (blueprint B11, decision D07).
 *
 * One module, one constant per statement, no string building anywhere else:
 * `tests/unit/infrastructure/sql-scoping.test.ts` iterates every exported
 * string and asserts it contains the literal `org_id = ?`, which is the whole
 * tenancy guarantee. The framework's own `no-unscoped-queries` guard does not
 * see these tables, so that test plus the `?` placeholders below are what keep
 * one organization's rows away from another's.
 *
 * Two shapes recur and are worth reading once:
 *
 * - Guarded insert — `INSERT INTO t (...) SELECT ?, ?, … WHERE EXISTS (…)`.
 *   D1 has no interactive transactions, so a precondition cannot be checked in
 *   application code between two statements; it is expressed inside the
 *   statement instead. The insert then affects zero rows when the guard fails,
 *   and the caller decides what that means (B11).
 * - Versioned update — `… WHERE org_id = ? AND id = ? AND version = ?`. A
 *   stale write affects zero rows rather than overwriting a newer one, and the
 *   audit-row insert that shares its batch carries the same predicate, so it is
 *   a no-op too and the batch as a whole writes nothing.
 *
 * Column lists are always explicit: `SELECT *` would break `mappers.ts`
 * silently the day a migration adds a column.
 */

const OPERATION_COLUMNS =
  "id, org_id, kind, action, resource_type, resource_id, classification, version_before, version_after, payload, inverse, related_operation_id, undone_by_operation_id, performed_by, performed_via, performed_at";

const OPERATION_INSERT_VALUES =
  "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?";

// ---------------------------------------------------------------------------
// Operations (the audit and undo log, B9)
// ---------------------------------------------------------------------------

/** `undone_by_operation_id` is `NULL` in every insert: an operation is marked
 * undone later, by `MARK_OPERATION_UNDONE`, never at birth. */

/**
 * Second statement of a `create`, where there is no previous version to guard
 * on: the audit row is written only if the row the insert before it was meant
 * to produce is really there.
 *
 * One statement covers every resource type by comparing the operation's own
 * `resource_type` against a literal in each branch, so exactly one branch can
 * ever match. Arguments after the insert values are
 * `(orgId, resourceId, resourceType)` once per branch, in the order the
 * branches appear: events, then seating tables.
 */
export const INSERT_OPERATION_IF_RESOURCE_EXISTS = `INSERT INTO operations (${OPERATION_COLUMNS})
SELECT ${OPERATION_INSERT_VALUES}
WHERE EXISTS (SELECT 1 FROM events WHERE org_id = ? AND id = ? AND ? = 'event')
   OR EXISTS (SELECT 1 FROM seating_tables WHERE org_id = ? AND id = ? AND ? = 'seating_table')`;

/**
 * Records which operation reversed an earlier one (B9).
 *
 * `undone_by_operation_id IS NULL` makes a double undo a no-op rather than a
 * silent rewrite of which operation reversed this one. The `EXISTS` clause
 * guards on the undoing operation itself — the row the statement before this
 * one inserts — so a batch whose version guard failed cannot still mark an
 * operation undone by an audit row that was never written.
 */
export const MARK_OPERATION_UNDONE = `UPDATE operations
SET undone_by_operation_id = ?
WHERE org_id = ? AND id = ? AND undone_by_operation_id IS NULL
  AND EXISTS (SELECT 1 FROM operations WHERE org_id = ? AND id = ?)`;

export const SELECT_OPERATION_BY_ID = `SELECT ${OPERATION_COLUMNS} FROM operations WHERE org_id = ? AND id = ? LIMIT 1`;

/** Newest first. `id` breaks ties so a page boundary is stable when two
 * operations share a millisecond. */
export const SELECT_RECENT_OPERATIONS = `SELECT ${OPERATION_COLUMNS} FROM operations
WHERE org_id = ?
ORDER BY performed_at DESC, id DESC
LIMIT ?`;

export const SELECT_OPERATIONS_FOR_RESOURCE = `SELECT ${OPERATION_COLUMNS} FROM operations
WHERE org_id = ? AND resource_type = ? AND resource_id = ?
ORDER BY performed_at DESC, id DESC
LIMIT ?`;

/**
 * The operation that created a resource, for an idempotent create's replay
 * (B7, B8). `version_before = 0` is what identifies a create: the resource did
 * not exist before it, and nothing else can be written with that value. The
 * `kind = 'forward'` literal excludes an undo or redo row, which is the same
 * kind of fixed enum comparison the guards in this module already carry.
 *
 * No `ORDER BY`: the pair of predicates matches at most one row per resource.
 */
export const SELECT_CREATE_OPERATION = `SELECT ${OPERATION_COLUMNS} FROM operations
WHERE org_id = ? AND resource_type = ? AND resource_id = ? AND kind = 'forward' AND version_before = 0
LIMIT 1`;

// ---------------------------------------------------------------------------
// Idempotency keys (D14: creates only)
// ---------------------------------------------------------------------------

/**
 * Last statement of a guarded `create`, and guarded itself on the operation
 * row the statement before it writes. Without that guard a create that was
 * refused (an archived event, say) would still burn the key, and the
 * caller's retry would be answered with a resource id that was never created.
 *
 * A genuine duplicate key still violates the primary key and aborts the whole
 * batch, which is the right answer: the caller retries, `find` reports the
 * first call's resource, and nothing is created twice.
 */
export const INSERT_IDEMPOTENCY_KEY = `INSERT INTO idempotency_keys (org_id, action, key, resource_id, created_at)
SELECT ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM operations WHERE org_id = ? AND id = ?)`;

export const SELECT_IDEMPOTENCY_KEY = `SELECT resource_id FROM idempotency_keys
WHERE org_id = ? AND action = ? AND key = ?
LIMIT 1`;

// ---------------------------------------------------------------------------
// Membership (framework-owned table, F6)
// ---------------------------------------------------------------------------

/** The framework keeps no role on the request context (F6), so every action
 * resolves it here. `LOWER(email)` on both sides matches the framework's own
 * reader and its `org_members_org_lower_email_uidx` index. */
export const SELECT_MEMBER_ROLE = `SELECT role FROM org_members
WHERE org_id = ? AND LOWER(email) = LOWER(?)
LIMIT 1`;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EVENT_COLUMNS =
  "id, org_id, name, starts_at, room_width, room_height, status, version, created_by, created_at, updated_at";

export const SELECT_EVENT_BY_ID = `SELECT ${EVENT_COLUMNS} FROM events WHERE org_id = ? AND id = ? LIMIT 1`;

/** Prefix; `SELECT_EVENTS_PARTS` supplies the optional tail. */
export const SELECT_EVENTS = `SELECT ${EVENT_COLUMNS} FROM events WHERE org_id = ?`;

export const SELECT_EVENTS_PARTS = {
  status: " AND status = ?",
  order: " ORDER BY starts_at ASC, id ASC",
} as const;

/** `NOT EXISTS` makes a replayed create a no-op rather than a duplicate-key
 * error, the same way `INSERT_CUSTOMER` does. */
export const INSERT_EVENT = `INSERT INTO events (${EVENT_COLUMNS})
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE NOT EXISTS (SELECT 1 FROM events WHERE org_id = ? AND id = ?)`;

/** `starts_at` is mutable but `name` is not editable in this release; both are
 * in the SET list so a later rename needs no migration of this statement. */
export const UPDATE_EVENT_VERSIONED = `UPDATE events
SET name = ?, starts_at = ?, room_width = ?, room_height = ?, status = ?, version = ?, updated_at = ?
WHERE org_id = ? AND id = ? AND version = ?`;

export const INSERT_OPERATION_IF_EVENT_VERSION = `INSERT INTO operations (${OPERATION_COLUMNS})
SELECT ${OPERATION_INSERT_VALUES}
WHERE EXISTS (SELECT 1 FROM events WHERE org_id = ? AND id = ? AND version = ?)`;

// ---------------------------------------------------------------------------
// Seating tables
// ---------------------------------------------------------------------------

const SEATING_TABLE_COLUMNS =
  "id, org_id, event_id, name, kind, size, end_seats, rotation, grid_x, grid_y, seats, status, version, created_by, created_at, updated_at";

export const SELECT_SEATING_TABLE_BY_ID = `SELECT ${SEATING_TABLE_COLUMNS} FROM seating_tables WHERE org_id = ? AND id = ? LIMIT 1`;

/** Prefix; `SELECT_SEATING_TABLES_PARTS` supplies the optional tail. */
export const SELECT_SEATING_TABLES = `SELECT ${SEATING_TABLE_COLUMNS} FROM seating_tables WHERE org_id = ?`;

/** Ordered by creation, never by position: the scoping test allows a two-column
 * `ORDER BY`, and a stable order is all any caller needs — the floor plan is
 * laid out from `grid_x`/`grid_y`, not from row order. */
export const SELECT_SEATING_TABLES_PARTS = {
  eventId: " AND event_id = ?",
  status: " AND status = ?",
  order: " ORDER BY created_at ASC, id ASC",
} as const;

/**
 * A create's table row, guarded on its event existing in this organization and
 * still being active. The cells go in separately, and it is their primary key —
 * not anything here — that decides whether the space was free.
 */
export const INSERT_SEATING_TABLE_IF_ACTIVE_EVENT = `INSERT INTO seating_tables (${SEATING_TABLE_COLUMNS})
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM events WHERE org_id = ? AND id = ? AND status = 'active')`;

/** `event_id` is immutable after creation, so it is not in the SET list. */
export const UPDATE_SEATING_TABLE_VERSIONED = `UPDATE seating_tables
SET name = ?, kind = ?, size = ?, end_seats = ?, rotation = ?, grid_x = ?, grid_y = ?, seats = ?, status = ?, version = ?, updated_at = ?
WHERE org_id = ? AND id = ? AND version = ?`;

export const INSERT_OPERATION_IF_SEATING_TABLE_VERSION = `INSERT INTO operations (${OPERATION_COLUMNS})
SELECT ${OPERATION_INSERT_VALUES}
WHERE EXISTS (SELECT 1 FROM seating_tables WHERE org_id = ? AND id = ? AND version = ?)`;

// ---------------------------------------------------------------------------
// Floor-plan occupancy
//
// Every write that changes what a table covers clears its cells and writes them
// again, in the same atomic batch as the table row. Two rules hold that
// together:
//
//   * Both cell statements carry the **same version guard** as the audit row and
//     the update beside them, so a stale writer rewrites no cells either — the
//     batch is a collective no-op rather than a partial one. A create guards on
//     the table row existing instead, since there is no previous version.
//   * A cell already held by another table violates
//     `PRIMARY KEY (org_id, event_id, x, y)`, which aborts the whole batch. That
//     is the one invariant deliberately left to the database: it is about two
//     different rows, so no version guard could ever see it.
// ---------------------------------------------------------------------------

export const DELETE_SEATING_CELLS_IF_VERSION = `DELETE FROM seating_cells
WHERE org_id = ? AND table_id = ?
  AND EXISTS (SELECT 1 FROM seating_tables WHERE org_id = ? AND id = ? AND version = ?)`;

export const INSERT_SEATING_CELL_IF_VERSION = `INSERT INTO seating_cells (org_id, event_id, x, y, table_id)
SELECT ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM seating_tables WHERE org_id = ? AND id = ? AND version = ?)`;

export const INSERT_SEATING_CELL_IF_TABLE_EXISTS = `INSERT INTO seating_cells (org_id, event_id, x, y, table_id)
SELECT ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM seating_tables WHERE org_id = ? AND id = ?)`;

// ---------------------------------------------------------------------------
// A write across two tables (a seat move, B11)
//
// One version guard cannot cover two rows, and two different guards in one
// batch is exactly the partial write the rule above exists to prevent: a
// stale version on one table would no-op its half and leave the other half
// applied.
//
// So the **audit row is the interlock**. It goes first and is the one
// statement that checks the versions — both of them — and every statement
// after it asks only whether that row is there. A stale writer's audit insert
// matches nothing, and the rest of the batch matches nothing either.
//
// It has to be the audit row rather than "both versions" repeated on every
// statement, because a version is not stable across a batch: the first update
// bumps its own table, and the second statement's guard would then be reading
// a version the batch itself had just changed.
// ---------------------------------------------------------------------------

/** The two `EXISTS` clauses that make a two-table write all-or-nothing. */
const BOTH_SEATING_TABLE_VERSIONS = `EXISTS (SELECT 1 FROM seating_tables WHERE org_id = ? AND id = ? AND version = ?)
  AND EXISTS (SELECT 1 FROM seating_tables WHERE org_id = ? AND id = ? AND version = ?)`;

/** Whether the batch's own audit row landed — which it did only if both
 * versions matched. */
const OPERATION_WRITTEN = `EXISTS (SELECT 1 FROM operations WHERE org_id = ? AND id = ?)`;

export const INSERT_OPERATION_IF_BOTH_SEATING_TABLE_VERSIONS = `INSERT INTO operations (${OPERATION_COLUMNS})
SELECT ${OPERATION_INSERT_VALUES}
WHERE ${BOTH_SEATING_TABLE_VERSIONS}`;

export const DELETE_SEATING_CELLS_IF_OPERATION = `DELETE FROM seating_cells
WHERE org_id = ? AND table_id = ?
  AND ${OPERATION_WRITTEN}`;

export const INSERT_SEATING_CELL_IF_OPERATION = `INSERT INTO seating_cells (org_id, event_id, x, y, table_id)
SELECT ?, ?, ?, ?, ?
WHERE ${OPERATION_WRITTEN}`;

export const UPDATE_SEATING_TABLE_IF_OPERATION = `UPDATE seating_tables
SET name = ?, kind = ?, size = ?, end_seats = ?, rotation = ?, grid_x = ?, grid_y = ?, seats = ?, status = ?, version = ?, updated_at = ?
WHERE org_id = ? AND id = ?
  AND ${OPERATION_WRITTEN}`;
