/**
 * Domain-level errors (blueprint B4).
 *
 * `VALIDATION` is for malformed input (wrong shape, wrong length, wrong format);
 * `INVARIANT` is for a request that is well-formed but violates a business rule
 * (wrong state for the requested transition). The application layer maps both
 * onto `AppError` (`src/application/errors.ts`) with the same code name.
 */

export type DomainErrorCode = "INVARIANT" | "VALIDATION";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
