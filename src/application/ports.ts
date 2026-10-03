/**
 * Outbound ports the application layer depends on (blueprint B7).
 *
 * Every port here is an interface with no framework or I/O detail leaking
 * through. `src/infrastructure/sql` (T07) implements them against SQL;
 * `tests/fixtures/in-memory.ts` implements them in memory for unit tests.
 * `Dependencies` is the one bag every use case takes, so a use case's only
 * inputs are `(deps, actor, input)`.
 */

import type {
  Event,
  EventStatus,
  Operation,
  ResourceType,
  SeatingTable,
  SeatingTableStatus,
} from "../domain";
import type { Role } from "./authorization";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(): string;
}

export interface MembershipReader {
  getRole(orgId: string, userEmail: string): Promise<Role | null>;
  isMember(orgId: string, userEmail: string): Promise<boolean>;
}

export interface EventRepository {
  getById(orgId: string, id: string): Promise<Event | null>;
  list(orgId: string, filter: { status?: EventStatus }): Promise<Event[]>;
  create(input: {
    event: Event;
    operation: Operation;
    idempotency?: { action: string; key: string };
  }): Promise<void>;
  /** Throws `AppError("CONFLICT", …)` when the stored version does not
   * match `expectedVersion` (blueprint B11). */
  commit(input: {
    event: Event;
    expectedVersion: number;
    operation: Operation;
    markUndone?: string;
  }): Promise<void>;
}

/** A table to write, and the version the caller read it at. */
export interface VersionedTableWrite {
  table: SeatingTable;
  expectedVersion: number;
}

export interface SeatingTableRepository {
  getById(orgId: string, id: string): Promise<SeatingTable | null>;
  list(
    orgId: string,
    filter: { eventId?: string; status?: SeatingTableStatus },
  ): Promise<SeatingTable[]>;
  /** Throws `AppError("NOT_FOUND", "Event not found or archived")` unless the
   * event exists, is in the same org and is active, and
   * `AppError("CONFLICT", "That space is already occupied")` when another
   * active table of the same event already holds one of its cells
   * (blueprint B11). */
  create(input: {
    table: SeatingTable;
    operation: Operation;
    idempotency?: { action: string; key: string };
  }): Promise<void>;
  /**
   * Writes a whole venue layout at once: every table, and the event whose room
   * may have grown to hold them, under one audit row and one version guard.
   *
   * Spanning two tables is the point. A layout and the floor it needs are a
   * single fact, and there is no interactive transaction to assemble one out of
   * two calls — so either all of it lands or none of it does.
   *
   * Throws `AppError("CONFLICT", …)` when the event moved on under the caller
   * or a cell is taken, and `AppError("NOT_FOUND", …)` when the event is gone
   * or archived.
   */
  createLayout(input: {
    event: Event;
    expectedVersion: number;
    tables: readonly SeatingTable[];
    operation: Operation;
  }): Promise<void>;
  /**
   * Undoes a `createLayout`: archives every table it made and puts the event's
   * room back, in one batch. Each table carries its own `expectedVersion`,
   * since the tables have been on the floor since and may have moved.
   */
  archiveLayout(input: {
    event: Event;
    expectedVersion: number;
    tables: readonly { table: SeatingTable; expectedVersion: number }[];
    operation: Operation;
    markUndone?: string;
  }): Promise<void>;
  /**
   * Several tables, their cell sets and one audit row, in a single batch.
   *
   * Spanning rows is the point. A name that has left one chair and not arrived
   * at the other is not a state the floor plan has, and neither is half a
   * bench shifted along; `commit` writes one table, so a call per table would
   * be a chance to stop halfway for every table but the last.
   *
   * Each table carries the version its caller read. Throws
   * `AppError("CONFLICT", …)` when any of them has moved on, and the same when
   * a cell was taken between the caller's read and this write.
   */
  commitTables(input: {
    tables: readonly VersionedTableWrite[];
    operation: Operation;
    markUndone?: string;
  }): Promise<void>;
  /**
   * Throws `AppError("CONFLICT", …)` when the stored version does not match
   * `expectedVersion`, and the same when another table has taken one of this
   * one's cells since the caller read the plan (blueprint B11).
   *
   * Every commit rewrites the table's occupancy, so no caller has to say
   * whether a particular change moved it: the cells are recomputed from the
   * table itself, and an archived table simply stops holding any.
   */
  commit(input: {
    table: SeatingTable;
    expectedVersion: number;
    operation: Operation;
    markUndone?: string;
  }): Promise<void>;
}

export interface OperationRepository {
  getById(orgId: string, id: string): Promise<Operation | null>;
  listRecent(orgId: string, limit: number): Promise<Operation[]>;
  listForResource(
    orgId: string,
    type: ResourceType,
    id: string,
    limit: number,
  ): Promise<Operation[]>;
  /** The `forward` operation that created this resource — the one row with
   * `versionBefore === 0` — or `null` when the resource has none. Read by an
   * idempotent create's replay, which owes the caller the `operationId` of the
   * create that already happened and cannot find it through the newest-first,
   * limited `listForResource` (B7). */
  findCreateOperation(
    orgId: string,
    type: ResourceType,
    id: string,
  ): Promise<Operation | null>;
}

export interface IdempotencyStore {
  /** Returns the `resourceId` a prior call with this `(action, key)`
   * created, or `null` when the key has not been used yet. */
  find(orgId: string, action: string, key: string): Promise<string | null>;
}

export interface Dependencies {
  clock: Clock;
  ids: IdGenerator;
  membership: MembershipReader;
  events: EventRepository;
  seatingTables: SeatingTableRepository;
  operations: OperationRepository;
  idempotency: IdempotencyStore;
}
