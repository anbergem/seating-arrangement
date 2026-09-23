/**
 * In-memory implementation of `Dependencies` (blueprint B7, B11).
 *
 * Every use-case test builds one of these instead of touching D1: the
 * behaviour mirrors the real repositories closely enough that a use case
 * cannot tell the difference — `getById`/`list` filter by `orgId`, a table
 * requires an active event in the same org and free space to stand in,
 * `commit` is version-guarded and CONFLICTs on a stale version, and the clock
 * and id generator are both fixed so tests stay deterministic.
 *
 * `state` is exposed directly so tests (and `tests/fixtures/scenario.ts`)
 * can seed or inspect it without going through the repository interfaces,
 * which run the same preconditions a real adapter would.
 *
 * Every `list` returns rows in the order the matching D1 statement in
 * `src/infrastructure/d1/sql.ts` does — events by `starts_at, id`, tables by
 * `created_at, id`, operations by `performed_at DESC, id DESC`. A `Map`
 * iterates in insertion order, which is not an order any database promises,
 * so without this a unit test and the integration test for the same use case
 * could disagree (DISCREPANCIES, 2026-09-06 T08).
 */

import type { Role } from "../../src/application/authorization";
import { AppError } from "../../src/application/errors";
import type {
  Clock,
  Dependencies,
  EventRepository,
  IdempotencyStore,
  IdGenerator,
  MembershipReader,
  OperationRepository,
  SeatingTableRepository,
} from "../../src/application/ports";
import type {
  Event,
  Operation,
  ResourceType,
  SeatingTable,
} from "../../src/domain";
import { cellKey, cellsOf } from "../../src/domain";

/** The clock value every `createInMemoryDependencies()` call uses unless
 * `options.now` overrides it — "today" in this fixture's fictional
 * timeline, and the same instant every other fixed constant in the codebase
 * (blueprint B12) is written against. */
const DEFAULT_NOW = "2026-09-06T12:00:00.000Z";

export interface InMemoryState {
  events: Map<string, Event>;
  seatingTables: Map<string, SeatingTable>;
  operations: Map<string, Operation>;
  /** Keyed by `orgId`, `action` and `key` joined with a space (see
   * `idempotencyMapKey` below) → the resourceId that call created. */
  idempotency: Map<string, string>;
  /** Tests may install one one-shot mutation immediately before a guarded
   * seating-table write: it is how a test models
   * somebody else taking the space between the check and the commit. */
  beforeSeatingTableCommit?: () => void | Promise<void>;
  /** orgId → (lower-cased email → role). */
  memberships: Map<string, Map<string, Role>>;
}

export interface InMemoryDependenciesOptions {
  /** Fixed `Clock.now()` value. Defaults to `DEFAULT_NOW`. */
  now?: string;
  /** Fixed sequence for `IdGenerator.next()`. Defaults to `id-1`, `id-2`, …
   * Throws once the sequence is exhausted rather than silently falling back,
   * so a test that asserts on ids notices an unexpected extra call. */
  ids?: string[];
  state?: InMemoryState;
}

export interface InMemoryDependencies extends Dependencies {
  state: InMemoryState;
}

function idempotencyMapKey(orgId: string, action: string, key: string): string {
  return `${orgId} ${action} ${key}`;
}

/**
 * `ORDER BY <first> ASC, <second> ASC` for two string columns.
 *
 * Plain `<`/`>` rather than `localeCompare`, because SQLite's default
 * collation for a TEXT column is a byte comparison, and a locale-aware
 * comparison would order `["a", "B"]` differently from the database this
 * fixture stands in for.
 */
function byTextThenId(
  first: string,
  second: string,
  firstId: string,
  secondId: string,
): number {
  if (first !== second) return first < second ? -1 : 1;
  if (firstId === secondId) return 0;
  return firstId < secondId ? -1 : 1;
}

function createClock(now: string): Clock {
  return { now: () => now };
}

