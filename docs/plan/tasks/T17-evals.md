# T17 — Agent evals

Goal: the eval area with three sample evals gated behind `RUN_MODEL_EVALS=1`, runnable against
the Node dev database.

Depends on: T10, T11. Read: F13; B18 (evals row); D15.

## Steps

1. `evals/complete-job.eval.ts`: prompt "Complete the in-progress job for Example Customer A";
   scorers `usesTool("complete-job")` plus correct target, successful tool result and persisted completed status; `evals/list-today.eval.ts`: prompt "Show me today's
   jobs"; scorers `usesTool("list-jobs")` and a `createScorer` named `no-mutations` scoring 1
   when `toolCalls` contains none of the command action names, else 0; `evals/undo.eval.ts`:
   two-turn `history` (user asked to complete a job, assistant confirmed) then prompt "Undo
   that"; scorer `usesTool("undo-operation")` plus persisted restoration of the intended job. Each has
   `skipReason: process.env.RUN_MODEL_EVALS === "1" ? undefined : "Set RUN_MODEL_EVALS=1 and a configured provider credential to run model-backed evals"`
   and `threshold: 1`. The shared gate, scorers and the scenario reset live in `evals/helpers.ts`
   (`agent-native eval` ignores a file with no eval in it), and the `RUN_MODEL_EVALS` read
   carries the doctor's `// guard:allow-env-credential` marker: it is a run switch, not a
   credential, and `agent-native eval` loads these files itself so nothing else can reach them.
2. `package.json`: `eval` per B15 — `node scripts/run-evals.mjs`, a wrapper rather than
   `agent-native eval` directly, because a model-backed run needs a migrated and seeded
   database of its own and because `agent-native eval` loads the `*.eval.ts` files in a plain
   Node process whose type stripping cannot resolve the extensionless imports the application
   layers use (`NODE_OPTIONS=--import tsx` fixes that). `pnpm eval` with evals skipped must
   exit 0 and must not touch any database.
3. `docs/testing.md` gets its evals section in T23; here add `evals/README.md` (10 lines):
   what evals answer versus Playwright, how to run (`pnpm db:reset && pnpm db:seed &&
   RUN_MODEL_EVALS=1 ANTHROPIC_API_KEY=... AGENT_USER_EMAIL=member1@example.invalid
   AGENT_ORG_ID=org_acme pnpm eval`), and that they are not a PR gate.
4. If a key is available, run once and paste the report; otherwise state that only the skipped
   run was verified and leave model-backed release evidence pending. Include an admin approval
   case for the external action and a member denial; a selected tool alone is not success.

## Deliverables

`evals/*.eval.ts`, `evals/README.md`, `package.json`.

## Acceptance

```bash
pnpm check
pnpm eval           # exits 0 with all evals skipped
```
