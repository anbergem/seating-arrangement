# Decision records

Each record: context, decision, consequences. Referenced from tasks by id.

## D01 — Framework and version

Context: the starter must use Builder.io's Agent-Native framework; it is young and moves fast
(several nightlies per day).
Decision: depend on `@agent-native/core` **0.176.5** and `@agent-native/toolkit` **0.19.3**
with exact version pins (no `^`). Upgrades are explicit pull requests that run the full CI
pipeline plus the Worker smoke; never automerged.
Consequences: Renovate groups framework packages and never automerges them (D22). Every
framework fact in `02-framework-facts.md` is tied to this version and must be re-verified on
upgrade (task T22's playbook).

## D02 — Cloudflare Workers via the framework's single-file bundle

Context: the framework documents a Nitro `cloudflare_module` preset for Workers, but at
0.176.5 that output does not boot on workerd: it calls `setInterval` at module scope and then
`createRequire(undefined)`. The `cloudflare_pages` preset produces a single-file bundle
(`dist/_worker.js/index.js`) built by the framework's own esbuild pipeline that does boot as a
plain Worker with static assets and a D1 binding. Verified on 2026-09-05, also against nightly
0.177.0.
Decision: build with `NITRO_PRESET=cloudflare_pages`, deploy `dist/` as a **Worker** (not a
Pages project) through our own `wrangler.jsonc` with `main: "dist/_worker.js/index.js"` and
`assets.directory: "dist"`.
Consequences: we do not use the framework-generated `wrangler.json`. We own `wrangler.jsonc`
with `staging` and `production` environments.

## D03 — Post-build patch for two framework stub bugs

Context: the single-file bundle's Node built-in stubs make `fs.existsSync` and `os.homedir` safe
only for named imports; default-import access hits a throwing proxy. The agent-chat plugin
init and the MCP client config reader hit both, which disables agent chat, audit actions and
the MCP endpoint. Verified fix: rewriting the two proxy getters in the built bundle.
Decision: `scripts/patch-worker-bundle.mjs` applies exactly two replacements after every
build, asserts that each pattern matched exactly once, writes a marker, and exits non-zero
otherwise. The upstream bug is reported with a minimal repro (T02 includes the issue text).
Consequences: the build fails loudly when the framework changes the stub shape, which is the
intended signal to revisit the patch during an upgrade.

## D04 — Workers Paid plan

Context: the bundle is about 13 MB raw and 4.05 MB gzip; Workers Free allows 3 MB compressed,
Paid allows 10 MB.
Decision: the starter requires the Workers Paid plan (5 USD per month at time of writing). CI
enforces a compressed size ceiling of 8 MiB to keep margin.
Consequences: documented in README, bootstrap checklist and `docs/deployment.md`.

## D05 — Two database runtimes, one migration source

Context: the framework's Vite dev server runs on Node with a local SQLite file; Workers use D1
through the `DB` binding. Both are the SQLite dialect.
Decision: `pnpm dev` runs the framework dev server on `file:./data/app.db`. `pnpm dev:worker`
and all end-to-end tests run the built Worker under `wrangler dev` with local D1. App-owned
schema lives in `migrations/*.sql` and is applied by `wrangler d1 migrations apply` on D1 and
by `scripts/migrate-local.mjs` on the SQLite file. The same files, in the same order, in every
environment.
Consequences: no `drizzle-kit push` anywhere; no `drizzle-kit generate` as source of truth.

## D06 — Two schema owners

Context: the framework creates and migrates its own tables (auth, organizations, audit log,
settings, agent runs; about 50 tables) at runtime on first database touch. It documents that
app tables on D1 must be owned by Wrangler migrations.
Decision: framework-owned tables are left to the framework's runtime migration; app-owned
tables are Wrangler migrations. The D1 Time Travel bookmark taken before each production
deploy covers both. CI exercises the framework's bootstrap on every run by booting the Worker
against a fresh local D1.
Consequences: `AGENT_NATIVE_SKIP_ENSURE_TABLES` is never set. The two owners are documented in
`docs/database-and-migrations.md`.

## D07 — Raw parameterized SQL through the framework executor

Context: D1 has no interactive transactions; the framework executor exposes `atomicBatch` on
D1 and `transaction` elsewhere. Drizzle's batch API differs per driver.
Decision: repositories use `getDbExec()` with hand-written parameterized SQL (`?`
placeholders). Every statement carries an explicit `org_id = ?` predicate. Multi-statement
writes go through one `atomic` helper that uses `atomicBatch` when present and `transaction`
otherwise. Version checks are expressed inside the SQL so a stale write affects zero rows and
the whole batch is a no-op. The Drizzle schema in `server/db/schema.ts` exists only as the
typed mirror the framework and its doctor expect.
Consequences: a unit test asserts every SQL constant contains `org_id`. No ORM-level tenancy
magic.

## D08 — Actions are thin; use cases live in `src/application`

Context: the framework wants one file per action under `actions/`; the specification wants
domain, application, infrastructure and UI boundaries.
Decision: `actions/<name>.ts` files contain only the `defineAction` declaration (description,
schema, audit metadata) and delegate to a use case function through `runAppAction`. Domain
code in `src/domain` imports nothing from the framework, React, Cloudflare or Node.
Consequences: `scripts/check-boundaries.mjs` fails the build on forbidden imports.

## D09 — Authorization inside the use case, not the framework `authorize` hook

Context: the framework offers `authorize` on `defineAction` and per-app roles.
Decision: a single policy module `src/application/authorization.ts` maps the framework's
organization roles (owner, admin, member) to capabilities. Every use case calls
`requireCapability` after resolving the actor. The `authorize` hook is not used so that the
check is unit-testable with in-memory doubles and identical on every surface.
Consequences: denials surface as `AUTHORIZATION` errors with HTTP 403; the framework audit log
records them as `error` rows with our error code.

## D10 — Identity comes from the request context only

Context: the framework resolves `userEmail` and the active `orgId` from the session and passes
them to `run(args, ctx)`; it never trusts client-supplied organization ids.
Decision: actions never accept an `orgId` argument. The actor is resolved from `ctx.userEmail`
and `ctx.orgId`, and the role is read from `org_members` for that pair. A missing membership is
an authorization failure even if the session carries an `orgId`.
Consequences: cross-organization access is impossible by construction and is tested at unit,
HTTP and browser level.

## D11 — Production authentication policy

Context: intended production login is Google; the framework's password flow must not become an
open sign-up door; membership is invite-only.
Decision: production sets the Worker var `AUTH_REQUIRE_EMAIL_VERIFICATION=1` (the framework treats it as the declared policy) and configures no email
provider, which makes the framework refuse password sign-up; Google sign-in is configured with
`GOOGLE_SIGN_IN_CLIENT_ID` / `GOOGLE_SIGN_IN_CLIENT_SECRET`; `AUTO_CREATE_DEFAULT_ORG=0` in
every environment so a stray account gets no organization; the organization owner enables
"require Google sign-in" for the organization after bootstrap. Local, CI and staging QA use
deterministic email/password accounts with `AUTH_REQUIRE_EMAIL_VERIFICATION=0`.
Consequences: documented in `docs/authentication-and-authorization.md`; enforced by the
startup environment check (D16).

## D12 — Agent tool surface

Decision: `frameworkTools: { preset: "minimal", database: "off", audit: true }` on the agent
chat plugin. The agent gets our semantic actions plus the template's `view-screen` and
`navigate`. The template's database browser page and extensions pages are removed. MCP exposes
only the semantic actions (`mcpTool: true` on them, `false` on `view-screen` and `navigate`).
Consequences: the agent cannot read or write tables directly on any surface.

## D13 — App-owned semantic undo

Context: the framework's History Kit restores JSON snapshots; the specification requires
semantic undo with conflict detection and redo as re-application.
Decision: an `operations` table records each command with `version_before`,
`version_after`, a classification and the inverse command. `undo-operation` refuses unless the
resource is exactly at `version_after` of the operation being undone. `redo-operation`
re-runs the forward command with the same version rule. Both are ordinary audited actions.
Consequences: the framework audit log remains the trail; `operations` is the undo ledger; the
UI shows both.

## D14 — Idempotency only on creates

Decision: `create-customer` and `create-job` accept an optional `idempotencyKey`, unique per
organization and action. A repeated call returns the original resource. No other command has
idempotency keys.
Consequences: table `idempotency_keys`; documented in `docs/actions-and-use-cases.md`.

## D15 — LLM provider

Decision: the embedded agent uses Anthropic through a deployment-level `ANTHROPIC_API_KEY`
Worker secret owned by the customer. No Builder.io connection, no per-user keys by default.
Consequences: documented in bootstrap and runbook; the "Connect Builder.io" onboarding is off.

## D16 — Environment classes and startup validation

Decision: `APP_ENV` is one of `local`, `ci`, `staging`, `production`. A Nitro plugin validates
the environment at startup: production requires the production secret set and forbids
`AUTH_DISABLED`, `SEED_ENABLED`, `ACCESS_TOKENS`; local refuses a non-file `DATABASE_URL` and
refuses `APP_ENV=production`.
Consequences: accidental production configuration on a laptop fails fast with a clear message.

## D17 — Telemetry stance

Context: the framework only sends browser analytics when a public key is configured, and only
calls Builder.io APIs when a Builder key is configured.
Decision: neither is ever configured. A unit test rejects those variable names in committed
config; the Playwright suite asserts every browser request stays on the app origin.
Consequences: documented in `docs/observability.md`.

## D18 — Naming of the sample application

Decision: package name `agent-native-cloudflare-starter`; Worker name `example-jobs`
(`example-jobs-staging`, `example-jobs-production`); display name "Example Jobs"; sample
organization "Acme Services"; second organization "Other Company" for isolation tests.
Consequences: the bootstrap checklist's first step renames all of these.

## D19 — Internationalization

Context: the framework has a full i18n runtime but a closed locale list (11 locales, no
Norwegian). Upstream feature request BuilderIO/agent-native#3985 (2026-08-30) asks for
app-registered locales.
Decision: every UI string goes through the framework catalogs from day one. The template ships
`en-US` and `nb-NO` app catalogs; `nb-NO` is wired behind a `@ts-expect-error` that turns into
a compile error the moment the framework adds the code. A separate task prepares an upstream
change adding Norwegian Bokmål to the framework; the maintainer reviews and opens it.
Consequences: until upstream merges, Norwegian is not selectable at runtime; the customer app
may carry the same change as a temporary package patch, tracked in the upgrade playbook.

## D20 — Two instruction files for agents

Decision: root `AGENTS.md` targets coding agents; `agent/AGENTS.md` targets the embedded runtime
agent and is referenced by `instructions.runtime` in `agent-native.config.ts`.
Consequences: development guidance never enters the deployed system prompt.

## D21 — CI, promotion and approvals

Decision: one hermetic CI workflow on pull requests and pushes to `main`; a staging workflow on
pushes to `main` that builds once, uploads the Worker bundle as an artifact, migrates and
deploys staging, then runs the staging smoke; a production workflow triggered manually with the
staging run id, protected by the `production` GitHub environment with required reviewers, that
downloads that exact artifact, records a D1 Time Travel bookmark, migrates, deploys and runs the
read-only production smoke.
Consequences: production never rebuilds; the bundle deployed is byte-identical to the one that
passed staging.

## D22 — Dependency automation

Decision: Renovate, not Dependabot. Framework packages grouped, pinned, never automerged, with a
three-day minimum release age. pnpm's own 24-hour minimum release age policy stays on.
Consequences: the Renovate GitHub App must be installed by the repository owner (bootstrap).

## D23 — Backups

Decision: a scheduled workflow exports each production D1 database with `wrangler d1 export`,
compresses it, optionally encrypts it with `age`, and uploads it to an S3-compatible bucket when
configured, otherwise stores it as a workflow artifact with 30-day retention. Restore is always
into a new database, never in place.
Consequences: `docs/backups.md` and the runbook carry the tested restore procedure.

## D24 — Things deliberately not built

Decision: no event sourcing, no queues, no Durable Objects, no R2 usage (documented only), no
generic CRUD actions, no per-app RBAC overlay, no History Kit snapshots, no Cloudflare Access on
production. Cloudflare Access is an optional documented fence for staging only.

## D25 — Template distribution

Decision: GitHub "Use this template" is the primary path. After the first stable tag, register
the repository as an Agent-Native community template so `create --template
community:<owner>/<repo>#<tag>` also works. Porting between the template and apps uses
`git format-patch` / `git am --3way`, documented in `docs/template-workflow.md`.

## D26 — Integration-heavy applications keep the same boundary

Context: the first real application built from this template will implement most of its
functionality as an integration with an external system rather than with its own tables.
Decision: nothing above the port boundary changes. Use cases still resolve the actor, check a
capability, scope to the organization, validate, record an operation and are audited. What
changes is the adapter behind a port: vendor-owned aggregates are reached through ports
implemented by API adapters; our own aggregates, and any read model or cache synced from the
vendor, live in D1. Three rules follow and are demonstrated by `send-job-to-accounting`
(blueprint B22, task T27):
1. Undo applies only to data we own. A command with an external effect is classified
   `compensatable` (a documented compensating command exists) or `irreversible`, never
   `reversible`.
2. A local write and a vendor call are two steps, never one transaction. A durable pending request precedes the vendor call
   and carries an idempotency key derived from our resource id; the local "sent" state is a
   separate version-guarded commit. A retry reconciles the stored request even after local
   status changes (D27), asks the vendor with the same key, and records the answer.
3. Agents reach external writes only through our actions. Irreversible external effects set
   `needsApproval: true` so the agent must obtain a human approval for that exact call.
Consequences: `docs/integrations.md` becomes a first-class document; the sample app gains one
integration-backed command with a mock adapter; the customer app replaces the mock with a real
adapter and keeps everything else.

## D27 — Review corrections and evidence-led execution (2026-09-06)

The maintainer authorized the repository review corrections and continued implementation.
- Undo/redo requires both history permission and the capability for the actual business effect.
  Members may compensate their own customer creation; other customer history requires
  `customers:archive`. Job history may be reversed by coworkers with the matching job capability.
  Permission is evaluated against the caller's current role; activity flags use the same policy.
- The boundary checker uses `@babel/parser` **7.29.8**, already in the framework's dependency
  graph and now an explicit pinned dev dependency, to parse TS/TSX rather than line regexes.
- CI starts now with the current checks, repositories and Worker build. T12 adds runtime smoke;
  T16 adds the browser flow; T18 closes the full CI acceptance rather than introducing CI late.
- External writes persist an immutable pending request before contacting the vendor. Retries
  reconcile that request even if the job has since been archived; no queue or distributed
  transaction is introduced. See B22 and T27.
- Production promotion verifies the selected staging workflow, trusted branch, successful
  conclusion and artifact SHA, and checks out that SHA for migrations and configuration.
- Model calls remain optional on ordinary PRs. Release verification must include a real agent
  write/read/undo and approval scenario, or explicitly report that release evidence is pending.
- Framework compatibility patches remain bounded exceptions. Each upgrade verifies an actual
  Worker action flow, not only a patch match count. More runtime surgery requires reassessing
  the Node/libSQL fallback before adopting it as a new permanent template requirement.

## D28 — One-shot bootstrap script in Node (2026-09-08)

Context: the maintainer asked whether a cross-platform script could perform the whole
post-template setup, including placing secrets.
Decision: `scripts/bootstrap.mjs` (Node, not PowerShell) performs every automatable step from a
git-ignored input file: D1 creation in the EU jurisdiction, Wrangler config ids and URLs, the
first deployment when needed, Worker secrets per environment (generated signing secrets never
touch disk), GitHub environments with reviewers, GitHub secrets and variables, branch
protection, template flag. It prints a plan by default and requires `--yes` to create cloud
resources (spec section 43 forbids silent creation). Steps that cannot be automated stay manual
and are printed at the end: Workers Paid plan, the Cloudflare API token itself, the Google OAuth
client, the Renovate app, the first sign-in.
Consequences: `docs/bootstrap.md` documents the script first and the manual steps second; a
guard test drives the script against stub `wrangler`/`gh` executables so it is verified without
cloud access.
