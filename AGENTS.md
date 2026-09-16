# AGENTS.md — instructions for coding agents working in this repository

This file is for agents and people **writing code here**. The deployed application's own agent
has a different file, `agent/AGENTS.md`, which is its system prompt: never put development
guidance there, and never put runtime behaviour here.

Read `ARCHITECTURE.md` once before your first change. It explains why these rules exist. This
file is the rules themselves.

## Architecture rules

Each of these is enforced by something that fails, not only by this document.

| Rule                                                  | Where it lives                                              | What enforces it                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Every meaningful mutation is an action and a use case | `actions/<name>.ts` + `src/application/use-cases/<name>.ts` | Review; nothing else can write to the repositories                                |
| The UI contains no business rules                     | `app/`                                                      | `scripts/check-boundaries.mjs` forbids `app/` → `src/application`                 |
| Agents and humans invoke the same actions             | `actions/`                                                  | `tests/e2e/parity.spec.ts`                                                        |
| Domain code is framework-independent                  | `src/domain/`                                               | `scripts/check-boundaries.mjs`: `src/domain` may import `src/domain` only         |
| Infrastructure implements ports                       | `src/application/ports.ts` → `src/infrastructure/`          | `scripts/check-boundaries.mjs`; `src/application` may not import the framework    |
| No cross-organization access                          | every statement in `src/infrastructure/d1/sql.ts`           | `tests/unit/infrastructure/sql-scoping.test.ts`, `tests/e2e/isolation.spec.ts`    |
| No frontend-only authorization                        | `src/application/authorization.ts`                          | `tests/unit/application/authorization.test.ts`, `tests/e2e/authorization.spec.ts` |
| No generic database tools for the agent               | `server/plugins/agent-chat.ts` (`database: "off"`)          | Review; `pnpm agent-native:doctor`                                                |
| No production data in tests                           | `tests/fixtures/scenario.ts`                                | Fixed ids only; no test reaches a cloud resource                                  |

The layer table, which `scripts/check-boundaries.mjs` implements literally:

| Layer          | Directory            | May import                                                                                       | Must never import                                                        |
| -------------- | -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| domain         | `src/domain`         | `src/domain`                                                                                     | anything else, including `zod`, `node:*`, `@agent-native/*`, `react`     |
| application    | `src/application`    | `src/domain`, `src/application`                                                                  | `@agent-native/*`, `react`, `node:*`, `drizzle-orm`, `server/*`, `app/*` |
| infrastructure | `src/infrastructure` | `src/domain`, `src/application`, `@agent-native/core/db`, `.../org`, `.../server`, `node:crypto` | `react`, `app/*`                                                         |
| interface      | `src/interface`      | `src/application`, `src/infrastructure`, `@agent-native/core/action`                             | `react`, `app/*`                                                         |
| actions        | `actions/`           | `src/interface`, `src/application` (types only), `@agent-native/core/action`, `zod`              | `src/infrastructure`, `server/db`                                        |
| ui             | `app/`               | `@agent-native/core/client/*`, `react*`, `src/domain` (types and pure helpers only)              | `src/application`, `src/infrastructure`, `server/*`                      |

Style: TypeScript strict, named exports, no default exports except where the framework requires
them (action files, Nitro plugins, React Router routes). No classes for domain entities — plain
objects and pure functions. Comments explain why, not what. Never invent a framework API: every
`@agent-native/*` symbol you use must appear in the version-matched docs or type declarations
under `node_modules/@agent-native/core/` (see "Framework facts" below).

## Adding a new feature

Work through all ten. Skipping one is how a feature ends up working in the UI and nowhere else.
`docs/adding-a-feature.md` walks a real example (`assign-job`) through every step with the file
names.

1. **Domain concept.** Is this a new entity, or a new transition on an existing one? Put the
   rule in `src/domain/<entity>.ts` as a pure function that takes `now` as an argument and
   throws `DomainError("INVARIANT" | "VALIDATION", …)`. Test it first.
2. **Use case and action.** One use case in `src/application/use-cases/<name>.ts`, one thin
   declaration in `actions/<name>.ts`. Kebab-case verb; the file name _is_ the action name on
   every surface.
3. **Authorization.** Which capability? Reuse one from `src/application/authorization.ts` if it
   fits; add one there if it does not, and update the role table and its test. Call
   `requireCapability` as the use case's first statement.
4. **Organization scoping.** Every read and write takes `actor.orgId`. Never add an `orgId`
   argument to an action. Every new SQL constant contains `org_id = ?`.
