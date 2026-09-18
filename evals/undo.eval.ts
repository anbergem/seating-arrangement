import { defineEval, usesTool } from "@agent-native/core/eval";

import type { Actor } from "../src/application/actor.ts";
import { labelSeat } from "../src/application/use-cases/label-seat.ts";
import { findSeat } from "../src/domain/index.ts";
import { getDependencies } from "../src/infrastructure/container.ts";
import {
  MODEL_EVAL_SKIP_REASON,
  persistedState,
  resetEvalScenario,
  successfulToolCall,
} from "./helpers.ts";

const member: Actor = {
  userEmail: "member1@example.invalid",
  orgId: "org_acme",
  role: "member",
  caller: "eval-setup",
};
let restored = false;

export default defineEval({
  name: "undo the intended seating change",
  input: {
    history: [
      { role: "user", text: "Seat Katherine Johnson at the head table." },
      { role: "assistant", text: "I seated her at the head table." },
    ],
    prompt: "Undo that.",
  },
  skipReason: MODEL_EVAL_SKIP_REASON,
  threshold: 1,
  run: async ({ input, runAgent }) => {
    await resetEvalScenario();
    const labelled = await labelSeat(getDependencies(), member, {
      tableId: "tbl_head",
      seat: 2,
      label: "Katherine Johnson",
    });
    const result = await runAgent({
      ...input,
      prompt: `Undo that seating change. Its operation id is ${labelled.operationId}.`,
    });
    const table = await getDependencies().seatingTables.getById(
      "org_acme",
      "tbl_head",
    );
    restored = table !== null && findSeat(table, 2)?.label === "";
    return result;
  },
  scorers: [
    usesTool("undo-operation"),
    successfulToolCall({
      tool: "undo-operation",
      expectedInput: (value) =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { operationId?: unknown }).operationId === "string",
      expectedResult: (value) =>
        typeof value === "object" &&
        value !== null &&
        JSON.stringify(value).includes('"resourceType":"seating_table"'),
    }),
    persistedState(() => restored),
  ],
});
