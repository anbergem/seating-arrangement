import {
  ExternalSystemError,
  type AccountingInvoiceDraft,
  type ExternalAccountingSystem,
} from "../../application/ports/external-accounting";

type Failure = {
  phase: "before-acceptance" | "after-acceptance";
  message: string;
};

/** Process-local deterministic vendor double. Its map models vendor-owned
 * state and can outlive recreated use-case/repository objects when the same
 * adapter instance is retained. */
export interface MockAccountingSystem extends ExternalAccountingSystem {
  failNextCall(message: string, phase?: Failure["phase"]): void;
  callCount(): number;
  acceptedCount(): number;
}

export function createMockAccountingSystem(): MockAccountingSystem {
  const accepted = new Map<string, string>();
  let nextFailure: Failure | null = null;
  let calls = 0;

  const accept = (input: AccountingInvoiceDraft): string => {
    const existing = accepted.get(input.idempotencyKey);
    if (existing) return existing;
    const reference = `ACC-${input.job.id}`;
    accepted.set(input.idempotencyKey, reference);
    return reference;
  };

  return {
    failNextCall: (message, phase = "before-acceptance") => {
      nextFailure = { phase, message };
    },
    callCount: () => calls,
    acceptedCount: () => accepted.size,
    createInvoiceDraft: async (input) => {
      calls += 1;
      const failure = nextFailure;
      nextFailure = null;
      if (failure?.phase === "before-acceptance") {
        throw new ExternalSystemError(failure.message);
      }
      const alreadyExisted = accepted.has(input.idempotencyKey);
      const externalReference = accept(input);
      if (failure?.phase === "after-acceptance") {
        throw new ExternalSystemError(failure.message);
      }
      return { externalReference, alreadyExisted };
    },
  };
}
