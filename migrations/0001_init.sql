-- The application's own schema.
--
-- Two entities and two ledgers. An `event` is the occasion a seating plan
-- belongs to; a `seating_table` is one table on that plan. `operations` is the
-- undo ledger, and `idempotency_keys` is what makes a retried create safe.
--
-- Conventions every table here follows, and a new one should:
--
--   * `id TEXT PRIMARY KEY` plus `org_id TEXT NOT NULL` and `UNIQUE (org_id, id)`,
--     so every statement can carry `org_id = ?` and still hit an index.
--   * A child names its parent with a compound foreign key `(org_id, <parent>_id)`,
--     which makes a cross-organization reference impossible rather than merely
--     unlikely.
--   * `version INTEGER NOT NULL CHECK (version >= 1)` for optimistic concurrency.
--   * Timestamps are ISO 8601 `TEXT`, never a numeric epoch.
--   * A CHECK constraint for every enum and every length limit the domain states,
--     so a row the domain could not have produced cannot be written by anything
--     else either.

CREATE TABLE events (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  starts_at TEXT NOT NULL,
  -- The floor this event's tables stand on. A property of the occasion, not a
  -- constant of the application: a venue bootstrap sizes the room to the
  -- layout it was asked for. Bounds mirror src/domain/seating-table.ts.
  room_width INTEGER NOT NULL CHECK (room_width BETWEEN 4 AND 64),
  room_height INTEGER NOT NULL CHECK (room_height BETWEEN 4 AND 40),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, id)
);

CREATE INDEX events_org_status_starts_idx ON events (org_id, status, starts_at);

-- A table's body is a block of cells: `size` x 1 for a rectangle, `size` x
-- `size` for a round one, turned by `rotation`. A table is never itself bent —
-- an L- or U-shaped arrangement is several tables standing against one another.
--
-- Seats are *derived* from that form — every cell touching the body, walked
-- clockwise — so `seats` holds only what a person authored: a label and whether
-- the chair is still there, one entry per seat position, in that same clockwise
-- order.
--
-- The bounding box is deliberately not stored. It falls out of the shape, and
-- nothing in SQL needs it: what a table occupies is `seating_cells`, not a
-- rectangle. There is likewise no bound on how far right a table may sit,
-- because that is `events.room_width`, and the domain is what enforces it.
CREATE TABLE seating_tables (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('rectangle', 'round')),
  -- A rectangle's length, or a round table's diameter, in cells. The tighter
  -- per-kind ceiling (a round table stops at 4) is the domain's business; this
  -- is only the outer bound any table may have.
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 8),
  -- Always 0 for a round table, which has no ends to seat.
  end_seats INTEGER NOT NULL CHECK (end_seats IN (0, 1)),
  -- Always 0 for a round table, whose square body turns into itself.
  rotation INTEGER NOT NULL CHECK (rotation IN (0, 90, 180, 270)),
  grid_x INTEGER NOT NULL CHECK (grid_x >= 0),
  grid_y INTEGER NOT NULL CHECK (grid_y >= 0),
  seats TEXT NOT NULL CHECK (json_valid(seats)),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, id),
  CHECK (kind <> 'round' OR (end_seats = 0 AND rotation = 0)),
  FOREIGN KEY (org_id, event_id) REFERENCES events (org_id, id)
);

CREATE INDEX seating_tables_org_event_idx ON seating_tables (org_id, event_id, status);

CREATE INDEX seating_tables_org_status_created_idx ON seating_tables (org_id, status, created_at);

-- Which table holds which cell of which event's floor plan. One row per cell.
--
-- **This primary key is the floor plan's central invariant.** Two tables may
-- never overlap, and no version guard can express that, because the two writers
-- are touching different rows -- each passes its own version check and the plan
-- ends up broken. So occupancy is stated as data instead: every write rewrites
-- its table's cells inside the same atomic batch as the table row itself, and a
-- second writer claiming a cell violates `(org_id, event_id, x, y)` and loses
-- the entire batch.
--
-- Cells, rather than a bounding rectangle, because a rectangle cannot describe
-- the shapes people actually build. A table with end seats leaves its four
-- corners empty, and a seat that has been taken away leaves its own cell empty
-- -- which is exactly how two tables are brought together at a right angle to
-- make an L or a U.
--
-- An archived table holds no cells at all: absence from this table is the
-- statement that a table occupies nothing, so `status` is not repeated here.
CREATE TABLE seating_cells (
  org_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  x INTEGER NOT NULL CHECK (x >= 0),
  y INTEGER NOT NULL CHECK (y >= 0),
  table_id TEXT NOT NULL,
  PRIMARY KEY (org_id, event_id, x, y),
  FOREIGN KEY (org_id, table_id) REFERENCES seating_tables (org_id, id)
);

CREATE INDEX seating_cells_org_table_idx ON seating_cells (org_id, table_id);

-- One row per change, with the inverse that reverses it. `resource_type` is a
-- CHECK-constrained enum and SQLite cannot ALTER one, so adding a third entity
-- means rebuilding this table: create, copy, drop, rename, recreate the indexes.
-- That is safe -- it has no foreign key of its own and nothing references it --
-- but it is a migration, not an ALTER.
CREATE TABLE operations (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('forward', 'undo', 'redo')),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('event', 'seating_table')),
  resource_id TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('reversible', 'compensatable', 'irreversible')),
  version_before INTEGER NOT NULL,
  version_after INTEGER NOT NULL,
  payload TEXT,
  inverse TEXT,
  related_operation_id TEXT,
  undone_by_operation_id TEXT,
  performed_by TEXT NOT NULL,
  performed_via TEXT NOT NULL,
  performed_at TEXT NOT NULL,
  UNIQUE (org_id, id)
);

CREATE INDEX operations_org_resource_idx ON operations (org_id, resource_type, resource_id, performed_at);

CREATE INDEX operations_org_performed_idx ON operations (org_id, performed_at);

CREATE TABLE idempotency_keys (
  org_id TEXT NOT NULL,
  action TEXT NOT NULL,
  key TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, action, key)
);
