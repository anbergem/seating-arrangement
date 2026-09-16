# Adding a feature

One worked example, end to end, naming every file. The feature: **assign a job to a member**.

Jobs already have an `assignedTo` field, set when the job is created. There is no way to change
it afterwards, so `assign-job` is a real gap and a good size: a new transition on an existing
entity, a capability question, a membership check, an inverse, and one UI control.

The order below matters. Each step's tests should pass before you start the next one; a feature
built bottom-up is a feature you can debug.

## 0. Decide what the action is called

Kebab-case verb, and it must be something the business does. `assign-job`, not
`update-job-assignee`. The name is the file name, and the file name is what the agent sees as a
tool, what an MCP client sees, what the HTTP path is, and what the audit rows say. Getting it
right first saves renaming five things.

## 1. The domain rule

`src/domain/job.ts`:

```ts
export function assignJob(job: Job, assignedTo: string | null, now: string): Job {
  if (job.status === "completed" || job.status === "archived") {
    throw new DomainError("INVARIANT", `Cannot reassign a job that is ${job.status}`);
  }
  if (assignedTo !== null && assignedTo.trim() === "") {
    throw new DomainError("VALIDATION", "Assignee must be an email address or null");
  }
  if (assignedTo === job.assignedTo) {
    throw new DomainError("INVARIANT", "The job is already assigned to that person");
  }
  return { ...job, assignedTo, version: job.version + 1, updatedAt: now };
}
```

Three properties to keep: `now` is an argument, not `Date.now()`; the result is a new object
with `version + 1`; and it throws `DomainError`, never `AppError` — the domain does not know
what an HTTP status is.

Note what it does **not** do: it does not check that `assignedTo` is a member of the
organization. That needs the database, so it belongs in the use case. The domain answers "is
this a legal transition for this job", nothing more.

Export it from `src/domain/index.ts`, then write the test first:
`tests/unit/domain/job.test.ts` — allowed from `scheduled` and `in_progress`, `INVARIANT` from
`completed` and `archived`, `INVARIANT` for a no-op reassignment, `VALIDATION` for a blank
string, and `version` incremented exactly once.

```bash
pnpm test:unit
```

## 2. The capability

Reassigning work is an ordinary coordination task, so a member should be able to do it. Reuse
`jobs:transition`? No — it means "move the job through its lifecycle", and assignment is not
that. Add one, in `src/application/authorization.ts`:

```ts
export type Capability =
  | …
  | "jobs:assign";

const MEMBER_CAPABILITIES: readonly Capability[] = [
  …,
  "jobs:assign",
];
```

`ADMIN_CAPABILITIES` spreads the member list, so admin and owner inherit it. Update
`tests/unit/application/authorization.test.ts`: the role table is asserted there, so a new
capability that is not in the expectation fails the test — which is the point.

Rule of thumb: a new capability is right when a role should be able to do one of two related
things but not the other. If every role that can do X can also do Y, reuse X's capability.

## 3. The use case

`src/application/use-cases/assign-job.ts`:

```ts
export interface AssignJobInput {
  jobId: string;
  /** Email of the member to assign, or null to unassign. */
  assignedTo: string | null;
  expectedVersion?: number;
}

export async function assignJob(
  deps: Dependencies,
  actor: Actor,
  input: AssignJobInput,
): Promise<CommandResult<Job>> {
  requireCapability(actor, "jobs:assign");

  const job = await deps.jobs.getById(actor.orgId, input.jobId);
  if (!job) throw new AppError("NOT_FOUND", "Job not found");
  if (input.expectedVersion !== undefined && input.expectedVersion !== job.version) {
    throw new AppError("CONFLICT", "The job was changed by someone else");
  }
  if (
    input.assignedTo !== null &&
    !(await deps.membership.isMember(actor.orgId, input.assignedTo))
  ) {
    throw new AppError("VALIDATION", "That person is not a member of this organization");
  }

  const now = deps.clock.now();
  const next = applyDomain(() => assignJobDomain(job, input.assignedTo, now));
  const operation: Operation = {
    id: deps.ids.next(),
    orgId: actor.orgId,
    kind: "forward",
    action: "assign-job",
    resourceType: "job",
    resourceId: job.id,
    classification: "reversible",
    versionBefore: job.version,
    versionAfter: next.version,
    payload: { assignedTo: input.assignedTo },
    inverse: { type: "restore-job-assignee", previousAssignedTo: job.assignedTo },
    relatedOperationId: null,
    undoneByOperationId: null,
    performedBy: actor.userEmail,
    performedVia: actor.caller,
    performedAt: now,
  };
  await deps.jobs.commit({ job: next, expectedVersion: job.version, operation });
  return { resource: next, operationId: operation.id };
}
```

