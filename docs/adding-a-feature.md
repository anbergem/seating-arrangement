# Adding a feature

One worked example, end to end, naming every file. The feature: **rename an event**.

An event's name is set when it is created and there is no way to change it afterwards, so
`rename-event` is a real gap and a good size: a new transition on an existing entity, a
capability question, an inverse, and one UI control.

The order below matters. Each step's tests should pass before you start the next one; a feature
built bottom-up is a feature you can debug.

## 0. Decide what the action is called

Kebab-case verb, and it must be something the business does. `rename-event`, not
`update-event-name`. The name is the file name, and the file name is what the agent sees as a
tool, what an MCP client sees, what the HTTP path is, and what the audit rows say. Getting it
right first saves renaming five things.

## 1. The domain rule

`src/domain/event.ts`:

```ts
export function renameEvent(event: Event, name: string, now: string): Event {
  if (event.status === "archived") {
    throw new DomainError("INVARIANT", "Cannot rename an event that is archived");
  }
  const normalized = normalizeName(name);
  if (normalized === event.name) {
    throw new DomainError("INVARIANT", "The event already has that name");
  }
  return { ...event, name: normalized, version: event.version + 1, updatedAt: now };
}
```

Three properties to keep: `now` is an argument, not `Date.now()`; the result is a new object
with `version + 1`; and it throws `DomainError`, never `AppError` — the domain does not know
what an HTTP status is. `normalizeName` is already in the file, so the length rule and the
trimming are stated once.

Note what it does **not** do: it does not check that no other event is already called that.
That would need the database, so it could not live here — and, as step 4 explains, in this
codebase it could not live in the use case either.

`src/domain/index.ts` already re-exports everything in `event.ts`, so a new function in an
existing file needs no export change. Write the test first:
`tests/unit/domain/event.test.ts` — the happy path, `INVARIANT` from `archived`, `INVARIANT`
for a no-op rename, `VALIDATION` for a blank or over-long name, the stored name trimmed, and
`version` incremented exactly once.

```bash
pnpm test:unit
```

## 2. The capability

Reuse `events:create`? No. Creating your own event and renaming one the whole organization is
already planning around are different acts: the second changes what everybody else sees the
occasion is called, which puts it in the same class as taking it off the list. So it goes
beside `events:archive`, in `src/application/authorization.ts`:

```ts
export type Capability =
  | …
  | "events:rename";

const ADMIN_CAPABILITIES: readonly Capability[] = [
  ...MEMBER_CAPABILITIES,
  "events:archive",
  "events:rename",
];
```

Had it been an ordinary member's job, it would go in `MEMBER_CAPABILITIES` instead, which
`ADMIN_CAPABILITIES` spreads, so admin and owner inherit it either way. Update
`tests/unit/application/authorization.test.ts`: the role table is asserted there, so a new
capability that is not in the expectation fails the test — which is the point.

Rule of thumb: a new capability is right when a role should be able to do one of two related
things but not the other. If every role that can do X can also do Y, reuse X's capability.
That is why every seating write shares one `seating:write`: nobody may label a seat but not
move a table.

## 3. The use case

`src/application/use-cases/rename-event.ts`:

```ts
export interface RenameEventInput {
  eventId: string;
  name: string;
  expectedVersion?: number;
}

export async function renameEvent(
  deps: Dependencies,
  actor: Actor,
  input: RenameEventInput,
): Promise<CommandResult<Event>> {
  requireCapability(actor, "events:rename");

  const event = await deps.events.getById(actor.orgId, input.eventId);
  if (!event) throw new AppError("NOT_FOUND", "Event not found");
  if (input.expectedVersion !== undefined && input.expectedVersion !== event.version) {
    throw new AppError("CONFLICT", "The event was changed by someone else");
  }

  const now = deps.clock.now();
  const next = applyDomain(() => renameEventDomain(event, input.name, now));
  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "rename-event",
    resourceType: "event",
    resourceId: event.id,
    classification: "reversible",
    versionBefore: event.version,
    versionAfter: next.version,
    payload: { name: next.name },
    inverse: { type: "restore-event-name", previousName: event.name },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };
  await deps.events.commit({ event: next, expectedVersion: event.version, operation });
  return { resource: next, operationId: operation.id };
}
```

The shape is the same in every command, in this order, and the order is not arbitrary:

1. **Capability first.** Before any read. A denial must not depend on whether the record
   exists, or a 403/404 difference tells an outsider what exists.
2. **Load, scoped to `actor.orgId`.** Missing or foreign → `NOT_FOUND`.
3. **`expectedVersion`**, when the caller supplied one.
4. **Cross-record validation** that needs the database — this feature has none; see below.
5. **The domain transition**, wrapped in `applyDomain` so a `DomainError` becomes the matching
   `AppError`.
6. **The operation row**, including the inverse.
7. **One atomic commit**, guarded on the version you read.
8. **Return `{ resource, operationId }`.** The `operationId` is what the UI's Undo button and
   the agent's `undo-operation` call need.