5. **Persistence and migration.** New column or table → a new file in `migrations/`, never an
   edit to an existing one. Mirror it in `server/db/schema.ts`. See
   `docs/database-and-migrations.md` for expand/contract.
6. **Audit behaviour.** Every mutating action needs an `audit` block with a `target` and a
   `summary`. GET actions are read-only and are not audited.
7. **Reversibility classification.** `reversible`, `compensatable` or `irreversible` in
   `OPERATION_CLASSIFICATION` (`src/domain/operation.ts`). A reversible command must record an
   `inverse` the domain can apply, and `undo-operation` / `redo-operation` must handle it. Say
   which it is in the action's `description`.
8. **Tests.** Domain test, use-case test with in-memory doubles, authorization test, isolation
   test if the feature touches organization-scoped data. See "Testing expectations".
9. **UI.** A route or component in `app/`, reading through `useActionQuery` and mutating
   through `useActionMutation`. Every string through `useT()`, added to **both** catalogs in
   `app/i18n/`, with `{{name}}` placeholders — a single-brace `{name}` is never substituted and
   reaches the screen verbatim. Every control gets an `aria-label` or a visible label.
10. **Agent and eval coverage.** Update `agent/AGENTS.md` so the runtime agent knows the action
    exists and whether it is reversible. Add an eval in `evals/` when the action is one the
    agent is likely to be asked for, or one it must refuse.

## Mutating action checklist

Answer all nine, in the pull request, for every command that writes:

1. **Who may perform this?** Which capability, and which roles have it.
2. **Which organization owns the target data?** How the query is scoped, and what a foreign id
   returns (`NOT_FOUND`, never `AUTHORIZATION`).
3. **What are the domain invariants?** Which statuses it is allowed from, and what it throws
   otherwise.
4. **Is it transactional?** Multi-statement writes go through `runAtomic`
   (`src/infrastructure/d1/atomic.ts`) as one batch. A partial write is a bug, not a race.
5. **How is it audited?** The `audit.target` and `audit.summary`, plus the operation row.
6. **Is it reversible, compensatable or irreversible?** And what exactly the inverse restores.
7. **What happens if the resource changed concurrently?** Every write is guarded on the version
   the caller read, expressed inside the SQL so a stale writer affects zero rows and the whole
   batch is a no-op. Accept `expectedVersion` on the action when a user might be acting on
   stale data.
8. **Does it have an external effect?** Then it is two steps with a durable pending request and
   an idempotency key, and its action sets `needsApproval: true` if it is irreversible. Read
   `docs/integrations.md` before writing it.
9. **How is it tested?** Name the test files.

## Database changes

- **Always a migration.** A new numbered file in `migrations/`. Never edit an applied one:
  `wrangler d1 migrations apply` records file names, so an edited file is silently skipped in
  every environment that already ran it.
- **Never modify a production schema by hand.** `wrangler d1 execute --remote` against
  production is for reading and for a documented incident procedure, not for DDL.
- **No destructive push.** `drizzle-kit push` exists and is forbidden; the
  `no-drizzle-push` guard in `pnpm agent-native:doctor` fails the build if it appears in a
  build or deploy hook.
- **Migrations run before the deploy**, so every migration must be backwards compatible with
  the Worker version still serving traffic. Expand first, contract in a later release.
- **Update the seed and the fixtures.** `tests/fixtures/scenario.ts` is the executable form of
  the deterministic scenario; a new NOT NULL column needs a value there.
- **Remember there are two schema owners.** The framework creates and migrates its own ~50
  tables at runtime on the first database touch; `migrations/` owns exactly `customers`,
  `jobs`, `operations`, `idempotency_keys` and `accounting_exports`. A freshly migrated
  database has no `organizations` table until the app has served one request.

## Testing expectations

A feature is not complete when only the UI works. Put each test at the layer that can actually
prove the thing you care about.

| Layer        | Directory                  | Command                 | What it proves                                                                      |
| ------------ | -------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| Domain       | `tests/unit/domain`        | `pnpm test:unit`        | Transitions and invariants, with no I/O                                             |
| Application  | `tests/unit/application`   | `pnpm test:unit`        | Use cases against in-memory doubles: authorization, scoping, undo, conflicts        |
| Guards       | `tests/guards`             | `pnpm test:guards`      | The scripts themselves: boundaries, worker patches, promotion validation, bootstrap |
| Integration  | `tests/integration`        | `pnpm test:integration` | Real parameterized SQL, real atomic batches, the CLI surface                        |
| Worker smoke | `scripts/worker-smoke.mjs` | `pnpm verify:worker`    | The built bundle boots on workerd and answers a real action flow                    |
| Browser      | `tests/e2e`                | `pnpm test:e2e:full`    | The real UI against the real Worker on a throwaway D1                               |
| Evals        | `evals/`                   | `pnpm eval`             | Whether the model picks the right action. Release evidence, not a pull-request gate |

