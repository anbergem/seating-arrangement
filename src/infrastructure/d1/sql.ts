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
 * silently the day a migration adds a column. `jobs.accounting_reference` and
 * `jobs.accounting_sent_at` are deliberately absent — migration
 * `0002_job_accounting.sql` (T27) adds them, and until then the mappers report
 * them as `null` (B11).
 */

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const CUSTOMER_COLUMNS =
  "id, org_id, name, email, phone, notes, status, version, created_by, created_at, updated_at";

export const SELECT_CUSTOMER_BY_ID = `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE org_id = ? AND id = ? LIMIT 1`;

/** Prefix; `SELECT_CUSTOMERS_PARTS` supplies the optional tail. */
export const SELECT_CUSTOMERS = `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE org_id = ?`;

/**
 * The only pieces that may be appended to `SELECT_CUSTOMERS`, chosen by filter
 * name — never built from a caller's value. Each fragment carries exactly one
 * `?`, so the filter's value stays an argument. `search` matches the way the
 * in-memory repository's `includes()` does; `%`, `_` and the escape character
 * itself are escaped by the caller (`escapeLike` in `customers-repository.ts`).
 *
 * Grouped in a record rather than exported as loose constants because the
 * scoping test's rule ("every exported string carries `org_id = ?`") is about
 * whole statements; a fragment gets its tenancy from the statement it is
 * appended to. The test checks the fragments against their own, stricter rule.
 */
export const SELECT_CUSTOMERS_PARTS = {
  status: " AND status = ?",
  search: " AND lower(name) LIKE ? ESCAPE '\\'",
  order: " ORDER BY name ASC, id ASC",
} as const;

/**
 * Guarded so the statement carries `org_id = ?` like every other one here, and
 * so a replayed create is a no-op instead of a primary-key failure that would
 * abort the whole batch. Ids are `crypto.randomUUID()` values (B3), so zero
 * rows affected means a retry, not a collision.
 */
export const INSERT_CUSTOMER = `INSERT INTO customers (${CUSTOMER_COLUMNS})
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE NOT EXISTS (SELECT 1 FROM customers WHERE org_id = ? AND id = ?)`;

/** `name`, `email`, `phone`, `notes` and `status` are the only mutable
 * columns; `created_by`/`created_at` never change. */
export const UPDATE_CUSTOMER_VERSIONED = `UPDATE customers
SET name = ?, email = ?, phone = ?, notes = ?, status = ?, version = ?, updated_at = ?
WHERE org_id = ? AND id = ? AND version = ?`;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const JOB_COLUMNS =
  "id, org_id, customer_id, title, description, status, scheduled_at, assigned_to, completed_at, archived_at, accounting_reference, accounting_sent_at, version, created_by, created_at, updated_at";

export const SELECT_JOB_BY_ID = `SELECT ${JOB_COLUMNS} FROM jobs WHERE org_id = ? AND id = ? LIMIT 1`;

/** Prefix; `SELECT_JOBS_PARTS` supplies the optional tail. */
export const SELECT_JOBS = `SELECT ${JOB_COLUMNS} FROM jobs WHERE org_id = ?`;

/**
 * The only pieces that may be appended to `SELECT_JOBS`, chosen by filter name
 * — never built from a caller's value. The window is half-open: `from` is
 * inclusive, `to` is exclusive, so consecutive days do not both match a job
 * scheduled at midnight.
 */
export const SELECT_JOBS_PARTS = {
  status: " AND status = ?",
  customerId: " AND customer_id = ?",
  from: " AND scheduled_at >= ?",
  to: " AND scheduled_at < ?",
  order: " ORDER BY scheduled_at ASC, id ASC",
} as const;

/** Zero rows affected means the customer is missing, archived, or belongs to
 * another organization — the caller reports NOT_FOUND for all three, which is
 * also what keeps a cross-organization create from confirming that an id
 * exists somewhere else (B11). */
export const INSERT_JOB_IF_ACTIVE_CUSTOMER = `INSERT INTO jobs (${JOB_COLUMNS})
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM customers WHERE org_id = ? AND id = ? AND status = 'active')`;

/** `title`, `description` and `customer_id` are immutable after creation, so
 * they are not in the SET list; the accounting columns arrive with migration
 * 0002 (T27). */
export const UPDATE_JOB_VERSIONED = `UPDATE jobs
SET status = ?, scheduled_at = ?, assigned_to = ?, completed_at = ?, archived_at = ?, accounting_reference = ?, accounting_sent_at = ?, version = ?, updated_at = ?
WHERE org_id = ? AND id = ? AND version = ?`;

const OPERATION_COLUMNS =
  "id, org_id, kind, action, resource_type, resource_id, classification, version_before, version_after, payload, inverse, related_operation_id, undone_by_operation_id, performed_by, performed_via, performed_at";

const OPERATION_INSERT_VALUES =
  "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?";

// ---------------------------------------------------------------------------
// Durable accounting export intents (B22/D27)
// ---------------------------------------------------------------------------

const ACCOUNTING_EXPORT_COLUMNS =
  "org_id, job_id, idempotency_key, request_json, status, external_reference, operation_id, requested_by, requested_at, completed_at";

export const SELECT_ACCOUNTING_EXPORT = `SELECT ${ACCOUNTING_EXPORT_COLUMNS} FROM accounting_exports
WHERE org_id = ? AND job_id = ? LIMIT 1`;