function createIdGenerator(fixedIds: string[] | undefined): IdGenerator {
  let sequence = 0;
  return {
    next: () => {
      sequence += 1;
      if (fixedIds) {
        const id = fixedIds[sequence - 1];
        if (id === undefined) {
          throw new Error(
            `in-memory id generator: no id provided for call #${sequence}`,
          );
        }
        return id;
      }
      return `id-${sequence}`;
    },
  };
}

function createMembershipReader(state: InMemoryState): MembershipReader {
  return {
    getRole: async (orgId, userEmail) => {
      const org = state.memberships.get(orgId);
      if (!org) return null;
      return org.get(userEmail.toLowerCase()) ?? null;
    },
    isMember: async (orgId, userEmail) => {
      const org = state.memberships.get(orgId);
      return org ? org.has(userEmail.toLowerCase()) : false;
    },
  };
}

function applyMarkUndone(
  state: InMemoryState,
  markUndone: string | undefined,
  undoneBy: string,
): void {
  if (!markUndone) return;
  const op = state.operations.get(markUndone);
  if (op)
    state.operations.set(markUndone, { ...op, undoneByOperationId: undoneBy });
}

function createEventRepository(state: InMemoryState): EventRepository {
  return {
    getById: async (orgId, id) => {
      const found = state.events.get(id);
      return found && found.orgId === orgId ? found : null;
    },
    list: async (orgId, filter) =>
      Array.from(state.events.values())
        .filter((e) => e.orgId === orgId)
        .filter((e) => (filter.status ? e.status === filter.status : true))
        // `SELECT_EVENTS_PARTS.order`: ORDER BY starts_at ASC, id ASC.
        .sort((a, b) => byTextThenId(a.startsAt, b.startsAt, a.id, b.id)),
    create: async ({ event, operation, idempotency }) => {
      state.events.set(event.id, event);
      state.operations.set(operation.id, operation);
      if (idempotency) {
        state.idempotency.set(
          idempotencyMapKey(event.orgId, idempotency.action, idempotency.key),
          event.id,
        );
      }
    },
    commit: async ({ event, expectedVersion, operation, markUndone }) => {
      const existing = state.events.get(event.id);
      if (
        !existing ||
        existing.orgId !== event.orgId ||
        existing.version !== expectedVersion
      ) {
        throw new AppError(
          "CONFLICT",
          "The record was changed by someone else",
        );
      }
      state.events.set(event.id, event);
      state.operations.set(operation.id, operation);
      applyMarkUndone(state, markUndone, operation.id);
    },
  };
}

/**
 * Mirrors `src/infrastructure/d1/seating-tables-repository.ts`, including the
 * part that matters most: the no-overlap rule is enforced *by the write*, not
 * before it. There it is the `seating_cells` primary key; here it is this
 * function, and the two have to agree cell for cell, or a use-case test and its
 * integration twin would disagree about when a move is refused.
 */
function spaceIsTaken(state: InMemoryState, table: SeatingTable): boolean {
  if (table.status !== "active") return false;
  const taken = new Set<string>();
  for (const other of state.seatingTables.values()) {
    if (
      other.orgId !== table.orgId ||
      other.eventId !== table.eventId ||
      other.id === table.id ||
      other.status !== "active"
    ) {
      continue;
    }
    for (const cell of cellsOf(other)) taken.add(cellKey(cell.x, cell.y));
  }
  return cellsOf(table).some((cell) => taken.has(cellKey(cell.x, cell.y)));
}

