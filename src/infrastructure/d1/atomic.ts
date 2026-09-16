/**
 * The one place a multi-statement write happens (blueprint B11, decision D07).
 *
 * D1 and the local SQLite file agree on almost nothing here: D1 exposes
 * `atomicBatch` and no interactive transactions, the local libsql /
 * better-sqlite3 client exposes `transaction` and no batch (F8). `runAtomic`
 * is the seam — repositories build a list of statements and never learn which
 * runtime applied them.
 *
 * The type is structural on purpose: `DbExecLike` is the subset of the
 * framework's `DbExec` this application uses, so a test can pass the real
 * `getDbExec()` executor, and no other module has to import the framework.
 */

import { AppError } from "../../application/errors";

export interface Statement {
  sql: string;
  args: unknown[];
}

export interface DbExecResult {
  rows: unknown[];
  rowsAffected: number;
}

/** The subset of `@agent-native/core/db`'s `DbExec` this application uses. */
export interface DbExecLike {
  execute(
    statement: string | { sql: string; args?: unknown[] },
  ): Promise<DbExecResult>;
  transaction?<T>(fn: (tx: DbExecLike) => Promise<T>): Promise<T>;
  atomicBatch?(
    statements: readonly (string | { sql: string; args?: unknown[] })[],
  ): Promise<DbExecResult[]>;
}

/**
 * Either an executor or a way to get one. The container passes a function,
 * because on Workers the framework's executor is bound to the request and must
 * not be cached across them; a test can pass an executor directly.
 */
export type DbExecSource =
  | DbExecLike
  | (() => DbExecLike | Promise<DbExecLike>);

/**
 * Resolves a source to an executor that has already chosen its driver.
 *
 * The second half is a workaround, not a nicety. `getDbExec()` returns a lazy
 * proxy that advertises **both** `transaction` and `atomicBatch` until its
 * first `execute()` picks a driver; only afterwards does it expose the one
 * F8 describes. Feature-detecting on that proxy would send a local-file write
 * down the `atomicBatch` path, which then throws "This database does not
 * support atomic batches" — and calling it again does not fix the advertised
 * shape. A real executor never offers both, so "both" is an unambiguous signal
 * that nothing has been initialised yet, and one throwaway read settles it.
 */
export async function resolveExec(source: DbExecSource): Promise<DbExecLike> {
  const exec = typeof source === "function" ? await source() : source;
  if (exec.atomicBatch && exec.transaction) await exec.execute("SELECT 1");
  return exec;
}

/**
 * Applies `statements` as one all-or-nothing unit and returns the rows
 * affected by each, in order. Callers read those counts to decide whether a
 * guarded statement applied (B11); they never inspect the driver.
 */
export async function runAtomic(
  exec: DbExecLike,
  statements: Statement[],
): Promise<number[]> {
  if (statements.length === 0) return [];

  if (exec.atomicBatch) {
    const results = await exec.atomicBatch(statements);
    return results.map((result) => result.rowsAffected);
  }

  if (exec.transaction) {
    return exec.transaction(async (tx) => {
      const affected: number[] = [];
      for (const statement of statements) {
        affected.push((await tx.execute(statement)).rowsAffected);
      }
      return affected;
    });
  }

  // Applying them one by one outside a transaction would leave a half-written
  // audit trail behind on the first failure, which is worse than not writing.
  throw new AppError("INTERNAL", "No atomic write support");
}
