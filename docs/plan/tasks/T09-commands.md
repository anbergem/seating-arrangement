# T09 — Command use cases and actions

Goal: the seven command use cases with audit metadata and idempotent creates.

Depends on: T08. Read: F5 (audit), F11; B8 (command rows), B9 (payload rule), B16; D13, D14.

## Steps

1. Use cases: `create-customer.ts`, `archive-customer.ts`, `create-job.ts`,
   `reschedule-job.ts`, `start-job.ts`, `complete-job.ts`, `archive-job.ts`, each following the
   B8 pattern: capability check, load, optional `expectedVersion` check, domain call, operation
   record with the inverse from the B8 table and `payload` (creates: the validated input without
   `idempotencyKey`; reschedule: `{ scheduledAt }`; others: `{}`), atomic persist, return
   `CommandResult`. `createJob` validates `assignedTo` membership with
   `deps.membership.isMember` → `AppError("VALIDATION", "Assignee is not a member of this organization")`.
   Idempotent creates per B8's last paragraph.
2. Actions for each with `mcpTool: true`, `audit.target` (`{ type: "customer"|"job", id, visibility: "org" }`
   — for creates the id comes from `result.resource.id`), `audit.summary` (`Created customer <name>`,
   `Archived customer <id>`, `Created job <title>`, `Rescheduled job <id> to <scheduledAt>`,
   `Started job <id>`, `Completed job <id>`, `Archived job <id>`), descriptions stating the
   allowed starting statuses and the reversibility class. Schemas: `create-customer`
   `{ name, email?, phone?, notes?, idempotencyKey? }`; `archive-customer` `{ customerId, expectedVersion? }`;
   `create-job` `{ customerId, title, description?, scheduledAt (datetime), assignedTo?, idempotencyKey? }`;
   `reschedule-job` `{ jobId, scheduledAt, expectedVersion? }`; the three transitions `{ jobId, expectedVersion? }`.
3. Tests `tests/unit/application/commands.test.ts`: for every command: success path (resource
   fields, version + 1, operation row with correct `versionBefore/After`, inverse, payload,
   `performedVia`), capability denial (`member` on `archive-customer` → AUTHORIZATION; `admin`
   and `owner` succeed), NOT_FOUND for ids from the other org, `expectedVersion` mismatch →
   CONFLICT, domain invariant → INVARIANT (e.g. complete an archived job), `create-job` with
   archived customer → NOT_FOUND, non-member assignee → VALIDATION, idempotent create returns
   the same resource id on the second call and creates no second operation.
4. Verify on the Node dev server with curl as a member: `create-customer`, `create-job`,
   `start-job`, `complete-job`; then `list-audit-events` shows four rows with
   `caller: "http"` and `status: "success"`, and `list-recent-activity` shows four operations.

## Deliverables

Seven use-case files, seven action files, `tests/unit/application/commands.test.ts`.

## Acceptance

```bash
pnpm check
```
plus the step 4 transcript.