function createSeatingTableRepository(
  state: InMemoryState,
): SeatingTableRepository {
  return {
    getById: async (orgId, id) => {
      const found = state.seatingTables.get(id);
      return found && found.orgId === orgId ? found : null;
    },
    list: async (orgId, filter) =>
      Array.from(state.seatingTables.values())
        .filter((t) => t.orgId === orgId)
        .filter((t) => (filter.eventId ? t.eventId === filter.eventId : true))
        .filter((t) => (filter.status ? t.status === filter.status : true))
        // `SELECT_SEATING_TABLES_PARTS.order`: ORDER BY created_at ASC, id ASC.
        .sort((a, b) => byTextThenId(a.createdAt, b.createdAt, a.id, b.id)),
    create: async ({ table, operation, idempotency }) => {
      const event = state.events.get(table.eventId);
      if (!event || event.orgId !== table.orgId || event.status !== "active") {
        throw new AppError("NOT_FOUND", "Event not found or archived");
      }
      if (spaceIsTaken(state, table)) {
        throw new AppError("CONFLICT", "That space is already occupied");
      }
      state.seatingTables.set(table.id, table);
      state.operations.set(operation.id, operation);
      if (idempotency) {
        state.idempotency.set(
          idempotencyMapKey(table.orgId, idempotency.action, idempotency.key),
          table.id,
        );
      }
    },
    /** Mirrors `createLayout`: all-or-nothing, and the event's version is what
     * the whole batch hangs off. Built into a scratch map first so a collision
     * halfway through leaves nothing behind, the way a rolled-back batch
     * does. */
    createLayout: async ({ event, expectedVersion, tables, operation }) => {
      const stored = state.events.get(event.id);
      if (
        !stored ||
        stored.orgId !== event.orgId ||
        stored.version !== expectedVersion
      ) {
        throw new AppError(
          "CONFLICT",
          "The record was changed by someone else",
        );
      }
      if (stored.status !== "active") {
        throw new AppError("NOT_FOUND", "Event not found or archived");
      }
      const scratch = new Map(state.seatingTables);
      for (const table of tables) {
        if (spaceIsTaken({ ...state, seatingTables: scratch }, table)) {
          throw new AppError("CONFLICT", "That space is already occupied");
        }
        scratch.set(table.id, table);
      }
      state.seatingTables = scratch;
      state.events.set(event.id, event);
      state.operations.set(operation.id, operation);
    },
    archiveLayout: async ({
      event,
      expectedVersion,
      tables,
      operation,
      markUndone,
    }) => {
      const stored = state.events.get(event.id);
      if (
        !stored ||
        stored.orgId !== event.orgId ||
        stored.version !== expectedVersion
      ) {
        throw new AppError(
          "CONFLICT",
          "The record was changed by someone else",
        );
      }
      for (const { table, expectedVersion: was } of tables) {
        const existing = state.seatingTables.get(table.id);
        if (!existing || existing.version !== was) {
          throw new AppError(
            "CONFLICT",
            "The record was changed by someone else",
          );
        }
      }
      for (const { table } of tables) state.seatingTables.set(table.id, table);
      state.events.set(event.id, event);
      state.operations.set(operation.id, operation);
      applyMarkUndone(state, markUndone, operation.id);
    },
    /**
     * Mirrors `commitTables`: every table, all or nothing.
     *
     * They all go into the scratch map *before* any of them is checked, which
     * is this file's equivalent of the real batch putting every cell delete
     * ahead of every insert. Checking them one at a time against the live map
     * would refuse a name crossing the seam where two tables meet — the
     * arriving chair would collide with the leaving chair that is, in the
     * scratch, already gone. Getting this wrong is how a use-case test and its
     * integration twin come to disagree about when a write is legal.
     */
    commitTables: async ({ tables, operation, markUndone }) => {
      const hook = state.beforeSeatingTableCommit;
      state.beforeSeatingTableCommit = undefined;
      await hook?.();
      const scratch = new Map(state.seatingTables);
      for (const { table, expectedVersion } of tables) {
        const existing = state.seatingTables.get(table.id);
        if (
          !existing ||
          existing.orgId !== table.orgId ||
          existing.version !== expectedVersion
        ) {
          throw new AppError(
            "CONFLICT",
            "The record was changed by someone else",
          );
        }
        scratch.set(table.id, table);
      }
      for (const { table } of tables) {
        if (spaceIsTaken({ ...state, seatingTables: scratch }, table)) {
          throw new AppError("CONFLICT", "That space is already occupied");
        }
      }
      state.seatingTables = scratch;
      state.operations.set(operation.id, operation);
      applyMarkUndone(state, markUndone, operation.id);
    },
    commit: async ({ table, expectedVersion, operation, markUndone }) => {
      const hook = state.beforeSeatingTableCommit;
      state.beforeSeatingTableCommit = undefined;
      await hook?.();
      const existing = state.seatingTables.get(table.id);
      if (
        !existing ||
        existing.orgId !== table.orgId ||
        existing.version !== expectedVersion
      ) {
        throw new AppError(
          "CONFLICT",
          "The record was changed by someone else",
        );
      }
      // Every commit restates occupancy, exactly as the real one does, so no
      // caller has to say whether this particular change moved anything.
      if (spaceIsTaken(state, table)) {
        throw new AppError("CONFLICT", "That space is already occupied");
      }
      state.seatingTables.set(table.id, table);
      state.operations.set(operation.id, operation);
      applyMarkUndone(state, markUndone, operation.id);
    },
  };
}

