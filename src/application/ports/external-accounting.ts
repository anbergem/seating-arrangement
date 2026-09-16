/**
 * The external accounting port (blueprint B22).
 *
 * This is the one boundary in this application that ever calls outside the
 * process: `send-job-to-accounting` (T27) posts an invoice draft to a vendor
 * system through it. Kept in its own file, separate from `ports.ts` (whose
 * `Dependencies.accounting` field re-exports this interface), so that a
 * project swapping the vendor only ever touches this file, the adapter that
 * implements it, and the container wiring — never the rest of the
 * application layer.
 */

/**
 * Thrown by an `ExternalAccountingSystem` adapter when the vendor call
 * fails. Its `message` must already be safe to show a user or the agent; the
 * use case maps it to `AppError("EXTERNAL", "Accounting system unavailable:
 * <message>")` and writes nothing locally.
 */
export class ExternalSystemError extends Error {}

export interface AccountingInvoiceDraft {
  idempotencyKey: string;
  orgId: string;
  customer: { id: string; name: string };
  job: { id: string; title: string; completedAt: string };
}

export interface ExternalAccountingSystem {
  /** The vendor must make this operation idempotent for `idempotencyKey`.
   * A thrown error may happen before acceptance or after acceptance while the
   * response is in flight, so callers always retry the same immutable input. */
  createInvoiceDraft(
    input: AccountingInvoiceDraft,
  ): Promise<{ externalReference: string; alreadyExisted: boolean }>;
}