The shape is the same in every command, in this order, and the order is not arbitrary:

1. **Capability first.** Before any read. A denial must not depend on whether the record
   exists, or a 403/404 difference tells an outsider what exists.
2. **Load, scoped to `actor.orgId`.** Missing or foreign → `NOT_FOUND`.
3. **`expectedVersion`**, when the caller supplied one.
4. **Cross-record validation** that needs the database — here, membership.
5. **The domain transition**, wrapped in `applyDomain` so a `DomainError` becomes the matching
   `AppError`.
6. **The operation row**, including the inverse.
7. **One atomic commit**, guarded on the version you read.
8. **Return `{ resource, operationId }`.** The `operationId` is what the UI's Undo button and
   the agent's `undo-operation` call need.

Note step 4's `VALIDATION`, not `NOT_FOUND`. Whether an email is a member is not a record
lookup from the caller's point of view; it is a bad argument.

Test it in `tests/unit/application/commands.test.ts` against the in-memory doubles in
`tests/fixtures/in-memory.ts`: the happy path, a member of another organization rejected, a
non-member rejected, `NOT_FOUND` for a foreign job id, `CONFLICT` on a stale `expectedVersion`,
and the operation row's `inverse` recorded correctly.

## 4. The inverse

Step 3 recorded `{ type: "restore-job-assignee", previousAssignedTo }`, which does not exist
yet. Three files:

- `src/domain/operation.ts`: add the variant to the `InverseCommand` union, and
  `"assign-job": "reversible"` to `OPERATION_CLASSIFICATION`.
- `src/domain/job.ts`: `restoreJobAssignee(job, previousAssignedTo, now)` — like `assignJob`
  but without the "already assigned" and status rules, because an undo restores a recorded
  fact rather than making a new decision. Still `version + 1`.
- `src/application/use-cases/undo-operation.ts`: a case in the switch that applies the new
  inverse, and `src/application/history-policy.ts`: which capability reversing it requires
  (`jobs:assign`).

Then `src/application/use-cases/redo-operation.ts` needs to know how to replay the forward
command from the stored `payload` — here, `assignJob(resource, payload.assignedTo, now)`.

Test the round trip in `tests/unit/application/undo.test.ts`: assign, undo (the previous
assignee is back), redo (the new assignee is back), and undo refused with `CONFLICT` when
something else changed the job in between.

## 5. The database

`assignedTo` already exists as a column, so this feature needs no migration. If it did:

```bash
pnpm exec wrangler d1 migrations create <app>-local "job assignee history"
# writes migrations/0003_job_assignee_history.sql
```

Write the SQL, mirror the column in `server/db/schema.ts`, apply it locally with
`pnpm db:migrate` (Node file) and `pnpm db:migrate:worker` (local D1), and add a value for it
to `tests/fixtures/scenario.ts` if it is NOT NULL. Never edit a migration that has been
applied anywhere. `docs/database-and-migrations.md` has the rest.

What this feature does need is the repository write. `src/infrastructure/d1/sql.ts` already has
`UPDATE_JOB`, which sets `assigned_to` among the other columns, so nothing changes — but check.
If you add a statement, it must contain `org_id = ?`, or
`tests/unit/infrastructure/sql-scoping.test.ts` fails.

## 6. The action

`actions/assign-job.ts` — declaration only:

