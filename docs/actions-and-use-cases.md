# Actions and use cases

An action is the application's only entry point. Everything a user, an agent, an MCP client, an
HTTP client or the CLI can do, it does by calling one.

- [Anatomy of an action](#anatomy-of-an-action)
- [The runner](#the-runner)
- [The error model](#the-error-model)
- [Concurrency and `expectedVersion`](#concurrency-and-expectedversion)
- [Idempotency](#idempotency)
- [Queries versus commands](#queries-versus-commands)
- [The action catalogue](#the-action-catalogue)
- [Calling an action from each surface](#calling-an-action-from-each-surface)

## Anatomy of an action

`actions/<name>.ts` contains a `defineAction` declaration and one call to `runAppAction`. No
logic, no database, no branching. It may import `src/interface`, types from `src/application`,
`@agent-native/core/action` and `zod` — and nothing else.

```ts
// actions/label-seat.ts
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { labelSeat } from "../src/application/use-cases/label-seat";
import { runAppAction } from "../src/interface/run-app-action";

export default defineAction({
  description:
    "Write a name on one seat of one table — this is how a guest is seated. Seats are " +
    "numbered clockwise around the table's outline from 0, in the order get-event returns " +
    "them, so read the plan first and say which number you mean. An empty label clears the " +
    "seat. Reversible: undo-operation puts the previous name back.",
  schema: z.object({
    tableId: z.string().min(1).describe("Id of the table the seat belongs to"),
    seat: z.number().int().min(0).describe("Which seat, counting clockwise from 0"),
    label: z.string().max(32).describe("The name to write, or empty to clear it"),
    expectedVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Version the caller last saw; the call fails with CONFLICT if it changed"),
  }),
  mcpTool: true,
  audit: {
    target: (args) => ({ type: "seating_table", id: args.tableId, visibility: "org" }),
    summary: (args) => `Seated ${args.label} at seat ${args.seat + 1}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "label-seat", (actor, deps) => labelSeat(deps, actor, args)),
});
```

| Field | What it is for |
| --- | --- |
| `description` | **A prompt, not a comment.** It is what the model reads when choosing a tool. Say when to use the action, what state it is allowed from, and whether it is reversible. |
| `schema` | A Zod object. `.describe()` on every field, for the same reason. A validation failure is HTTP 400 with a message starting `Invalid action parameters`. |
| `http` | `{ method: "GET" }` marks a read: callable with query parameters, and **not** audited. Omit it for a mutation, which defaults to POST and is audited. |
| `readOnly` | `true` on queries. Tells the agent it is safe to call while thinking. |
| `mcpTool` | `true` on every semantic action; `false` on `view-screen` and `navigate`, which are UI affordances and mean nothing to an external MCP client. |
| `needsApproval` | `true` when the effect is irreversible and outside our database. The agent must obtain a human approval for that exact call. |
| `audit` | `target` gives the audit row its `target_type`, `target_id` and visibility; `summary` gives it one human-readable line. Required on every mutation. |
| `run` | One call to `runAppAction`. Nothing else. |

The **action name is the file name**: `actions/label-seat.ts` is `label-seat` as an agent
tool, at `POST /_agent-native/actions/label-seat`, as an MCP tool and as
`pnpm action label-seat`. There is no registry to keep in step and no second place to put an
implementation, which is exactly why the surfaces cannot diverge.

Two naming traps in the framework's discovery: files starting with `_`, and files named
`helpers`, `run`, `registry`, `_utils`, `db-connect` or `db-status`, are skipped;
subdirectories are not scanned. `actions/run.ts` is **not** an action — it is the CLI
dispatcher that `pnpm action` loads. Deleting it breaks `pnpm action` entirely.

## The runner

`src/interface/run-app-action.ts` is the only bridge between a framework action and a use case,
so the four things that must happen identically everywhere happen in one place:

```ts
export async function runAppAction<T>(
  ctx: ActionRunContext | undefined,
  actionName: string,
  fn: (actor: Actor, deps: Dependencies) => Promise<T>,
): Promise<T>
```

1. **Resolve the actor from the request context only.** `ctx.userEmail` and `ctx.orgId` come
   from the session; the role is read fresh from `org_members`. No argument, ever, contributes
   an identity. `resolveActor` throws `AUTHENTICATION` with no user, `AUTHORIZATION` with no
   active organization, and `AUTHORIZATION` when there is no membership row for the pair —
   which is what makes cross-organization access impossible rather than merely checked.
2. **Run the use case** with the composed `Dependencies` from
   `src/infrastructure/container.ts`.
3. **Write one structured log line**, success or failure: action, outcome, error code, caller,
   `orgId`, duration. Never an email, an argument or a result.
4. **Leave through `fail(...)`.** That is the framework's only channel for a message, an
   `errorCode` and an HTTP status. A bare `throw new Error()` becomes an opaque 500 with the
   message withheld — which is right for a bug and wrong for everything else.

An unexpected error — one that was not already an `AppError` and did not map to one — also gets
a server-side `unexpected-error` line carrying its stack, because that is the only record of
what actually broke. The caller sees `INTERNAL` and the constant string `"Unexpected error"`.

## The error model

`src/application/errors.ts` has one error type and eight codes. Every use case throws only
`AppError`; the domain throws `DomainError`, which `applyDomain` converts.

| Code | HTTP | When | Example message |
| --- | --- | --- | --- |
| `VALIDATION` | 400 | Bad argument, or a cross-record check that fails | `That person is not a member of this organization` |
| `AUTHENTICATION` | 401 | No session | `Sign in required` |
| `AUTHORIZATION` | 403 | No active organization, no membership, or no capability | `Role member may not events:archive` |
| `NOT_FOUND` | 404 | Missing, or in another organization | `Table not found` |
| `CONFLICT` | 409 | Somebody changed it first; the caller can re-read and retry | `Newer changes exist; undo refused` |
| `INVARIANT` | 422 | A domain rule refuses this transition, whatever the caller does | `Tables may not overlap` |
| `EXTERNAL` | 502 | A vendor call did not confirm | `<vendor> unavailable: … Retry will reconcile the pending request.` (no action raises this today) |
| `INTERNAL` | 500 | Unanticipated | `Unexpected error`, always exactly that |

`CONFLICT` versus `INVARIANT` is the distinction worth internalising: `CONFLICT` means "try
again after re-reading", `INVARIANT` means "this will never work from this state". The UI can
offer a refresh for one and not the other.

Messages are safe to show a user and an agent: no SQL, no stack, no internal identifier beyond
the resource id the caller already supplied. The browser maps `errorCode` to an
`errors.<CODE>` catalog key and falls back to the server's message
(`app/components/activity/action-ui.ts`).

## Concurrency and `expectedVersion`

Every mutable record carries an integer `version`. Every domain transition returns a new object
with `version + 1`. Every write is guarded on the version the caller read — inside the SQL, not
in application code:

```sql
UPDATE seating_tables SET grid_x = ?, grid_y = ?, …, version = ?, updated_at = ?
WHERE org_id = ? AND id = ? AND version = ?;   -- expectedVersion
```

A stale writer matches zero rows. Because the update and the operation insert are one atomic
batch guarded on the same predicate, a stale writer writes **nothing** — not even an audit row
for a change that did not happen. Zero rows affected becomes
`AppError("CONFLICT", "The record was changed by someone else")`.

That guard is always on. `expectedVersion` on an action is a *second*, earlier check for the
case where a human or an agent is acting on information they read a while ago:

```ts
if (input.expectedVersion !== undefined && input.expectedVersion !== table.version) {
  throw new AppError("CONFLICT", "The table was changed by someone else");
}
```

Pass it from the UI (the floor plan has the version it rendered) so the user gets a clean
"this changed, refresh" instead of an attempt that fails deeper down. Omitting it is safe; the
SQL guard still holds.

A version guard answers "has *this* record changed". Some invariants are about a record's
relationship to others — the floor plan's "two tables may not overlap" is the one here — and no
version can express them, because the two writers are touching different rows. Those become
constraints instead: `seating_cells` carries one row per cell a table covers, keyed
`(org_id, event_id, x, y)`, and every seating commit rewrites its table's cells in the same
atomic batch. The second writer violates the key, the batch is rolled back, and
`isCellCollision` in `src/infrastructure/d1/seating-tables-repository.ts` turns that into a
`CONFLICT`.

## Idempotency

Only the two creates take an `idempotencyKey`, and only because a create is the one command
where a retry after an unclear failure would otherwise produce a duplicate record. Every other
command is naturally idempotent-ish — writing the label a seat already has is an `INVARIANT`,
not a second write.

```ts
await callAction("create-seating-table", {
  eventId: "evt_gala",
  name: "Table 7",
  kind: "round",
  size: 3,
  idempotencyKey: "intake-form-7d3f",     // unique per organization and action
});
```

The key is stored in `idempotency_keys (org_id, action, key)` — a primary key, so the database
enforces uniqueness — together with the resource it created. A repeat returns the original
resource and the original `operationId`, and writes nothing.

Two callers can race past the lookup and both try to write. The primary key lets exactly one
land; the loser's whole atomic batch rolls back, it retries the lookup once, and answers with
the winner's resource. `isIdempotencyKeyViolation` in
`src/application/use-cases/command.ts` is how the loser recognises that case.

Pick keys that are stable for the thing being created — a form submission id, an inbound
message id — not a timestamp or a random value generated per attempt, which defeats the point.

## Queries versus commands

| | Query | Command |
| --- | --- | --- |
| `http` | `{ method: "GET" }` | omitted (POST) |
| `readOnly` | `true` | omitted |
| Audited | **No** | Yes, automatically |
| Operation row | No | Yes, with a classification and an inverse |
| Returns | The data | `{ resource, operationId }` |
| Client hook | `useActionQuery` | `useActionMutation` |

A GET action rejects POST with HTTP 405 `Method not allowed. Use GET.` Do not make a query
mutate anything: it will not be audited and there will be no way to undo it.

## The action catalogue

Queries — `http: { method: "GET" }`, `readOnly: true`:

| Action | Capability | What it returns |
| --- | --- | --- |
| `list-events` | `events:read` | Events, earliest first; archived only when asked |
| `get-event` | `events:read` + `seating:read` | One event and its whole floor plan: every active table, where it stands, and every seat label |
| `list-recent-activity` | `history:read` | Recent operations, each with `undoable` / `redoable` computed for the caller's current role |

Commands:

| Action | Capability | Classification | Inverse |
| --- | --- | --- | --- |
| `create-event` | `events:create` | `compensatable` | archive the new event |
| `archive-event` | `events:archive` | `reversible` | restore the event |
| `create-seating-table` | `seating:write` | `compensatable` | remove the new table |
| `move-seating-table` | `seating:write` | `reversible` | restore the recorded cell, if it is still free |
| `rotate-seating-table` | `seating:write` | `reversible` | turn it back, and return it to where it stood |
| `reshape-seating-table` | `seating:write` | `reversible` | restore the recorded form and seat list, labels included |
| `label-seat` | `seating:write` | `reversible` | restore the name that was there |
| `move-seat` | `seating:write` | `reversible` | restore the name each of the two seats had |
| `archive-seating-table` | `seating:write` | `reversible` | put the table back, if its space is still free |
| `undo-operation` | `history:undo` + the effect's own capability | `reversible` | re-apply, via `redo-operation` |
| `redo-operation` | `history:undo` + the original command's capability | `reversible` | the forward operation's inverse |

Framework and template actions kept: `view-screen` and `navigate` (both `mcpTool: false` — they
are UI affordances), plus the framework's audit readers `list-audit-events`, `get-audit-event`
and `export-audit-events`. The framework's generic database tools (`db-query`, `db-exec`,
`db-patch`, …) exist in the CLI but are off for the agent on every surface: `database: "off"`
in `server/plugins/agent-chat.ts`.

## Calling an action from each surface

```tsx
// UI — a query and a mutation. ctx.caller === "frontend".
const events = useActionQuery("list-events", {});
const move = useActionMutation("move-seating-table");
await move.mutateAsync({ tableId, gridX, gridY, expectedVersion: table.version });
```

```bash
# HTTP — ctx.caller === "http". A GET action takes query parameters.
curl -s -b cookies.txt \
  'http://127.0.0.1:8787/_agent-native/actions/get-event?eventId=evt_gala'

curl -s -b cookies.txt -X POST \
  -H 'content-type: application/json' \
  -d '{"tableId":"tbl_side","gridX":4,"gridY":4}' \
  http://127.0.0.1:8787/_agent-native/actions/move-seating-table
```

```bash
# CLI — ctx.caller === "cli". Identity from the two environment variables.
AGENT_USER_EMAIL=member1@example.invalid AGENT_ORG_ID=org_acme \
  pnpm action label-seat '{"tableId":"tbl_head","seat":0,"label":"Ada"}'

pnpm action --help                          # lists every action
pnpm action list-events --status nope       # an invalid value prints the full signature
```

Agent and MCP need no example: the model calls `label-seat` by name, and an MCP client sees
the same tool with the same schema. `POST /mcp` unauthenticated is 401 with a
`WWW-Authenticate` challenge.

Without an identity the CLI fails with `errorCode: "AUTHENTICATION"` and
`Action "list-events" failed: Sign in required` — which is the runner doing its job, not a
misconfiguration.
