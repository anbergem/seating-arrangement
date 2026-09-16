# T10 — Undo and redo

Goal: `undo-operation` and `redo-operation` as audited actions implementing B9 exactly.

Depends on: T09. Read: B4 (`canUndo`), B9, B16; D13.

## Steps

0. Port addition (resolves the T09 discrepancy): add `findCreateOperation(orgId, type, id)` to
   `OperationRepository` in `src/application/ports.ts` (B7), implement it in
   `src/infrastructure/d1/operations-repository.ts` (`SELECT ... WHERE org_id = ? AND resource_type = ? AND resource_id = ? AND kind = 'forward' AND version_before = 0 LIMIT 1`, add the constant to `sql.ts`) and in `tests/fixtures/in-memory.ts`, then replace the bounded `listForResource` lookup in `src/application/use-cases/command.ts` with it and delete `CREATE_OPERATION_LOOKUP_LIMIT`. Add a unit test for the replay path and an integration test in `tests/integration/repositories.test.ts`.
1. `src/application/use-cases/undo-operation.ts` and `redo-operation.ts` per B9. Error
   messages exactly as listed there.
2. Actions `actions/undo-operation.ts` (`{ operationId }`, description: "Undo a previous
   operation when no newer change exists. Refuses with CONFLICT if the record changed since.")
   and `actions/redo-operation.ts` (`{ operationId }` of an undo operation), both
   `mcpTool: true`, audit target from the loaded operation's resource (`audit.target` receives
   `(args, result)`; use `result.resource` type/id).
3. `list-recent-activity`'s `redoable` flag (T08 implemented B9 parts 1–2 only): make it `false`
   when the undo operation's related forward operation is a create (`create-customer`,
   `create-job`), loading that operation by id; add a query test for it.
4. Tests `tests/unit/application/undo.test.ts`: undo of each forward action restores the exact
   previous fields; undo of a create archives the resource; the B9 concurrency scenario;
   `already-undone`, `irreversible` (set a classification manually in state), `not-forward`;
   redo after undo re-applies and marks the undo op; redo refused when the resource moved on;
   redo of a create's undo is INVARIANT; undo/redo operations appear in `list-recent-activity`
   with `kind` set.
5. Verify on the Node dev server: complete a job via curl, undo via curl (status back, version
   + 1), redo via curl; `list-audit-events` shows `undo-operation` and `redo-operation` rows.

## Deliverables

Two use cases, two actions, `tests/unit/application/undo.test.ts`.

## Acceptance

```bash
pnpm check
```
plus the step 5 transcript.
