/**
 * Application-level errors (blueprint B5).
 *
 * Every use case, action runner and repository adapter throws `AppError`
 * (never a raw `Error`) so the interface layer (`runAppAction`, T08+) always
 * has a stable `code` to map to an HTTP status and a message safe to show an
 * end user or the agent: no SQL, no stack trace, no internal id beyond the
 * resource id itself. `fromDomainError` is the one bridge from the domain
 * layer's narrower `DomainError`; `toAppError` is the catch-all a caller uses
 * on a value of unknown origin.
 */

import { DomainError } from "../domain";

export type AppErrorCode =
  | "VALIDATION"
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVARIANT"
  | "EXTERNAL"
  | "INTERNAL";

export const HTTP_STATUS_FOR: Record<AppErrorCode, number> = {
  VALIDATION: 400,
  AUTHENTICATION: 401,
  AUTHORIZATION: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVARIANT: 422,
  EXTERNAL: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The one message an `INTERNAL` error ever shows outside a log line. */
const UNEXPECTED_ERROR_MESSAGE = "Unexpected error";

/** `DomainError`'s two codes share their name with an `AppErrorCode`, so the
 * mapping is a direct carry-over: `VALIDATION` → `VALIDATION`,
 * `INVARIANT` → `INVARIANT`. */
export function fromDomainError(e: DomainError): AppError {
  return new AppError(e.code, e.message, e.details);
}

/**
 * Normalises any thrown value into an `AppError`: an `AppError` passes
 * through unchanged, a `DomainError` is mapped with `fromDomainError`, and
 * anything else (a framework error, a thrown string, `undefined`, …) becomes
 * `INTERNAL` with the constant message above — never the original message,
 * which might contain a stack trace or an internal detail.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof DomainError) return fromDomainError(err);
  return new AppError("INTERNAL", UNEXPECTED_ERROR_MESSAGE);
}