```ts
export default defineAction({
  description:
    "Assign a job to a member of the organization, or unassign it by passing null. " +
    "Allowed while the job is scheduled or in progress. Reversible with undo-operation, " +
    "which restores the previous assignee.",
  schema: z.object({
    jobId: z.string().min(1).describe("Id of the job to assign"),
    assignedTo: z
      .string()
      .email()
      .nullable()
      .describe("Email of the member to assign, or null to unassign"),
    expectedVersion: z.number().int().positive().optional(),
  }),
  mcpTool: true,
  audit: {
    target: (args) => ({ type: "job", id: args.jobId, visibility: "org" }),
    summary: (args) =>
      args.assignedTo === null
        ? `Unassigned job ${args.jobId}`
        : `Assigned job ${args.jobId} to ${args.assignedTo}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "assign-job", (actor, deps) => assignJob(deps, actor, args)),
});
```

The `description` is a prompt, not a comment: it is what the model reads when deciding whether
this is the tool it wants. Say when to use it, what it is allowed from, and whether it is
reversible. `.describe()` on each field does the same job for the arguments.

Run it before touching any UI:

```bash
AGENT_USER_EMAIL=member1@example.invalid AGENT_ORG_ID=org_acme \
  pnpm action assign-job '{"jobId":"job_scheduled","assignedTo":"member2@example.invalid"}'
```

That is the whole feature working, through the CLI surface, with no browser involved. If it
works here it works for the agent, for MCP and over HTTP, because they are the same code path.

## 7. The UI

`app/routes/jobs_.$id.tsx` — a select of members and a button:

```tsx
const assign = useActionMutation("assign-job");
// …
await assign.mutateAsync({ jobId, assignedTo, expectedVersion: job.version });
```

Then, on success, the same toast treatment every other mutation gets: `useOperationFeedback`
(`app/components/activity/use-operation-feedback.ts`) shows the message with an **Undo** button
wired to the returned `operationId`, and a **Redo** after an undo.

Rules the boundary checker and the guards enforce here:

- The route may import a **type** from `src/domain` and nothing else from `src`.
- No business rule in the component. Do not disable the control because the job is completed —
  or rather, do, for the user's sake, but understand that the server refusing is the actual
  constraint and that is what the test asserts.
- Every string through `useT()`, added to **both** `app/i18n/en-US.ts` and `app/i18n/nb-NO.ts`
  with the same keys and the same `{{placeholders}}`. `pnpm guard:i18n` fails on a missing key,
  a mismatched placeholder, or a single-brace `{name}` that the framework will never substitute.
- Every control gets an `aria-label` or a visible label, so a test can find it and a screen
  reader can announce it.

Hiding the control from a role it is not available to uses `useOrgRole()`, which the customers
page already does for the archive button. That is courtesy; the server check is the security.

## 8. Browser and agent coverage

`tests/e2e/jobs-lifecycle.spec.ts` (or a new spec): a member opens a job, assigns it to
somebody, and the change shows up on the detail page and in `/activity` with a working Undo.

`agent/AGENTS.md`: add the action to the command table with its reversibility. That file is the
deployed agent's system prompt — the model does not read this repository.

`evals/assign-job.eval.ts`, if assignment is something people will ask the agent to do:

```ts
export default defineEval({
  name: "assign the intended job to the intended member",
  input: { prompt: "Give the Monday callout to member2@example.invalid" },
  scorers: [usesTool("assign-job"), /* a custom scorer checking the arguments */],
  skipReason: process.env.RUN_MODEL_EVALS === "1" ? undefined : "model evals are opt-in",
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
src/domain/job.ts                              assignJob, restoreJobAssignee
src/domain/operation.ts                        InverseCommand variant, classification
src/domain/index.ts                            exports
src/application/authorization.ts               jobs:assign
src/application/history-policy.ts              which capability reverses it
src/application/use-cases/assign-job.ts        new
src/application/use-cases/undo-operation.ts    apply the new inverse
src/application/use-cases/redo-operation.ts    replay the forward command
actions/assign-job.ts                          new
app/routes/jobs_.$id.tsx                       the control
app/i18n/en-US.ts  app/i18n/nb-NO.ts           strings, both catalogs
agent/AGENTS.md                                the runtime agent's tool table
tests/unit/domain/job.test.ts                  transitions
tests/unit/application/authorization.test.ts   the role table
tests/unit/application/commands.test.ts        the use case
tests/unit/application/undo.test.ts            the round trip
tests/e2e/jobs-lifecycle.spec.ts               the browser flow
evals/assign-job.eval.ts                       optional
```

Nineteen files for one verb. That is the cost of the boundaries, and it is why
`ARCHITECTURE.md` argues for capabilities over CRUD rather than assuming it: a generic
`update-job` would be three files and would put the transition rules, the audit summary and the
inverse in the caller's hands.
