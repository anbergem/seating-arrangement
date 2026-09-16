# T08 — Query use cases and actions

Goal: the five read use cases and their action files.

Depends on: T07. Read: F5, F11; B3, B8 (query rows), B16.

## Steps

1. `src/interface/run-app-action.ts` per B16 (`runAppAction`, `toAppError` from T05).
2. Use cases in `src/application/use-cases/`: `list-customers.ts` (`listCustomers(deps, actor, { includeArchived?: boolean; search?: string })`),
   `get-customer.ts`, `list-jobs.ts` (`{ status?: JobStatus; customerId?: string; from?: string; to?: string; includeArchived?: boolean }`; default excludes archived; `from`/`to` are ISO instants compared against `scheduledAt`),
   `get-job.ts` (returns `{ job, customerName }`), `list-recent-activity.ts` (`{ limit?: number; resourceType?: ResourceType; resourceId?: string }`, default limit 20, max 100; returns operations newest first with `undoable: boolean` and `redoable: boolean` computed with `canUndo` and the redo rule from B9 against the current resource versions — load each distinct resource once).
3. Actions `actions/list-customers.ts`, `get-customer.ts`, `list-jobs.ts`, `get-job.ts`,
   `list-recent-activity.ts` following the B16 template with `http: { method: "GET" }`,
   `readOnly: true`, `mcpTool: true`, Zod schemas mirroring the inputs (`from`/`to` as
   `z.string().datetime()`), descriptions that say when to use them.
4. Reconcile the `to` filter: the D1 fragment (T07) is exclusive (`scheduled_at < ?`); change
   `tests/fixtures/in-memory.ts` to the same exclusive comparison and state it in the `listJobs`
   input doc comment (`from` inclusive, `to` exclusive).
5. Unit tests `tests/unit/application/queries.test.ts` with the in-memory dependencies and
   `seedInMemory`: each query returns the seeded rows for `org_acme`; the same queries as the
   outsider (`org_other`) return only `org_other` rows or NOT_FOUND for ids from `org_acme`;
   filters work; `list-recent-activity` marks the `complete-job` operation on `job_completed` as
   undoable, the create operations of customers without later operations as undoable
   (compensation), and the archived job's create operation as not undoable (newer op exists).
6. Verify on the Node dev server: `pnpm db:reset && pnpm dev` then, after inserting an
   `org_members` row with SQL for a user you register via curl (the seed script arrives in
   T11), `GET /_agent-native/actions/list-jobs` returns `[]` with HTTP 200, and as a registered
   user without membership returns HTTP 403 with `errorCode: "AUTHORIZATION"`.

## Deliverables

`src/interface/run-app-action.ts`, `src/application/use-cases/{list-customers,get-customer,list-jobs,get-job,list-recent-activity}.ts`,
five action files, `tests/unit/application/queries.test.ts`.

## Acceptance

```bash
pnpm check
pnpm action list-jobs --help     # prints the action's parameters
```
plus the step 6 transcript.