export const INSERT_PENDING_ACCOUNTING_EXPORT = `INSERT OR IGNORE INTO accounting_exports (${ACCOUNTING_EXPORT_COLUMNS})
SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL
WHERE EXISTS (SELECT 1 FROM jobs WHERE org_id = ? AND id = ? AND version = ? AND status = ? AND accounting_reference IS NULL)`;

export const RECORD_ACCOUNTING_ACCEPTANCE = `UPDATE accounting_exports
SET external_reference = COALESCE(external_reference, ?)
WHERE org_id = ? AND job_id = ? AND status = ?
  AND (external_reference IS NULL OR external_reference = ?)`;

export const INSERT_ACCOUNTING_OPERATION_IF_PENDING = `INSERT INTO operations (${OPERATION_COLUMNS})
SELECT ${OPERATION_INSERT_VALUES}
WHERE EXISTS (SELECT 1 FROM jobs WHERE org_id = ? AND id = ? AND version = ?)
  AND EXISTS (SELECT 1 FROM accounting_exports WHERE org_id = ? AND job_id = ? AND status = ? AND external_reference = ?)`;

export const COMPLETE_ACCOUNTING_EXPORT = `UPDATE accounting_exports
SET status = ?, operation_id = ?, completed_at = ?
WHERE org_id = ? AND job_id = ? AND status = ? AND external_reference = ?
  AND EXISTS (SELECT 1 FROM operations WHERE org_id = ? AND id = ?)`;

// ---------------------------------------------------------------------------
// Operations (the audit and undo log, B9)
// ---------------------------------------------------------------------------

/** `undone_by_operation_id` is `NULL` in every insert: an operation is marked
 * undone later, by `MARK_OPERATION_UNDONE`, never at birth. */

/**
 * The audit row of a job `commit`, guarded on the job still being at the
 * version the caller read — the same predicate as the versioned update it
 * shares a batch with, so the two are written together or not at all.
 *
 * The guard is the *expected* version, and the statement runs **before** the
 * update. Guarding on the version the update writes instead (B11's wording)
 * has a hole: two callers who both read version 1 and both complete the job
 * both want to write version 2, so the loser's guard matches the winner's row
 * and an audit row appears for a change that never happened. Reading the
 * pre-image inside the same transaction cannot be fooled that way.
 */
export const INSERT_OPERATION_IF_VERSION = `INSERT INTO operations (${OPERATION_COLUMNS})
SELECT ${OPERATION_INSERT_VALUES}
WHERE EXISTS (SELECT 1 FROM jobs WHERE org_id = ? AND id = ? AND version = ?)`;

export const INSERT_OPERATION_IF_VERSION_WITHOUT_ACCOUNTING_EXPORT = `INSERT INTO operations (${OPERATION_COLUMNS})
SELECT ${OPERATION_INSERT_VALUES}
WHERE EXISTS (SELECT 1 FROM jobs WHERE org_id = ? AND id = ? AND version = ?)
  AND NOT EXISTS (SELECT 1 FROM accounting_exports WHERE org_id = ? AND job_id = ?)`;

export const UPDATE_JOB_VERSIONED_WITHOUT_ACCOUNTING_EXPORT = `UPDATE jobs
SET status = ?, scheduled_at = ?, assigned_to = ?, completed_at = ?, archived_at = ?, accounting_reference = ?, accounting_sent_at = ?, version = ?, updated_at = ?
WHERE org_id = ? AND id = ? AND version = ?
  AND NOT EXISTS (SELECT 1 FROM accounting_exports WHERE org_id = ? AND job_id = ?)
  AND EXISTS (SELECT 1 FROM operations WHERE org_id = ? AND id = ?)`;

export const UPDATE_JOB_VERSIONED_IF_OPERATION = `UPDATE jobs
SET status = ?, scheduled_at = ?, assigned_to = ?, completed_at = ?, archived_at = ?, accounting_reference = ?, accounting_sent_at = ?, version = ?, updated_at = ?
WHERE org_id = ? AND id = ? AND version = ?
  AND EXISTS (SELECT 1 FROM operations WHERE org_id = ? AND id = ?)`;

/** The same guard against `customers`. */
export const INSERT_OPERATION_IF_CUSTOMER_VERSION = `INSERT INTO operations (${OPERATION_COLUMNS})
SELECT ${OPERATION_INSERT_VALUES}
WHERE EXISTS (SELECT 1 FROM customers WHERE org_id = ? AND id = ? AND version = ?)`;

/**
 * Second statement of a `create`, where there is no previous version to guard
 * on: the audit row is written only if the row the insert before it was meant
 * to produce is really there.
 *
 * One statement covers both resource types by comparing the operation's own
 * `resource_type` against a literal in each branch, so exactly one branch can
 * ever match. Arguments after the insert values are
 * `(orgId, resourceId, resourceType)` twice — customers first, then jobs.
 */
export const INSERT_OPERATION_IF_RESOURCE_EXISTS = `INSERT INTO operations (${OPERATION_COLUMNS})
SELECT ${OPERATION_INSERT_VALUES}
WHERE EXISTS (SELECT 1 FROM customers WHERE org_id = ? AND id = ? AND ? = 'customer')
   OR EXISTS (SELECT 1 FROM jobs WHERE org_id = ? AND id = ? AND ? = 'job')`;

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
 * refused (an archived customer, say) would still burn the key, and the
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
