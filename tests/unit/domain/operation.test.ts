import { describe, expect, it } from "vitest";

import {
  canUndo,
  OPERATION_CLASSIFICATION,
  type Operation,
} from "../../../src/domain";

function baseOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op_1",
    orgId: "org_1",
    kind: "forward",
    action: "complete-job",
    resourceType: "job",
    resourceId: "job_1",
    classification: "reversible",
    versionBefore: 1,
    versionAfter: 2,
    payload: null,
    inverse: null,
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: "owner@example.invalid",
    performedVia: "ui",
    performedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("OPERATION_CLASSIFICATION", () => {
  it("matches the blueprint table exactly", () => {
    expect(OPERATION_CLASSIFICATION).toEqual({
      "create-customer": "compensatable",
      "archive-customer": "reversible",
      "create-job": "compensatable",
      "reschedule-job": "reversible",
      "start-job": "reversible",
      "complete-job": "reversible",
      "archive-job": "reversible",
      "send-job-to-accounting": "irreversible",
      "undo-operation": "reversible",
      "redo-operation": "reversible",
    });
  });
});

describe("canUndo", () => {
  it("allows undoing a forward operation at its recorded version", () => {
    expect(canUndo(baseOperation(), 2)).toEqual({ ok: true });
  });

  it("allows undoing a redo operation at its recorded version", () => {
    expect(canUndo(baseOperation({ kind: "redo" }), 2)).toEqual({
      ok: true,
    });
  });

  it("refuses to undo an undo operation itself (not-forward)", () => {
    expect(canUndo(baseOperation({ kind: "undo" }), 2)).toEqual({
      ok: false,
      reason: "not-forward",
    });
  });

  it("refuses to undo an operation already undone", () => {
    expect(canUndo(baseOperation({ undoneByOperationId: "op_2" }), 2)).toEqual({
      ok: false,
      reason: "already-undone",
    });
  });

  it("refuses to undo an irreversible operation", () => {
    expect(
      canUndo(
        baseOperation({
          action: "send-job-to-accounting",
          classification: "irreversible",
        }),
        2,
      ),
    ).toEqual({ ok: false, reason: "irreversible" });
  });

  it("refuses to undo when the resource has moved past the recorded version", () => {
    expect(canUndo(baseOperation(), 3)).toEqual({
      ok: false,
      reason: "conflict",
    });
  });
});