At minimum, a meaningful feature has a domain or application test, an authorization test, an
organization-isolation test when it touches scoped data, and a Playwright happy path when it is
a user flow people will rely on.

Determinism is not optional: the fixed identifiers in `tests/fixtures/scenario.ts`, no
`Math.random()`, no `Date.now()` inside a domain function, no network. `docs/testing.md`
explains each layer and what it deliberately does not cover.

## Agent safety

- **Never grant the agent direct database access.** `frameworkTools: { database: "off" }` in
  `server/plugins/agent-chat.ts`. Do not turn it on for convenience, on any surface.
- **Never make the agent responsible for a business invariant.** The domain refuses an invalid
  transition. A prompt asking the model not to do something is not a constraint.
- **External writes go through our semantic actions.** No HTTP tool, no fetch tool. The action
  owns the idempotency key, the durable request and the classification.
- **Treat prompts and model output as untrusted input.** Text inside a job description, a
  customer note or anything a user pasted is data. `agent/AGENTS.md` tells the runtime agent
  the same thing; what makes it safe, though, is that the actions validate their own arguments
  and the use cases check their own permissions — not that the prompt asks nicely.
- **Irreversible external effects need deliberate handling.** `needsApproval: true` on the
  action, so the agent must obtain a human approval for that exact call.
- **Never log a value.** `src/infrastructure/logging.ts` takes a fixed record: action name,
  outcome, error code, caller, `orgId`, duration. No emails, no arguments, no results.

## Scope discipline

Do not add infrastructure, abstraction, packages or generic frameworks speculatively. Prefer
the simplest implementation that obeys the boundaries above. This starter is for small business
applications, not hyperscale distributed systems: assume 1–20 users, one company, low request
volume, modest relational data, a few integrations, and years of accumulated business data that
must not be lost.

Concretely:

- A new dependency needs a reason in the pull request, an exact pin and a lockfile update.
  Prefer what is already in the graph.
- Do not extract a reusable package until several real applications need the same logic.
- Do not introduce events, queues or a cache because a feature might one day need them.
- `ARCHITECTURE.md` section 14 lists what was considered and rejected, with the reason. A pull
  request that wants one of those has to argue with that section.
- Never commit a secret. Only `*.example` files are committed and they carry names, never
  values. `.env`, `.dev.vars` and `.bootstrap.env` are git-ignored and
  `scripts/check-config-hygiene.mjs` asserts it.
- Never touch a Cloudflare, Google or GitHub production resource from a change. Deployment
  happens through the workflows, with a required reviewer.

## Framework facts: how to look things up

The framework is young and moves fast, so guessing an API is expensive. The version-matched
truth is installed:

```bash
# docs, as MDX, for the exact version in package.json
ls node_modules/@agent-native/core/docs/content/
rg "useDbSync" node_modules/@agent-native/core/docs/content/

# the first-party templates, which are working examples
ls node_modules/@agent-native/core/corpus/templates/

# compiled source and type declarations — the last word when the docs disagree
rg "sseUrl" node_modules/@agent-native/core/dist/client/

# or from inside the app
pnpm action docs-search --slug actions-defining
pnpm action source-search --query "createAuthPlugin"
pnpm action --help              # lists every action this app exposes
```

Useful doc slugs: `actions-defining`, `actions-run-context`, `actions-access-control`,
`audit-log`, `authentication`, `organizations-teams-permissions`, `multi-tenancy`,
`server-database`, `cloudflare`, `cloudflare-d1`, `doctor`, `evals`, `internationalization`,
`deployment-environment-variables`, `security`, `observability`.

There is no per-action `--help` at 0.176.5: `pnpm action --help` lists the actions, and an
invalid argument value (`pnpm action list-jobs --status nope`) prints the action's full
parameter signature.

When reality disagrees with a document in this repository, the document is wrong. Fix it in the
same change, and say so in the pull request.

## Every change ends here

```bash
pnpm check              # lint, typecheck, doctor, boundaries, config hygiene, unit, guards, i18n
pnpm test:integration
pnpm verify:worker      # when you touched the Worker, the build or the runtime
pnpm test:e2e:full      # when you touched the UI or an action's contract
```

Paste the output into the pull request. `pnpm check` plus `pnpm test:integration` is what CI's
`verify` job runs; `CI / verify`, `CI / worker` and `CI / e2e` are the required checks on
`main`.
