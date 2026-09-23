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

The framework's audit row for `label-seat` looks like this (redacted input, one summary line):

```
action: label-seat   caller: frontend   actor_kind: human
actor_email: member1@example.invalid   org_id: org_acme
target_type: seating_table   target_id: tbl_head   status: success
summary: Seated Katherine Johnson at seat 4
```

Our operation row for the same change carries what undo needs:

```
kind: forward   action: label-seat   resource_type: seating_table   resource_id: tbl_head
classification: reversible   version_before: 3   version_after: 4
payload: {"seat":3,"label":"Katherine Johnson"}
inverse: {"type":"restore-seat-label","seat":3,"previousLabel":""}
performed_by: member1@example.invalid   performed_via: frontend
```

## Classification

Every command is one of three things, declared in `OPERATION_CLASSIFICATION`
(`src/domain/operation.ts`) and stated in the action's `description` so the agent knows too.

| Classification | Meaning | Commands |
| --- | --- | --- |
| `reversible` | An inverse restores the previous state exactly | `archive-event`, `move-seating-table`, `rotate-seating-table`, `reshape-seating-table`, `label-seat`, `resize-room`, `archive-seating-table`, `undo-operation`, `redo-operation` |
| `compensatable` | No inverse, but a documented compensating command exists | `create-event`, `create-seating-table` |
| `irreversible` | Nothing can undo it | none today; an external effect would be |

**Creates are compensatable, not reversible.** Undoing a create archives the record; it does not
delete it. Nothing in this application deletes a row — an archived record keeps its history, its
audit rows and its foreign keys, and a deleted one would strand all three. That is also why a
create can never be *redone*: its "undo" was a compensation, and re-creating would produce a
different record with a different id.

**External effects are never reversible.** A command that writes to a vendor system is
`compensatable` if a compensating call exists there, and `irreversible` otherwise. We do not own
the vendor's data, so we cannot promise to restore it. This application has no such command
today; when it gains one, its action carries `needsApproval: true` and its dialog in the UI says
so before the user confirms. `docs/integrations.md` has the pattern.

Full inverse table:

| Command | Inverse recorded | What the inverse restores |
| --- | --- | --- |
| `create-event` | `{ type: "archive-event" }` | Archives the new event |
| `archive-event` | `{ type: "restore-event" }` | Sets it back to `active` |
| `create-seating-table` | `{ type: "archive-seating-table" }` | Takes the new table off the plan |
| `move-seating-table` | `{ type: "restore-seating-table-position", previous: { gridX, gridY } }` | The exact cell it stood in |
| `rotate-seating-table` | `{ type: "restore-seating-table-rotation", previous: { rotation, gridX, gridY } }` | The way it faced *and* where it stood, since turning moves it |
| `reshape-seating-table` | `{ type: "restore-seating-table-shape", previous: { kind, size, endSeats, seats } }` | The whole seat array, labels included |
| `resize-room` | `{ type: "restore-room-size", previous: { width, height } }` | The floor's previous size, if nothing has been put in the space since |
| `bootstrap-event-layout` | `{ type: "undo-bootstrap", tableIds, previousRoom }` | Archives every table the layout placed **and** puts the room back — one compensation for a write that spanned both |
| `label-seat` | `{ type: "restore-seat-label", seat, previousLabel }` | The name that was on that seat |
| `move-seat` | `{ type: "restore-seat-placement", from: { tableId, seat, label }, to: { tableId, seat, label } }` | The name each of the two seats had. Recorded labels rather than "swap it back": somebody may have written a different name on one of them since, and swapping again would carry *theirs* to the other seat |
| `shift-seats` | `{ type: "restore-seat-labels", seats: [{ tableId, seat, label }] }` | The name every chair the shift touched had. One shape covers a bench that slid along and a table that turned right round, and — for the same reason as above — it records labels rather than running the permutation backwards |
| `archive-seating-table` | `{ type: "restore-seating-table" }` | Puts the table back where it stood |

`restore-seating-table-shape` records the whole `seats` array, not just the `kind` and `size`
that describe the form. Seats are derived from the shape and numbered around its outline, so
reshaping a table renumbers every chair and discards the ones the new form has no room for — an
undo that restored only the form would bring back a row of empty chairs instead of the people
who were sitting in them.

**A seating inverse can legitimately fail, and that is not a bug.** Three of them —
`restore-seating-table-position`, `restore-seating-table-shape` and `restore-seating-table` —
put a table back into *space*, and the space may have been taken while it was away. Those
restores re-run the placement rules in `src/domain/seating-table.ts` and their writes carry the
same free-space predicate a forward move does, so an undo that would produce an overlapping plan
is refused with `INVARIANT: Tables may not overlap`. `restore-seat-label` and
`restore-seat-placement` can fail for the same reason, less obviously: a name is what makes a
chair claim its cell, so a chair standing empty since the name left it may have had a table
pushed into it.

## The `operations` row