/** Newest first, matching what "recent activity" means for both
 * `listRecent` and `listForResource` — and matching
 * `SELECT_RECENT_OPERATIONS`/`SELECT_OPERATIONS_FOR_RESOURCE`, which are
 * `ORDER BY performed_at DESC, id DESC`. The `id` tiebreak matters here: the
 * seeded scenario writes several operations at the same instant, so without
 * it the page boundary of a `limit`ed list would be insertion order. */
function byMostRecentFirst(a: Operation, b: Operation): number {
  return -byTextThenId(a.performedAt, b.performedAt, a.id, b.id);
}

function createOperationRepository(state: InMemoryState): OperationRepository {
  return {
    getById: async (orgId, id) => {
      const found = state.operations.get(id);
      return found && found.orgId === orgId ? found : null;
    },
    listRecent: async (orgId, limit) => {
      return Array.from(state.operations.values())
        .filter((op) => op.orgId === orgId)
        .sort(byMostRecentFirst)
        .slice(0, limit);
    },
    listForResource: async (
      orgId: string,
      type: ResourceType,
      id: string,
      limit: number,
    ) => {
      return Array.from(state.operations.values())
        .filter(
          (op) =>
            op.orgId === orgId &&
            op.resourceType === type &&
            op.resourceId === id,
        )
        .sort(byMostRecentFirst)
        .slice(0, limit);
    },
    // `versionBefore === 0` identifies a create, the same predicate
    // `SELECT_CREATE_OPERATION` uses.
    findCreateOperation: async (
      orgId: string,
      type: ResourceType,
      id: string,
    ) => {
      return (
        Array.from(state.operations.values()).find(
          (op) =>
            op.orgId === orgId &&
            op.resourceType === type &&
            op.resourceId === id &&
            op.kind === "forward" &&
            op.versionBefore === 0,
        ) ?? null
      );
    },
  };
}

function createIdempotencyStore(state: InMemoryState): IdempotencyStore {
  return {
    find: async (orgId, action, key) => {
      return (
        state.idempotency.get(idempotencyMapKey(orgId, action, key)) ?? null
      );
    },
  };
}

/** A complete `Dependencies`, backed by the maps above. */
export function createInMemoryDependencies(
  options: InMemoryDependenciesOptions = {},
): InMemoryDependencies {
  const state: InMemoryState = options.state ?? {
    events: new Map(),
    seatingTables: new Map(),
    operations: new Map(),
    idempotency: new Map(),
    memberships: new Map(),
  };

  return {
    clock: createClock(options.now ?? DEFAULT_NOW),
    ids: createIdGenerator(options.ids),
    membership: createMembershipReader(state),
    events: createEventRepository(state),
    seatingTables: createSeatingTableRepository(state),
    operations: createOperationRepository(state),
    idempotency: createIdempotencyStore(state),
    state,
  };
}
