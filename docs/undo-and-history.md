# Undo and history

Undo here is **semantic**, not a snapshot restore. Each command records the inverse command
that reverses it, and undo replays that inverse through the same domain functions any other
command uses. So undoing a create archives the record rather than deleting it, and undoing a
transition restores the exact fields it changed — never a status guessed from the action name.

- [Two records, one trail and one ledger](#two-records-one-trail-and-one-ledger)
- [Classification](#classification)
- [The `operations` row](#the-operations-row)
- [The undo algorithm](#the-undo-algorithm)
- [The conflict rule](#the-conflict-rule)
- [Redo](#redo)
- [Who may reverse what](#who-may-reverse-what)
- [Refusals, and what each one means](#refusals-and-what-each-one-means)
- [What the UI does](#what-the-ui-does)
- [Retention](#retention)

## Two records, one trail and one ledger

| | `agent_audit_log` | `operations` |
| --- | --- | --- |
| Owner | The framework | This application (`migrations/0001_init.sql`) |
| Written | Automatically, for every non-GET action | By the use case, inside the same atomic batch as the change |
| Covers | Successes, failures **and** denials | Successful changes only |
| Carries | who, when, which surface, target, redacted input, status, error code | `version_before`, `version_after`, classification, the inverse, the payload, links between operations |
| Answers | "What happened?" | "What can still be reversed, and how?" |
| Read with | `list-audit-events`, `get-audit-event`, `export-audit-events` | `list-recent-activity` |

They are separate because they answer different questions and have different lifetimes. The
audit trail is the record — permanent, complete, and not something the application can rewrite.
The ledger is operational: it is what makes undo possible, and it only needs the rows whose
changes might still be reversed.

The framework's audit row for `complete-job` looks like this (redacted input, one summary
line):

```
action: complete-job   caller: frontend   actor_kind: human
actor_email: member1@example.invalid   org_id: org_acme
target_type: job   target_id: job_in_progress   status: success
summary: Completed job job_in_progress
```

Our operation row for the same change carries what undo needs:

```
kind: forward   action: complete-job   resource_type: job   resource_id: job_in_progress
classification: reversible   version_before: 2   version_after: 3
inverse: {"type":"restore-job-status","previous":{"status":"in_progress",
          "completedAt":null,"archivedAt":null}}
performed_by: member1@example.invalid   performed_via: frontend
```

## Classification

Every command is one of three things, declared in `OPERATION_CLASSIFICATION`
(`src/domain/operation.ts`) and stated in the action's `description` so the agent knows too.

| Classification | Meaning | Commands |
| --- | --- | --- |
| `reversible` | An inverse restores the previous state exactly | `archive-customer`, `reschedule-job`, `start-job`, `complete-job`, `archive-job`, `undo-operation`, `redo-operation` |
| `compensatable` | No inverse, but a documented compensating command exists | `create-customer`, `create-job` |
| `irreversible` | Nothing can undo it | `send-job-to-accounting` |

**Creates are compensatable, not reversible.** Undoing a create archives the record; it does not
delete it. Nothing in this application deletes a row — an archived record keeps its history, its
audit rows and its foreign keys, and a deleted one would strand all three. That is also why a
create can never be *redone*: its "undo" was a compensation, and re-creating would produce a
different record with a different id.

**External effects are never reversible.** A command that writes to a vendor system is
`compensatable` if a compensating call exists there, and `irreversible` otherwise. We do not
own the vendor's data, so we cannot promise to restore it. `send-job-to-accounting` is
irreversible, its action carries `needsApproval: true`, and its dialog in the UI says so before
the user confirms.

Full inverse table:

| Command | Inverse recorded | What the inverse restores |
| --- | --- | --- |
| `create-customer` | `{ type: "archive-customer" }` | Archives the new customer |
| `archive-customer` | `{ type: "restore-customer" }` | Sets it back to `active` |
| `create-job` | `{ type: "archive-job" }` | Archives the new job |
| `reschedule-job` | `{ type: "restore-job-schedule", previousScheduledAt }` | The exact previous instant |
| `start-job` / `complete-job` / `archive-job` | `{ type: "restore-job-status", previous: { status, completedAt, archivedAt } }` | All three fields as they were |
| `send-job-to-accounting` | `null` | — |

`restore-job-status` restores a *triple*, not a status. Archiving a completed job clears
nothing, but completing a job sets `completedAt`, and undoing that has to clear it again — a
status alone would leave a completion timestamp on a job that is no longer completed.

## The `operations` row

```sql
operations (
  id, org_id,
  kind,                    -- 'forward' | 'undo' | 'redo'
  action,                  -- the action name, e.g. 'complete-job'
  resource_type,           -- 'customer' | 'job'
  resource_id,
  classification,          -- 'reversible' | 'compensatable' | 'irreversible'
  version_before,          -- 0 for a create
  version_after,
  payload,                 -- JSON: the arguments redo needs to replay the forward command
  inverse,                 -- JSON: the InverseCommand undo applies
  related_operation_id,    -- undo → the forward op; redo → the undo op
  undone_by_operation_id,  -- set when this operation has been reversed
  performed_by, performed_via, performed_at
)
```

An undo is itself a row (`kind: "undo"`), which is what makes it visible in `/activity` and
what makes redo possible. It carries `inverse: null` and `payload: {}`: an undo is never
undone — `canUndo` refuses it — and redo reads what to replay from the forward operation it
points at through `related_operation_id`.

A redo row (`kind: "redo"`) *does* carry an inverse: the forward operation's own. That is
deliberate, because a redo may be undone again, and that is the inverse such an undo must
apply.

`version_before === 0` is the definition of a create, in the row and in the SQL
(`findCreateOperation`), so the two agree by construction.

## The undo algorithm

`undoOperation(deps, actor, { operationId })`:

1. Load the operation, scoped to the organization. Missing → `NOT_FOUND: Operation not found`.
2. Load the resource named by `resource_type` and `resource_id`. Missing → `NOT_FOUND`.
3. `canUndo(op, resource.version)`. It is `ok` only when **all four** hold:
   - `kind` is `forward` or `redo`;
   - `undone_by_operation_id` is null;
   - `classification` is not `irreversible`;
   - `resource.version === op.version_after`.
4. Check the caller's permission for the effect the inverse has
   (`src/application/history-policy.ts`, below).
5. For a job inverse that would reopen a completed job, refuse if a durable accounting export
   exists — see below.
6. Apply `op.inverse` through the domain: `restore-job-status` → `restoreJobStatus`;
   `restore-job-schedule` → `restoreJobSchedule` (which skips the "same instant" rule, because
   restoring a recorded fact is not a new decision); `archive-job` → `archiveJob`;
   `restore-customer` → `restoreCustomer`; `archive-customer` → `archiveCustomer`.
7. Commit **one atomic batch** containing three statements, all guarded: insert the undo
   operation, update the resource, and set `undone_by_operation_id` on the operation being
   undone. Any guard failing makes the whole batch a no-op.
8. Return `{ resource, operationId: <the undo row>, resourceType }`.

Step 7 is where the safety actually lives. The version is checked twice — in step 3 against
what was just read, and again inside the SQL — and the "mark undone" statement additionally
requires the undoing operation row to exist, so an operation can never be marked undone by a
row that was not written.

Step 5 is the external-integration interaction: an invoice intent survives retries, so history
must not reopen the completed work it refers to. `reopensCompletedJob` recognises an inverse
that would restore `scheduled` or `in_progress`, and the repository's `commit` rechecks the
condition **inside** the atomic write (`requireNoAccountingExport`) rather than only before it,
because an export request can appear between the read and the write. The refusal is
`INVARIANT: A job with an accounting export cannot be reopened`. Archiving such a job, and
restoring it to `completed`, both remain possible — the accounting fields are preserved.

## The conflict rule

**Undo is allowed only while the resource is exactly at the version the operation left it at.**

Completing `job_in_progress` moves it 2 → 3 and records `version_after: 3`. Undo is allowed
while the job is at version 3. If anything changed it since — the same user in another tab, a
coworker, the agent, an HTTP client — undo is refused with
`CONFLICT: Newer changes exist; undo refused`.

The alternative would be to apply the inverse anyway, which silently discards whatever the
other change did. For a business application that is worse than refusing: the user who is told
"this changed, look again" loses thirty seconds; the user whose colleague's edit vanished loses
trust in the record.

The scenario the tests pin (`tests/unit/application/undo.test.ts`, repeated against real SQL in
`tests/integration/` and through the browser in `tests/e2e/undo-conflict.spec.ts`):

| Step | Actor | Result |
| --- | --- | --- |
| Reschedule the job, v12 → v13 | A | `op1` recorded, `version_after: 13` |
| Complete the job, v13 → v14 | B | `op2` recorded, `version_after: 14` |
| `undo-operation(op1)` | A | **`CONFLICT`** — 14 ≠ 13 |
| `undo-operation(op2)` | B | Ok, v15 |
| `undo-operation(op1)` | A | **Still `CONFLICT`** — 15 ≠ 13 |

That last row is the point people miss: undoing the newer change does not make the older one
undoable again. Each undo is a new version, and the older operation's `version_after` is
receding. History is a stack you can pop, not a set you can pick from.

## Redo

`redoOperation(deps, actor, { operationId })` takes an **undo** operation's id and re-runs the
original forward command:

1. Load the undo row. Not `kind: "undo"` → `INVARIANT: Only an undo operation can be redone`.
2. Already reverted → `INVARIANT: This undo has already been redone`.
3. Resource not at `undoOp.version_after` → `CONFLICT: Newer changes exist; redo refused`.
4. Load the forward operation through `related_operation_id`. A create →
   `INVARIANT: A create cannot be redone`.
5. Re-run that command's domain transition with the stored `payload`:
   `completeJob(resource, now)`, `rescheduleJob(resource, payload.scheduledAt, now)`, and so
   on. The forward command's *own capability* is required as well.
6. Record a `redo` row carrying the forward operation's inverse, and mark the undo row
   `undone_by_operation_id`.

Redo re-applies the command; it does not restore a snapshot. So a redo runs the domain rules
again, and can fail if the record has moved somewhere the transition is not legal from.

One sequence is deliberately refused rather than guessed: undo → redo → undo leaves an undo
whose `related_operation_id` names a *redo* row, whose `action` is `redo-operation` and not a
domain command. There is nothing to replay, so it is `INVARIANT: This operation cannot be
redone`. Walking the chain twice to find the original would work, but a guess in a history
mechanism is worse than a refusal; `tests/unit/application/undo.test.ts` pins the behaviour
with the test name *refuses to redo the undo of a redo, rather than guessing*.

## Who may reverse what

Undo must not become a way around a capability. Both commands need `history:undo`, **and** the
capability for the effect the reversal actually has (`src/application/history-policy.ts`):

| Inverse | Requires |
| --- | --- |
| `archive-customer` (undoing a create) | `customers:archive`, **or** `customers:create` when the caller performed the create themselves |
| `restore-customer` (undoing an archive) | `customers:archive` |
| `restore-job-schedule` | `jobs:reschedule` |
| `restore-job-status`, `archive-job` | `jobs:transition` |

So a member may compensate their own `create-customer` — the mistake-correction case that
actually matters — but cannot undo an admin's archive, and cannot compensate somebody else's
create. Job changes may be reversed by any coworker with the matching job capability, because
that work is shared.

Permission is evaluated against the caller's **current** role. Somebody demoted this morning
cannot undo what they did yesterday. `list-recent-activity` runs the same policy to compute its
`undoable` and `redoable` flags, so the buttons a user sees match what the server will allow.

## Refusals, and what each one means

| Message | Code | HTTP | What to do |
| --- | --- | --- | --- |
| `Operation not found` | `NOT_FOUND` | 404 | Wrong id, or another organization's operation |
| `Already undone` | `CONFLICT` | 409 | Somebody already undid it. Use redo. |
| `Newer changes exist; undo refused` | `CONFLICT` | 409 | Re-read the record and decide again |
| `Newer changes exist; redo refused` | `CONFLICT` | 409 | Same |
| `This operation cannot be undone` | `INVARIANT` | 422 | It is `irreversible`. Nothing will change that. |
| `Use redo for an undo operation` | `INVARIANT` | 422 | You passed an undo row to undo |
| `Only an undo operation can be redone` | `INVARIANT` | 422 | You passed a forward row to redo |
| `This undo has already been redone` | `INVARIANT` | 422 | Undo it again first |
| `A create cannot be redone` | `INVARIANT` | 422 | Create the record again instead |
| `This operation cannot be redone` | `INVARIANT` | 422 | The chain has no domain command to replay |
| `A job with an accounting export cannot be reopened` | `INVARIANT` | 422 | The invoice intent is durable; archive it instead |
| `You may not reverse this operation` | `AUTHORIZATION` | 403 | The caller lacks the effect's capability |

`CONFLICT` means "re-read and try again". `INVARIANT` means "this will never work". The UI can
offer a refresh for one and not the other.

## What the UI does

After every successful mutation, `app/components/activity/use-operation-feedback.ts` shows a
`sonner` toast with the change's summary and an **Undo** button wired to the returned
`operationId`. After a successful undo, the toast offers **Redo** with the undo's own operation
id. That is the whole affordance: undo is one click away for a few seconds, and a permanent
list is one page away.

`/activity` renders `list-recent-activity`: the recent operations, who performed each one, from
which surface, and Undo or Redo where the policy allows it. An `irreversible` operation renders
no button at all — the accounting export appears in the history with no affordance, which is
the honest presentation.

A conflict surfaces as the translated `errors.CONFLICT` string, *This record changed. Refresh
and try again.*, with the server's message as the fallback. The user's next action is to reload
and look at what the record says now.

## Retention

The `operations` table is never pruned by this application. It is small — one row per change —
and it is the only record of *how* a change could be reversed.

The framework's audit log has its own retention, set per environment through
`AGENT_NATIVE_AUDIT_RETENTION_DAYS`: 365 days on staging, `0` (forever) on production. Both
tables live in the same D1 database and are therefore covered by the same backups and the same
Time Travel bookmarks.