```sql
operations (
  id, org_id,
  kind,                    -- 'forward' | 'undo' | 'redo'
  action,                  -- the action name, e.g. 'label-seat'
  resource_type,           -- 'event' | 'seating_table'
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
what makes redo possible. It carries `inverse: null` and, with one exception, `payload: {}`: an
undo is never undone — `canUndo` refuses it — and redo reads what to replay from the forward
operation it points at through `related_operation_id`.

The exception is a seat write that spans several tables — `move-seat` across two of them, or a
`shift-seats` along a row of chairs that runs through more — and it is the one place `payload`
carries something other than arguments. `version_before` and `version_after` speak for the one
resource the row names, and such a write changed others; their versions therefore ride in
`payload.others` as `[{ tableId, versionBefore, versionAfter }]`. Undo reads them off the
forward row before it writes, and redo off the undo row — each time from the write that left
those tables where they now stand. Without them, undoing would write over the other tables
blind, and a change somebody else made to one of them would vanish without a word.

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
5. For a seating inverse, load the event's other active tables too: most of them put something
   back into space, and the placement rules need to see what is standing there now. A
   `restore-seat-placement` across two tables loads the second table as well, and refuses with
   `CONFLICT` unless they are still at the versions in `payload.others` — step 3 can only check
   the one table the row names.
6. Apply `op.inverse` through the domain: `restore-seating-table-position` →
   `restoreSeatingTablePosition`; `restore-seating-table-shape` → `restoreSeatingTableShape`;
   `restore-seat-label` → `restoreSeatLabel` (which skips the "already has that label" rule,
   because restoring a recorded fact is not a new decision); `restore-seat-placement` →
   `restoreSeatPlacement`, which skips the forward rules for the same reason;
   `restore-seat-labels` → `restoreSeatLabels`, which writes only the chairs whose name has
   actually changed; `restore-seating-table` →
   `restoreSeatingTable`; `archive-seating-table` → `archiveSeatingTable`; and, for an event,
   `restore-event` → `restoreEvent`; `archive-event` → `archiveEvent`.
7. Commit **one atomic batch** containing three statements, all guarded: insert the undo
   operation, update the resource, and set `undone_by_operation_id` on the operation being
   undone. Any guard failing makes the whole batch a no-op. Undoing a seat write that spanned
   several tables writes every one of them and its cells in that same batch, through
   `commitTables` — there, the audit row is the only statement that checks a version, and
   everything else asks whether it landed, because independent version guards in one batch is a
   partial write waiting to happen.
8. Return `{ resource, operationId: <the undo row>, resourceType }`.

Step 7 is where the safety actually lives. The version is checked twice — in step 3 against
what was just read, and again inside the SQL — and the "mark undone" statement additionally
requires the undoing operation row to exist, so an operation can never be marked undone by a
row that was not written.

Steps 5 and 7 together are why an undo that restores a *place* can still lose: the domain check
in step 6 ran against tables read in step 5, and something could take those cells between the
two. The commit rewrites the table's rows in `seating_cells` inside the same batch, so the race
ends in a refused primary key rather than an overlapping plan.

## The conflict rule

**Undo is allowed only while the resource is exactly at the version the operation left it at.**

Labelling a seat on `tbl_head` moves it 3 → 4 and records `version_after: 4`. Undo is allowed
while the table is at version 4. If anything changed it since — the same user in another tab, a
coworker, the agent, an HTTP client — undo is refused with
`CONFLICT: Newer changes exist; undo refused`.

The alternative would be to apply the inverse anyway, which silently discards whatever the
other change did. For a business application that is worse than refusing: the user who is told
"this changed, look again" loses thirty seconds; the user whose colleague's edit vanished loses
trust in the record.

The scenario the tests pin (`tests/unit/application/seating-undo.test.ts`, repeated against
real SQL in `tests/integration/use-cases-d1.test.ts` and through the browser in
`tests/e2e/undo-conflict.spec.ts`):

| Step | Actor | Result |
| --- | --- | --- |
| Label a seat, v12 → v13 | A | `op1` recorded, `version_after: 13` |
| Label another seat, v13 → v14 | B | `op2` recorded, `version_after: 14` |
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
   `moveSeatingTable(resource, { gridX, gridY }, siblings, now)`,
   `labelSeat(resource, seat, payload.label, now)`, and so on. The forward command's *own
   capability* is required as well. These are the ordinary domain functions, not the undo-only
   restore twins: a redo moves the record back off wherever the undo put it, so the "already
   there" rules are not in the way.
6. Record a `redo` row carrying the forward operation's inverse, and mark the undo row
   `undone_by_operation_id`.

Redo re-applies the command; it does not restore a snapshot. So a redo runs the domain rules
again, and can fail if the record has moved somewhere the transition is not legal from.

One sequence is deliberately refused rather than guessed: undo → redo → undo leaves an undo
whose `related_operation_id` names a *redo* row, whose `action` is `redo-operation` and not a
domain command. There is nothing to replay, so it is `INVARIANT: This operation cannot be
redone`. Walking the chain twice to find the original would work, but a guess in a history
mechanism is worse than a refusal.

## Who may reverse what

Undo must not become a way around a capability. Both commands need `history:undo`, **and** the
capability for the effect the reversal actually has (`src/application/history-policy.ts`):

| Inverse | Requires |
| --- | --- |
| `archive-event` (undoing a create) | `events:archive`, **or** `events:create` when the caller performed the create themselves |
| `restore-event` (undoing an archive) | `events:archive` |
| every seating inverse | `seating:write` |

So a member may compensate their own `create-event` — the mistake-correction case that actually
matters — but cannot undo an admin's archive, and cannot compensate somebody else's create.
Seating changes may be reversed by any coworker who could have made them, because a floor plan
is shared work and there is no seating capability a role can hold one half of.

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
| `Tables may not overlap` | `INVARIANT` | 422 | The space the table wants back has been taken; move whatever is there first |
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
which surface, and Undo or Redo where the policy allows it. An operation the policy will not
let this caller reverse renders no button at all, which is the honest presentation — and an
`irreversible` one never would, whoever is looking.

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
