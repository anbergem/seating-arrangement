/**
 * Structured logging (blueprint B16, decision D17).
 *
 * One JSON object per line on stdout, which is what Cloudflare's log stream
 * and `wrangler tail` can filter on; nothing here formats for humans.
 *
 * What is deliberately absent matters more than what is present: no email, no
 * action arguments, no results, no row contents. A log line says *that*
 * something happened to *which* organization, never *what* the data was. That
 * is the whole reason `logAction` takes a fixed record instead of `unknown`,
 * and the reason `logWarning` takes identifiers rather than a value.
 */

import type { AppErrorCode } from "../application/errors";

export interface ActionLogEntry {
  /** Action name, e.g. `complete-job`. */
  action: string;
  outcome: "success" | "error";
  /** Present only on `outcome: "error"`. */
  errorCode?: AppErrorCode;
  /** `frontend`, `agent`, `http`, `cli`, … — never a user identity. */
  caller?: string;
  orgId?: string | null;
  durationMs: number;
  requestId?: string;
}

/** One line per action call, success or failure (B16). */
export function logAction(entry: ActionLogEntry): void {
  console.log(
    JSON.stringify({
      level: entry.outcome === "error" ? "error" : "info",
      event: "action",
      action: entry.action,
      outcome: entry.outcome,
      ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
      caller: entry.caller ?? "unknown",
      orgId: entry.orgId ?? null,
      durationMs: entry.durationMs,
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
    }),
  );
}

export interface UnexpectedErrorLogEntry {
  /** Action name the failure happened under. */
  action: string;
  orgId?: string | null;
  /** The value that was thrown, whatever it is. */
  error: unknown;
}

/**
 * The stack of a failure nobody anticipated (B16). This is the one log line
 * that may carry an original message, because it is also the only record of
 * what broke: `toAppError` replaces it with the constant `"Unexpected error"`
 * before the caller ever sees it. Never called for an `AppError` or a
 * `DomainError`, both of which are already explained by `logAction`'s
 * `errorCode`.
 */
export function logUnexpectedError(entry: UnexpectedErrorLogEntry): void {
  const error = entry.error;
  console.error(
    JSON.stringify({
      level: "error",
      event: "unexpected-error",
      action: entry.action,
      orgId: entry.orgId ?? null,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined
        ? { stack: error.stack }
        : {}),
    }),
  );
}

export interface WarningLogEntry {
  /** Short, stable name of what went wrong, e.g. `invalid-json-column`. */
  event: string;
  /** Why it matters, in one sentence. Never contains a stored value. */
  message: string;
  orgId?: string | null;
  /** Identifiers only — the row and column that need looking at. */
  details?: Record<string, string>;
}

/**
 * A recoverable inconsistency that someone should look at: the process carried
 * on with a degraded value (a `null` where an object was stored, say) rather
 * than failing the request.
 */
export function logWarning(entry: WarningLogEntry): void {
  console.log(
    JSON.stringify({
      level: "warn",
      event: entry.event,
      message: entry.message,
      orgId: entry.orgId ?? null,
      ...(entry.details === undefined ? {} : { details: entry.details }),
    }),
  );
}