### Step 4, and why this feature skips it

Suppose you wanted "no two active events may share a name". You could read the event list here
and refuse a collision — and it would be wrong, in a way that is easy to miss and impossible to
see in a single-user test. D1 cannot hold a transaction open between that read and the write,
so two people renaming two events to the same thing would both pass the check against their own
snapshot and both land.

A rule that must always hold goes **into the database as a constraint**, the way the floor
plan's no-overlap rule does: `seating_cells` carries one row per cell a table covers, with a
primary key on `(org_id, event_id, x, y)`, so the loser of a race violates it and the whole
batch is rolled back. A uniqueness rule here would be a `UNIQUE (org_id, lower(name))` index
plus a repository that maps the violation onto an `AppError` — see `isCellCollision` in
`src/infrastructure/d1/seating-tables-repository.ts` for that shape.

Step 4 is for validation the database genuinely cannot express and a stale answer genuinely
cannot hurt — "is this email a member of the organization", which is a bad *argument* rather
than a rule about the record being written. That is why `VALIDATION`, not `NOT_FOUND`: from the
caller's point of view it is not a record lookup.

Test the use case in `tests/unit/application/seating-commands.test.ts` against the in-memory
doubles in `tests/fixtures/in-memory.ts`: the happy path, a member refused, `NOT_FOUND` for an
event id from another organization, `CONFLICT` on a stale `expectedVersion`, and the operation
row's `inverse` recorded correctly.

## 4. The inverse

Step 3 recorded `{ type: "restore-event-name", previousName }`, which does not exist yet. Three
files:

- `src/domain/operation.ts`: add the variant to the `InverseCommand` union, and
  `"rename-event": "reversible"` to `OPERATION_CLASSIFICATION`.
- `src/domain/event.ts`: `restoreEventName(event, previousName, now)` — like `renameEvent` but
  without the "already has that name" rule, because an undo restores a recorded fact rather
  than making a new decision. Still `version + 1`. Whether it should also drop the archived
  check is a real question: the seating restores keep their placement checks, because the space
  they want back may have been taken, but a name nobody else can be holding is safe to put back.
- `src/application/use-cases/undo-operation.ts`: a case in `applyEventInverse`, and
  `src/application/history-policy.ts`: which capability reversing it requires
  (`events:rename`), in both `FORWARD_CAPABILITIES` and the `mayUndo` switch.

Then `src/application/use-cases/redo-operation.ts` needs to know how to replay the forward
command from the stored `payload` — here, a case in `reapplyEventForward` calling
`renameEvent(event, payloadString(forward.payload, "name"), now)`.

Test the round trip in `tests/unit/application/seating-undo.test.ts`: rename, undo (the old
name is back), redo (the new name is back), and undo refused with `CONFLICT` when something
else changed the event in between.

## 5. The database

`name` already exists as a column and `UPDATE_EVENT_VERSIONED` already sets it, so this feature
needs no migration and no new statement. If it did:

```bash
pnpm exec wrangler d1 migrations create seating-arrangement-local "event name history"
# writes migrations/0002_event_name_history.sql
```

Write the SQL, mirror the column in `server/db/schema.ts`, apply it locally with
`pnpm db:migrate` (Node file) and `pnpm db:migrate:worker` (local D1), and add a value for it
to `tests/fixtures/scenario.ts` if it is NOT NULL. Never edit a migration that has been applied
anywhere. `docs/database-and-migrations.md` has the rest.

If you add a statement, it must contain `org_id = ?`, or
`tests/unit/infrastructure/sql-scoping.test.ts` fails. The same test also rejects any quoted
literal outside a short allow-list, so a new enum value compared against inside SQL has to be
added there deliberately.

## 6. The action

`actions/rename-event.ts` — declaration only:

```ts
export default defineAction({
  description:
    "Rename an event. Only an admin or owner may do this, because it changes what everyone " +
    "in the organization sees the occasion is called. Not allowed once the event is archived. " +
    "Reversible: undo-operation restores the previous name.",
  schema: z.object({
    eventId: z.string().min(1).describe("Id of the event to rename"),
    name: z.string().min(1).describe("The new name, 1 to 120 characters"),
    expectedVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Version last read with get-event; the call fails with CONFLICT if the event changed since",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (args) => ({ type: "event", id: args.eventId, visibility: "org" }),
    summary: (args) => `Renamed event ${args.eventId} to ${args.name}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "rename-event", (actor, deps) => renameEvent(deps, actor, args)),
});
```

The `description` is a prompt, not a comment: it is what the model reads when deciding whether
this is the tool it wants. Say when to use it, what it is allowed from, and whether it is
reversible. `.describe()` on each field does the same job for the arguments.

Add the name to `INITIAL_TOOL_NAMES` in `server/plugins/agent-chat.ts`, and — if the action
mutates — to the `commands` set in `evals/helpers.ts`, which is what the `noMutations` scorer
checks against. Those two lists are the only manual registration in the action pipeline;
everything else is discovered from the file name.

Run it before touching any UI:

```bash
AGENT_USER_EMAIL=admin@example.invalid AGENT_ORG_ID=org_acme \
  pnpm action rename-event '{"eventId":"evt_gala","name":"Spring Gala 2027"}'
```

That is the whole feature working, through the CLI surface, with no browser involved. If it
works here it works for the agent, for MCP and over HTTP, because they are the same code path.

## 7. The UI

`app/routes/events_.$id.tsx` — an input and a button, beside the existing archive control:

```tsx
const rename = useActionMutation("rename-event");
// …
await rename.mutateAsync({ eventId, name, expectedVersion: event.version });
```

Then, on success, the same toast treatment every other mutation gets: `useOperationFeedback`
(`app/components/activity/use-operation-feedback.ts`) shows the message with an **Undo** button
wired to the returned `operationId`, and a **Redo** after an undo.

Rules the boundary checker and the guards enforce here:

- The route may import a **type** or a **pure helper** from `src/domain` and nothing else from
  `src`. `app/components/seating/geometry.ts` is the one place that does it, so the allowance
  stays visible; import from a specific module rather than the `src/domain` barrel, or the
  whole domain lands in the browser bundle.
- No business rule in the component. Do not disable the control because the event is archived —
  or rather, do, for the user's sake, but understand that the server refusing is the actual
  constraint and that is what the test asserts.
- Every string through `useT()`, added to **both** `app/i18n/en-US.ts` and `app/i18n/nb-NO.ts`
  with the same keys and the same `{{placeholders}}`. `pnpm guard:i18n` fails on a missing key,
  a mismatched placeholder, or a single-brace `{name}` that the framework will never substitute.
  A dynamic `t(\`prefix.${x}\`)` additionally needs its family registered in
  `scripts/check-i18n-catalogs.mjs`; a switch over literal keys avoids that entirely, which is
  what `armName()` in `app/components/seating/SeatPanel.tsx` does.
- Every control gets an `aria-label` or a visible label, so a test can find it and a screen
  reader can announce it.

Hiding the control from a role it is not available to uses `useOrgRole()`, which the event page
already does for the archive button. That is courtesy; the server check is the security.

## 8. Browser and agent coverage

`tests/e2e/seating.spec.ts` (or a new spec): an admin opens an event, renames it, and the
change shows up on the page and in `/activity` with a working Undo. `tests/e2e/authorization.spec.ts`
is where the member-is-refused half belongs.

`agent/AGENTS.md`: add the action to the command table with its reversibility. That file is the
deployed agent's system prompt — the model does not read this repository.

`evals/rename-event.eval.ts`, if renaming is something people will ask the agent to do:

```ts
export default defineEval({
  name: "rename the intended event",
  input: { prompt: "Call the Spring Gala 'Spring Gala 2027' instead." },
  scorers: [usesTool("rename-event"), /* a custom scorer checking the arguments */],
  skipReason: MODEL_EVAL_SKIP_REASON,
});
```

Evals need a provider key and are release evidence, not a pull-request gate.

## 9. Finish

```bash
pnpm check
pnpm test:integration
pnpm verify:worker
pnpm test:e2e:full
```

In the pull request, answer the nine questions from the "Mutating action checklist" in
`AGENTS.md` and paste those four outputs. If reality disagreed with anything in these
documents, fix the document in the same change.

## The files this feature touched

```
src/domain/event.ts                              renameEvent, restoreEventName
src/domain/operation.ts                          InverseCommand variant, classification
src/application/authorization.ts                 events:rename
src/application/history-policy.ts                which capability reverses it
src/application/use-cases/rename-event.ts        new
src/application/use-cases/undo-operation.ts      apply the new inverse
src/application/use-cases/redo-operation.ts      replay the forward command
actions/rename-event.ts                          new
server/plugins/agent-chat.ts                     the agent's initial tool list
app/routes/events_.$id.tsx                       the control
app/i18n/en-US.ts  app/i18n/nb-NO.ts             strings, both catalogs
agent/AGENTS.md                                  the runtime agent's tool table
tests/unit/domain/event.test.ts                  transitions
tests/unit/application/authorization.test.ts     the role table
tests/unit/application/seating-commands.test.ts  the use case
tests/unit/application/seating-undo.test.ts      the round trip
tests/e2e/seating.spec.ts                        the browser flow
tests/e2e/authorization.spec.ts                  the role boundary
evals/rename-event.eval.ts                       optional
```

Nineteen files for one verb. That is the cost of the boundaries, and it is why
`ARCHITECTURE.md` argues for capabilities over CRUD rather than assuming it: a generic
`update-event` would be three files and would put the rename rules, the audit summary and the
inverse in the caller's hands.
