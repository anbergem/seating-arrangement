# Final report — T26

Verification date: **2026-09-08**. Verified commit: **`760f349`** ("T25: Norwegian Bokmål
upstream change prepared for review (#18)"), which was `origin/main` at the time.

Every command below was run in a **fresh `gh repo clone`** of
`anbergem/agent-native-cloudflare-starter` in a throwaway directory, never in a working tree, so
nothing uncommitted could take part. Host: macOS 15 (Darwin 24.5.0), arm64, Node 26.6.0,
pnpm 11.23.0, Wrangler 4.129.0.

Two things in this report are **not** verified and are called out as such wherever they appear:
anything that needs a Cloudflare, Google or GitHub production resource, and anything that needs a
model provider credential. No task in this plan was allowed to touch those, and none did.

---

## 1. What was implemented

A GitHub template repository for small production business applications: one Agent-Native modular
monolith on Cloudflare Workers and D1, where the embedded agent and the human user do the same work
through the same actions. 310 tracked files, about 51 900 lines.

**Domain (`src/domain`, 5 files, 551 lines).** `Customer` and `Job` as plain objects with pure
transition functions that take `now` as an argument and throw `DomainError("INVARIANT" |
"VALIDATION", …)`. `Operation` carries the undo ledger's shape: `kind`, `versionBefore`,
`versionAfter`, an `OPERATION_CLASSIFICATION` of `reversible | compensatable | irreversible`, and a
typed `InverseCommand` union. No imports of anything — not `zod`, not `node:*`, not the framework.

**Application (`src/application`, 22 files, 2281 lines).** `errors.ts` (the `AppError` codes and
their HTTP mapping), `authorization.ts` (three framework roles → nine capabilities in one table),
`actor.ts` (`resolveActor`, which reads identity from the request context only), `ports.ts` (the
repository and adapter interfaces), `history-policy.ts` (who may reverse what), and 15 use cases.
Imports `src/domain` and itself, nothing else.

**Infrastructure (`src/infrastructure`, 18 files, 1801 lines).** D1 repositories over hand-written
parameterized SQL where every statement carries `org_id = ?`; `atomic.ts`, which runs a
multi-statement write as one `atomicBatch` (or `transaction` off D1) with the version guard
expressed inside the SQL so a stale writer affects zero rows and the whole batch becomes a no-op;
in-memory doubles for tests; a mock accounting adapter; `env-check.ts`; `logging.ts`, which takes a
fixed record and can never log a value; and the dependency container.

**Interface (`src/interface`, 1 file, 85 lines).** `runAppAction` — the single bridge. It resolves
the actor, runs the use case, writes one structured log line either way, and converts every error
into the framework's `fail(...)` so a message, an `errorCode` and an HTTP status survive to the
caller.

**Actions (`actions/`, 18 files, 602 lines).** 15 application actions — 5 queries (`list-jobs`,
`get-job`, `list-customers`, `get-customer`, `list-recent-activity`), 8 commands (`create-customer`,
`create-job`, `reschedule-job`, `start-job`, `complete-job`, `archive-job`, `archive-customer`,
`send-job-to-accounting`) and 2 history actions (`undo-operation`, `redo-operation`) — each a
`defineAction` declaration plus one `runAppAction` call. Plus the framework template's two UI-state
actions (`view-screen`, `navigate`, both `http: false`, `mcpTool: false`, neither touching
application data) and `actions/run.ts`, which is the framework's CLI dispatcher and not an action at
all.

**UI (`app/`, 45 files, 2805 lines).** React 19 + React Router 8. Routes for the jobs list, a job
detail page, customers, a customer detail page, activity with Undo and Redo, the agent chat page,
team, settings and observability. Every read through `useActionQuery`, every write through
`useActionMutation`, every string through `useT()` against two catalogs (129 keys), every control
with an accessible name. No business rule anywhere; `scripts/check-boundaries.mjs` forbids
`app/` → `src/application`.

**Server (`server/`, 11 files, 319 lines).** The environment-check plugin, the agent-chat plugin
(`frameworkTools: { preset: "minimal", database: "off", audit: true }`), the readiness route, and
`db/schema.ts` as the typed Drizzle mirror the framework's doctor expects.

**Schema (`migrations/`, 2 files).** `customers`, `jobs`, `operations`, `idempotency_keys`,
`accounting_exports`. Applied by `wrangler d1 migrations apply` on D1 and by
`scripts/migrate-local.mjs` on the Node SQLite file — the same files, in the same order, in every
environment.

**Tests (`tests/`, 45 files, 8238 lines; 36 test files).** 312 unit and application tests, 19
integration tests against real SQL and the real CLI, 39 guard tests (38 passing, 1 skipped for lack
of sandbox process-group signals), a 12-check Worker smoke against the built bundle on workerd, and
14 Playwright tests driving the real Worker on a throwaway local D1.

**Evals (`evals/`, 7 files).** 5 model-backed scenarios: correct target, tool result, persisted
state, approval gating and member denial. They skip without a provider credential — see §5 and §8.

**Delivery (`.github/workflows/`, `scripts/`, 29 script files, 5535 lines).** One hermetic CI
workflow (`verify`, `worker`, `e2e`); a staging workflow that builds once and uploads the bundle;
a production workflow that downloads *that* artifact, verifies its provenance, records a D1 Time
Travel bookmark, migrates and deploys behind a required reviewer; a nightly D1 export with a
tested-by-guard restore check; Renovate with framework packages grouped, pinned and never
automerged; `scripts/bootstrap.mjs`, which performs every automatable setup step from one
git-ignored input file and prints a plan unless given `--yes`; and `scripts/rename-app.mjs`.

**Documents.** `README.md`, `ARCHITECTURE.md` (14 sections with diagrams), root `AGENTS.md` for
coding agents, `agent/AGENTS.md` as the deployed runtime prompt, and 16 documents under `docs/`
(plus the plan itself under `docs/plan/`).

---

## 2. Important architectural decisions

The full records with their reasoning are in `docs/plan/01-decisions.md` (D01–D28). The ones that
shaped the most code:

- **The `cloudflare_pages` preset, deployed as a Worker (D02).** At 0.176.5 the documented
  `cloudflare_module` preset does not boot on workerd — it calls `setInterval` at module scope and
  then `createRequire(undefined)`. The `cloudflare_pages` preset produces a single-file bundle that
  does boot. We deploy `dist/` as a Worker with static assets through our own `wrangler.jsonc`; the
  framework-generated `wrangler.json` is unused.
- **A two-replacement post-build patch that fails loudly (D03).** The bundle's Node built-in stubs
  make `fs.existsSync` and `os.homedir` safe only for named imports; default-import access hits a
  throwing proxy, which disables agent chat, the audit actions and the MCP endpoint.
  `scripts/patch-worker-bundle.mjs` rewrites exactly two proxy getters, asserts each pattern matched
  exactly once, and writes `dist/_worker.js/PATCHED.json`. Zero or two matches fails the build,
  which is the intended signal on an upgrade.
- **Raw parameterized SQL, not an ORM's tenancy layer (D07).** Repositories use `getDbExec()` with
  `?` placeholders and an explicit `org_id = ?` on every statement, and
  `tests/unit/infrastructure/sql-scoping.test.ts` asserts that property over the module's exports
  rather than over a list, so a statement added later is covered the moment it is exported.
- **Authorization in the use case, not the framework's `authorize` hook (D09).** One policy module
  maps roles to capabilities; `requireCapability` is the first statement of every use case. That
  makes the check unit-testable with in-memory doubles and identical on every surface.
- **Identity from the request context only (D10).** No action accepts an `orgId`. The actor comes
  from `ctx.userEmail` + `ctx.orgId`, and the role is read fresh from membership. A session carrying
  an `orgId` the caller is not a member of is an authorization failure. Cross-organization access is
  impossible by construction, and a foreign id returns `NOT_FOUND`, never `AUTHORIZATION`.
- **App-owned semantic undo, not the framework's snapshot History Kit (D13).** An `operations` row
  per command records `version_before`, `version_after`, the classification and the inverse. Undo
  refuses unless the resource is exactly at `version_after`; redo re-runs the forward command under
  the same rule. Undo and redo are ordinary audited actions, and the history policy
  (`src/application/history-policy.ts`) requires both `history:undo` *and* the capability for the
  business effect being reversed.
- **Two schema owners, acknowledged rather than fought (D06).** The framework creates and migrates
  its own ~50 tables at runtime on the first database touch; `migrations/` owns exactly five tables.
  A freshly migrated database has no `organizations` table until the app has served one request —
  which is why `pnpm db:seed` needs a running server.
- **Build once, promote the artifact (D21).** Production never rebuilds. The promotion verifies the
  staging run's branch, conclusion and artifact SHA and checks out that SHA for migrations and
  configuration.
- **Integration-heavy apps keep the same boundary (D26).** `send-job-to-accounting` demonstrates it:
  a durable pending request with an idempotency key derived from our resource id precedes the vendor
  call, the local "sent" state is a separate version-guarded commit, a retry reconciles the stored
  request even after the job was archived, and the action sets `needsApproval: true` so an agent
  must obtain human approval for that exact call.
- **Workers Paid plan accepted (D04).** The bundle is 12.8 MB raw and 3.87 MiB gzip; Free allows
  3 MB compressed, Paid allows 10 MB. CI fails above 8 MiB to keep margin.

---

## 3. Commands for local development

```bash
pnpm install                     # 1028 packages, exact framework pins
cp .env.example .env             # then: openssl rand -hex 32 into BETTER_AUTH_SECRET
pnpm db:reset                    # rebuild both local databases from migrations/ alone
pnpm dev                         # http://localhost:8080 — leave running
pnpm db:seed                     # in a second terminal: the scenario plus five users
```

Sign in as `owner@example.invalid` with the `SEED_PASSWORD` from `.env`
(`Example-Seed-Password-2026` by default). Other seeded identities:
`admin@example.invalid`, `member1@example.invalid`, `member2@example.invalid` (all in
`Acme Services`) and `outsider@example.invalid` (owner of `Other Company`, for isolation tests).

The real Worker instead of the Node dev server:

```bash
pnpm dev:worker                  # builds dist/ and serves it on http://127.0.0.1:8787
pnpm db:seed:worker
```

Every change ends here:

```bash
pnpm check                       # lint, typecheck, doctor, boundaries, config hygiene, unit, guards, i18n
pnpm test:integration
pnpm verify:worker               # when the Worker, the build or the runtime changed
pnpm test:e2e:full               # when the UI or an action's contract changed
```

Other useful entry points: `pnpm action --help` (lists every action this app exposes),
`pnpm action <name> --arg value` (run one from the CLI), `pnpm eval` (model-backed evals; skips
without a credential), `pnpm lint:workflows`, `node scripts/bootstrap.mjs --plan`,
`node scripts/rename-app.mjs`.

---

## 4. Commands and tests that were run, with their output

### 4.1 `pnpm install --frozen-lockfile`

```
✓ Lockfile passes supply-chain policies (verified 13h ago)
Lockfile is up to date, resolution step is skipped
Packages: +1028
…
Done in 11.2s using pnpm v11.23.0
EXIT=0
```

Honest note: `reused 1028, downloaded 0` — the pnpm content-addressable store on this machine was
already warm, so no package was fetched over the network. A genuinely cold install would download.
The lockfile itself was accepted unmodified, which is what `--frozen-lockfile` proves.

### 4.2 `pnpm check`

Runs `lint` → `typecheck` → `agent-native:doctor` → `check:boundaries` → `check:config` →
`test:unit` → `test:guards` → `guard:i18n`.

```
All matched files use the correct format.
Finished in 226ms on 225 files using 8 threads.
…
agent-native doctor: <fresh clone>
Guards run: no-drizzle-push, no-empty-migrations, no-unscoped-credentials, no-unscoped-queries,
  no-env-credentials, db-tool-scoping, no-env-mutation, no-localhost-fallback,
  explicit-collab-access, migration-manifest
Clean — no findings.
boundaries ok
config hygiene ok
 Test Files  14 passed (14)
      Tests  312 passed (312)
ℹ tests 39
ℹ pass 38
ℹ fail 0
ℹ skipped 1
i18n: 129 keys; usage, parity and placeholders verified
EXIT=0
```

Two things in that output deserve naming rather than hiding:

- The one skipped guard test is `process-group teardown waits for the detached launcher`, skipped
  with `# sandbox does not permit process-group signals`. It is an environmental skip, by design:
  the fixture exists precisely so a sandbox that cannot signal a process group says so instead of
  failing. Its sibling (`kills a child after its launcher exits`) ran and passed. Re-running
  `pnpm check` in an ordinary working tree on the same machine gives `ℹ pass 39 / ℹ fail 0 /
  ℹ skipped 0` — that test does run and pass where process-group signals are permitted, which is
  the case in CI.
- `agent-native typecheck` prints `[agent-native] production configuration errors: BETTER_AUTH_SECRET
  is not set for production` twice and then exits 0. That is the framework evaluating a *production*
  configuration during a local typecheck; the secret is a deployment secret and is correctly absent
  from a clone. Recorded in `DISCREPANCIES.md` (2026-09-08 T23).

### 4.3 `pnpm test:integration`

```
applied 0001_init.sql
applied 0002_job_accounting.sql
 Test Files  2 passed (2)
      Tests  19 passed (19)
integration and CLI parity checks passed
EXIT=0
```

### 4.4 `pnpm build:worker`

```
[deploy] 1 API routes, 15 actions, 5 plugins (0 skipped as Node-only), 9 auto-mounted defaults
  dist/_worker.js/index.js  12.8mb
Build complete.
patch fs-default-proxy: ok
patch os-default-proxy: ok
worker bundle gzip total: 3.87 MiB
wrote dist/BUILD_INFO.json (sha 760f34990e62a4ae25db9cbf12e7e08c590cda8e)
EXIT=0
```

`dist/_worker.js/PATCHED.json` records both patch names, `coreVersion 0.176.5` and the bundle
sha256; `dist/BUILD_INFO.json` records the commit sha, build time and core version. 3.87 MiB is
inside the 8 MiB CI ceiling and inside the Paid plan's 10 MB, and above the Free plan's 3 MB.

### 4.5 `pnpm verify:worker`

Boots the built bundle under `wrangler dev` on a temporary local D1 it owns and tears down.

```
[ok] ping
[ok] health uses D1
[ok] migrations ready
[ok] sign-in HTML
[ok] root static shell
[ok] unauthenticated list-jobs is 401
[ok] QA login and organization
[ok] authenticated list-jobs
[ok] reversible write, conflict, undo and isolation
[ok] accounting export authorization, replay and cleanup
[ok] agent chat SSE
[ok] unauthenticated MCP challenge
EXIT=0
```

### 4.6 `pnpm test:e2e`

`.dev.vars` was created from `.dev.vars.example` with `BETTER_AUTH_SECRET=$(openssl rand -hex 32)`.
Chromium was already installed. The suite ran against the `dist/` built in §4.4.

```
Running 14 tests using 1 worker
  ✓ accounting.spec.ts — an admin exports a completed job after confirming, a member is not offered it
  ✓ auth.spec.ts — the owner's stored session lands on the jobs list with organization chrome
  ✓ authorization.spec.ts — archiving a customer is refused for a member and allowed for an admin
  ✓ authorization.spec.ts — the archive button is hidden from a member and shown to an admin
  ✓ complete-job.spec.ts — a member completes a job in the UI and the change is audited as a frontend call
  ✓ customers.spec.ts — a member creates a customer from the dialog and opens its detail page
  ✓ isolation.spec.ts — an outsider gets not-found for another organization's job, in the UI and over HTTP
  ✓ jobs-lifecycle.spec.ts — a member undoes and redoes a completion from the activity page, then archives the job
  ✓ jobs-lifecycle.spec.ts — a member creates a job for a customer, starts it and reschedules it
  ✓ jobs-list.spec.ts — a member sees the organization's three unarchived jobs
  ✓ jobs-list.spec.ts — the status filter narrows the list to scheduled jobs
  ✓ parity.spec.ts — the UI and a direct HTTP call run the same action and differ only in caller
  ✓ undo-conflict.spec.ts — undo refuses to overwrite a newer change made by another user
  ✓ undo.spec.ts — undo from the toast restores the status and is recorded as its own operation
  14 passed (34.0s)
EXIT=0
```

Ports 8787 and 8080 were empty before the run and empty after it.

### 4.7 `pnpm eval` — **release evidence produced 2026-09-08: 5/5**

Produced by the maintainer with a funded `ANTHROPIC_API_KEY` on `claude-sonnet-5`, the framework's
default Anthropic model, via `RUN_MODEL_EVALS=1 pnpm eval -- --out eval-evidence.json`:

```
ok: true — 5 total, 5 passed, 0 failed, 0 skipped
```

Every scorer scored 1. The five behaviours the upgrade playbook asks to be recorded, with what the
run actually showed:

| Behaviour | Evidence from the run |
| --- | --- |
| Correct target | `complete-job` after `list-customers` + `list-jobs`, aimed at `job_in_progress` |
| Successful tool result | the action returned the job with `status: "completed"`, and the agent reported it |
| Persisted state | re-read through the repository after the run, not from the agent's reply |
| Human approval | `send-job-to-accounting` **called**, side effect withheld, "Awaiting human approval … did NOT execute"; no export request left behind |
| Member denial | `archive-customer` attempted and refused: `Role member may not customers:archive (errorCode: AUTHORIZATION)`, and the agent explained the role requirement rather than retrying |

`undo-operation` returned `job_in_progress` to `in_progress`, and `list-jobs` answered "no jobs are
scheduled for today, September 6, 2026" with an empty array and no mutating call.

Getting here took three defects, all recorded in `DISCREPANCIES.md` (2026-09-08) and fixed: the
`--json` artifact was unparseable through a shell redirection (three separate writers on stdout);
`agent-native eval` supplied no system prompt, so every request was refused for caching an empty
system block; and rule 4 of `agent/AGENTS.md` told the agent to obtain the accounting approval in
conversation, which made the framework's `needsApproval` gate unreachable — a production-behaviour
defect that only a model-backed run could have found. That last one is the answer to "what do the
evals buy that the other 380 tests do not".

One wrinkle to know about: the evals pin the agent's `<runtime-context>` date to `FIXTURE_CLOCK`
(2026-09-06) for reproducibility, while the application's own timestamps come from the real clock,
so a transcript can show a `completedAt` that disagrees with the agent's notion of "today". It has
no bearing on the assertions; a future change could inject the clock through the container if
determinism there ever matters.

### 4.8 `node scripts/bootstrap.mjs --plan --env-file .bootstrap.env.example`

```
bootstrap: PLAN (read-only) from .bootstrap.env.example

Fill in these keys before this script can do anything:
  APP_NAME, GITHUB_REPO, STAGING_URL, PRODUCTION_URL, CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN, GOOGLE_SIGN_IN_CLIENT_ID, GOOGLE_SIGN_IN_CLIENT_SECRET,
  ANTHROPIC_API_KEY, SEED_PASSWORD

Every key is documented in .bootstrap.env.example and docs/bootstrap.md.
EXIT=0
```

`--plan --only github-secrets` behaves the same way on the empty example file, also exit 0. The
script correctly refuses to do anything without values and makes no cloud call in plan mode. Its
behaviour *with* values is covered by `tests/guards/bootstrap.test.mjs`, which drives it against
stub `wrangler` and `gh` executables — it has never been run against a real Cloudflare or GitHub
account, and that is unverified here by design.

### 4.9 `pnpm lint:workflows`

```
$ github-actionlint .github/workflows/*.yml
LINT_WORKFLOWS_EXIT=0
```

### 4.10 Manual sign-in check

`pnpm db:reset`, then `pnpm dev` with a local `.env` (from `.env.example` plus a fresh
`openssl rand -hex 32`), then `pnpm db:seed`:

```
seed: target node, 28 scenario statements, 5 users
seed: applied the scenario to data/app.db
seed: registered owner@example.invalid (owner of org_acme)
seed: registered admin@example.invalid (admin of org_acme)
seed: registered member1@example.invalid (member of org_acme)
seed: registered member2@example.invalid (member of org_acme)
seed: registered outsider@example.invalid (owner of org_other)
seed: done
```

Sign-in and two authenticated fetches over HTTP with the resulting session cookie:

```
POST /_agent-native/auth/login   {"ok":true}                                        HTTP 200
GET  /_agent-native/org/me       {"email":"owner@example.invalid","orgId":"org_acme",
                                  "orgName":"Acme Services","role":"owner", …}      HTTP 200
GET  /jobs                       21991 bytes of HTML                                HTTP 200
GET  /_agent-native/actions/list-jobs
                                 3 jobs: job_completed (completed, v2),
                                 job_in_progress (in_progress, v2),
                                 job_scheduled (scheduled, v1) — all orgId org_acme  HTTP 200
```

Two negative checks in the same session, because they are the actual guarantees:

```
GET /_agent-native/actions/list-jobs               (no cookie)   {"error":"Unauthorized"}   HTTP 401
GET /_agent-native/actions/get-job?jobId=job_scheduled
    as outsider@example.invalid (org_other)  {"error":"Job not found","errorCode":"NOT_FOUND"} HTTP 404
```

The server was then stopped, `data/` deleted, and both ports confirmed free. `git status
--porcelain` in the clone was empty afterwards: `.env`, `.dev.vars`, `data/`, `dist/` and
`.wrangler/` are all git-ignored, and nothing else had changed.

### 4.11 Security review

| Check | Result | Evidence |
| --- | --- | --- |
| Every SQL constant is organization-scoped | **pass** | `tests/unit/infrastructure/sql-scoping.test.ts` exists and passes inside `pnpm test:unit`. It asserts a property of the module's exports — every exported string contains `org_id = ?`, at least 18 of them, none contains `${`, and the only quoted literals allowed are the four fixed enum values — and separately that the 8+ optional `WHERE`/`ORDER BY` fragments are fixed clauses with at most one placeholder. |
| Every action goes through `runAppAction` | **pass, with three named exceptions** | 15 of 18 files in `actions/` call `runAppAction`. The three that do not are `actions/run.ts` (the framework's CLI dispatcher — two lines, `runScript()`, not an action) and `actions/navigate.ts` / `actions/view-screen.ts`, the framework template's per-tab UI-state actions: both are `http: false` and `mcpTool: false` and touch only framework application state, never a repository. |
| No path reaches a use case without `resolveActor` and a capability check | **pass** | `resolveActor` is called in exactly one place, `src/interface/run-app-action.ts:40`, from the request context only; no use case calls it, and no use case can be reached except through it. All 15 use cases call `requireCapability` (`command.ts` is a shared helper, not a use case). Undo and redo additionally call `requireHistoryPermission(mayUndo/mayRedo(actor, op))`, so history never grants a capability the underlying business action denies. `list-recent-activity` uses the same two predicates to decide whether to offer Undo/Redo, so the UI cannot show an action the server would refuse. |
| The environment check covers production | **pass** | `src/infrastructure/env-check.ts` is pure (takes the environment, returns findings, never reads `process.env`, never throws or logs, no framework or Node imports). `tests/unit/infrastructure/env-check.test.ts` has 18 tests, including a correct production environment, production with each required variable missing one at a time, production dangerous flags, production forbidding `DATABASE_URL` at all, and an assertion that no message contains a value. |
| `pnpm check:config` | **pass** | `config hygiene ok`. It asserts `.env`, `.dev.vars` and `.bootstrap.env` are git-ignored and that only `*.example` files are committed. |
| No committed secrets, whole history | **pass — test-only literals only** | `git log -p --all \| grep -iE "(secret\|token\|api[_-]?key)\s*[=:]\s*['\"]?[A-Za-z0-9_\-]{20,}"` returns exactly seven distinct lines, all of them obvious fixtures: `BETTER_AUTH_SECRET: "e2e-only-secret-32-characters-long"` (`scripts/e2e-server.mjs:162`), `BETTER_AUTH_SECRET: "worker-smoke-only-secret-32-characters-long"` (`scripts/verify-worker.mjs:176`), `GOOGLE_SIGN_IN_CLIENT_SECRET: "google-client-secret"` and `const secretAccessToken = "super-secret-token-abc"` (`tests/unit/infrastructure/env-check.test.ts:19,185`), and three zero-padded stubs in `tests/guards/bootstrap.test.mjs:49,51,52` (`cf-token-000…`, `GOCSPX-secret-value-000…`, `sk-ant-api03-000…`). No real credential, in any commit, on any branch. |
| Framework database tools unreachable | **pass** | `server/plugins/agent-chat.ts` sets `frameworkTools: { preset: "minimal", database: "off", audit: true }`, so no agent surface gets `db-query`/`db-exec`/`db-patch`. Verified empirically as well: signed in as `member1@example.invalid`, `GET /_agent-native/actions/{db-query,db-exec,db-schema,db-patch,resource-read}` all returned **404**, and a `POST` fell through to the router with no matching route. The framework's `db-*` core actions live only in the CLI runner (`node_modules/@agent-native/core/dist/scripts/runner.js`), i.e. they require the repository and the database file, not a session. |
| `pnpm audit --prod` | **7 advisories, all transitive through the framework; exit 1** | See below. |

`pnpm audit --prod` reports 3 moderate and 4 high, and **exits 1**. Every one arrives through
`@agent-native/core` or `@agent-native/toolkit`; none is a direct dependency we chose except
`react-router`, which the framework pins to the same version we do.

| Severity | Package | Vulnerable | Patched | Advisory | Path |
| --- | --- | --- | --- | --- | --- |
| high | `xlsx` | `<0.19.3` | none published | Prototype pollution | `@agent-native/core > xlsx` |
| high | `xlsx` | `<0.20.2` | none published | ReDoS | `@agent-native/core > xlsx` |
| high | `pdfjs-dist` | `>=5.6.83 <6.2.108` | `>=6.2.108` | Arbitrary JS on opening a malicious PDF | `@agent-native/core > officeparser` |
| high | `react-router` | `>=8.0.0 <8.3.0` | `>=8.3.0` | RSC-mode CSRF bypass | `@agent-native/core > @react-router/dev` |
| moderate | `@anthropic-ai/sdk` | `>=0.79.0 <0.91.1` | `>=0.91.1` | Insecure default file permissions | `@agent-native/core > @anthropic-ai/sdk` |
| moderate | `uuid` | `<11.1.1` | `>=11.1.1` | Missing buffer bounds check in v3/v5/v6 | `@agent-native/core > botframework-connector` |
| moderate | `@tiptap/core` | `>=2.0.0-alpha.0 <3.30.4` | `>=3.30.4` | `mergeAttributes()` `__proto__` handling | `@agent-native/core > @agent-native/toolkit` |

Reachability, stated as assessment rather than fact: `xlsx`, `pdfjs-dist`/`officeparser` and
`@tiptap/core` are document-handling and rich-text paths this application never calls, and none is
reachable from any action or route in `app/`. The `react-router` advisory is specific to RSC mode,
which this app does not enable (no RSC flags in `vite.config.*` or `react-router.config.*`). None of
this is a substitute for the upgrade: the fix for all seven is a framework version that moves them,
and `docs/upgrade-playbook.md` is the process. **`pnpm audit` is not currently a CI step** — see
§6.4.

### 4.12 Organization scoping review

Every repository call in `src/application/use-cases/*.ts` passes the organization. `resolveActor` is
the only source of `actor.orgId`, and no action accepts an `orgId` argument.

- Read calls pass it positionally: `deps.jobs.getById(actor.orgId, …)` (11 call sites),
  `deps.customers.getById(actor.orgId, …)` (5), `deps.jobs.list(actor.orgId, filter)`,
  `deps.customers.list(actor.orgId, filter)`, `deps.operations.getById(actor.orgId, …)` (4),
  `deps.operations.listRecent(actor.orgId, …)`, `deps.operations.listForResource(actor.orgId, …)`,
  `deps.accountingExports.getByJobId(actor.orgId, …)` (4), `deps.membership.isMember(actor.orgId, …)`.
- **The two exceptions, both benign and both checked.** `create-customer.ts` and `create-job.ts`
  have a private idempotency-replay helper whose signature takes `orgId: string` as a parameter
  rather than an `Actor`; its four calls inside (`deps.idempotency.find`,
  `deps.customers/jobs.getById`, `deps.operations.findCreateOperation`) pass that parameter, and its
  only caller passes `actor.orgId` (`create-customer.ts:81`, `create-job.ts:80`). No other value can
  reach it.
- Write calls pass the entity, and the entity carries the organization: `deps.jobs.commit({ job,
  expectedVersion, operation })`, `deps.customers.create({ customer, operation, idempotency })` and
  friends. The `orgId` on those objects is set to `actor.orgId` at construction
  (`create-customer.ts:91,103`, `create-job.ts:103,118`), the `operations` row is built the same
  way, and the SQL that persists them carries `org_id = ?` — asserted by the scoping test above.

Live confirmation of the end-to-end property is in §4.10: `outsider@example.invalid` asking for
`job_scheduled` gets `NOT_FOUND` with HTTP 404, not an authorization error and not the row.

### 4.13 Documents versus reality

- **All 18 documents from T23's list exist** (`README.md`, `ARCHITECTURE.md`, `AGENTS.md` and 15
  under `docs/`). `docs/` holds 16 documents in total — T24's `docs/bootstrap.md` is the sixteenth,
  added after T23's list was written — plus `docs/plan/`.
- **Every `pnpm <script>` cited by the repository's own documents exists.** Scanning all 69 markdown
  files outside `docs/plan/`, 29 distinct script names are referenced; all resolve in
  `package.json`, except the two classes of non-finding below.
  - `pnpm db:migrate:<env>` in `docs/database-and-migrations.md:181` is a prose placeholder; the
    three concrete scripts (`db:migrate:worker`, `:staging`, `:production`) all exist.
  - **A real gap, in framework-provided files rather than ours:** the four framework skill documents
    that `03-blueprint.md` deliberately keeps (`.agents/skills/{actions,agent-native-docs,security,storing-data}`)
    cite `pnpm actions:audit`, `pnpm agent`, `pnpm db:generate` and `pnpm prep`, **none of which
    exists in this repository**. They are upstream text written for a generic scaffold, they are
    committed here, and a coding agent that reads them will try commands that fail. Left as-is
    because editing framework-authored skills is out of T26's scope and no repository document
    points at those commands, but it is a genuine documents-versus-reality gap and it is recorded
    here rather than glossed over.
- **371 backticked file-path references check out.** Every one either resolves directly, resolves by
  basename (the test tables in `docs/testing.md` name files by basename inside a directory column),
  or is a deliberate non-existent example (`actions/assign-job.ts` and friends are the
  `docs/adding-a-feature.md` walkthrough; `.bootstrap.env` is git-ignored and created by the user).
  The two build outputs referenced by path are exact: `dist/BUILD_INFO.json` and
  `dist/_worker.js/PATCHED.json` both exist after a build and hold the fields the documents claim.
  `docs/deployment.md:73`'s claim that `wrangler.json` "is not used" is correct.
- **Commands cited by the documents, run:** `pnpm action --help` lists the 17 app actions (15
  application + `navigate` + `view-screen`) and then the framework's core actions.
  `pnpm action list-jobs --status nope` prints exactly what `AGENTS.md` says it does — `Invalid
  action parameters — status: Invalid option: expected one of "scheduled"|"in_progress"|"completed"|"archived"…
  Expected: { status?: …, customerId?: string, from?: string, to?: string, includeArchived?: boolean }`
  — which is the workaround for there being no per-action `--help` at 0.176.5. `node
  scripts/bootstrap.mjs --plan` and `--plan --only github-secrets` behave as documented.
- **Claims spot-checked against the code and confirmed:** `.nvmrc` is `22`; `docs/bootstrap.md`
  has exactly seventeen numbered steps as it claims; `app/i18n/index.ts` wires `nb-NO` behind a
  single `@ts-expect-error` with `supportedLocales: ["en-US"]`, as `docs/internationalization.md`
  describes; `ARCHITECTURE.md` §1's "the sync channel polls" matches `app/root.tsx`, which passes
  `sseUrl: false` with the reason in a comment; `docs/authentication-and-authorization.md`'s policy
  table matches `wrangler.jsonc` per environment, including the deliberate `—` for
  `AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT` in staging and production (the framework gates that flag
  on `isDevEnvironment()` *and* a loopback request, so it is a local-only switch); every `mcpTool`
  flag matches D12 (`true` on all 15 application actions, `false` on `navigate` and `view-screen`).
- **Two counting errors found and fixed in this change.** `README.md` said "Fourteen actions cover
  it: five queries, seven commands, and undo/redo"; there are fifteen — five queries, **eight**
  commands and two history actions. `docs/adding-a-feature.md` said "Seventeen files for one verb"
  under a list of nineteen paths. Both corrected, per `AGENTS.md`'s rule that the document is what
  is wrong.

### 4.14 GitHub state

| Check | Result |
| --- | --- |
| `gh run list --workflow CI --branch main --limit 3` | The run for the verified commit `760f349` is **success** (`verify`, `worker`, `e2e` all green, 5m07s). The run before it is `cancelled` — it was superseded when the next push landed 47 seconds later, not a failure. The one before that is **success**. |
| `gh api … --jq '.is_template'` | **`false`** — pending maintainer action (§6.3). |
| `gh api …/environments` | **`staging` only.** `production` and `production-backup` do not exist; `deploy-production.yml` and `backup-d1.yml` reference them. Pending maintainer action (§6.3). |
| `gh api …/branches/main/protection` | **HTTP 404 `Branch not protected`.** No branch protection and therefore no required checks. Pending maintainer action (§6.3). |
| `Deploy staging` workflow | **Has run and failed**, twice, at `pnpm db:migrate:staging` with `it's necessary to set a CLOUDFLARE_API_TOKEN environment variable`. Expected: no Cloudflare account is wired up yet. The workflow logic before that point (CI validation, build, artifact upload) succeeded. |
| `Deploy production` workflow | Registered, never run — it is `workflow_dispatch` only and requires a staging run id. |
| `Backup production D1` workflow | Registered as `Backup production D1`, never run. |

One benign warning worth naming so nobody chases it later: every staging deploy logs `The following
vars exist at the top level, but not on "env.staging.vars" … AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT`.
That is deliberate — the flag is a local-development switch and
`docs/authentication-and-authorization.md` documents it as unset in staging and production — but
Wrangler cannot know that, so the warning will recur.

---

## 5. Agent-Native limitations encountered

Version 0.176.5 of `@agent-native/core`, 0.19.3 of `@agent-native/toolkit`. Each of these cost real
work; each has a workaround in the repository and a record in `docs/plan/DISCREPANCIES.md` or
`docs/plan/02-framework-facts.md`.

1. **The documented Workers preset does not boot.** `cloudflare_module` calls `setInterval` at
   module scope and then `createRequire(undefined)` on workerd. Also reproduced against nightly
   0.177.0. Workaround: build with `cloudflare_pages` and deploy the single-file bundle as a Worker
   (D02).
2. **Two Node built-in stubs in the bundle throw on default-import access.** `fs.existsSync` and
   `os.homedir` are safe only as named imports; the agent-chat plugin init and the MCP client config
   reader use the default import, which silently disables agent chat, the audit actions and the MCP
   endpoint. Workaround: a two-replacement post-build patch that asserts each pattern matched exactly
   once (D03). Reported upstream with a minimal repro
   (`docs/plan/upstream-issues/fs-os-default-export-stubs.md`).
3. **A held-open SSE response is cancelled on Workers, and the cancellation kills `wrangler dev`.**
   The framework's `useDbSync` prefers `EventSource` on `/_agent-native/events`, which is exactly
   that shape. Workaround: `sseUrl: false` and the framework's own `/_agent-native/poll` transport.
   Streams that produce data and finish — agent chat — are unaffected.
4. **The framework owns ~50 tables and creates them on the first database touch, not at migration
   time.** A freshly migrated database has no `organizations` table until the app has served one
   request, so `pnpm db:seed` requires a running server and the seed has to write the scenario rows
   before it registers users (the framework resolves a user's active organization from `org_members`,
   so a user registered before its membership row exists gets no organization until the next
   sign-in).
5. **No per-action `--help` in the CLI.** `pnpm action --help` lists the actions, and `agent-native`
   even prints "Run any action with --help for usage details", but at 0.176.5 that runs the action.
   The working substitute is an invalid argument value, which prints the full parameter signature.
6. **The CLI prints Node-inspected objects and failure messages without application error codes.**
   Integration assertions inspect actual result objects and non-zero exit status; error *codes* are
   asserted against the use cases directly.
7. **`agent-native typecheck` prints production configuration errors and exits 0.** Diagnostic noise
   in every local and CI typecheck; harmless, but it makes the command's output misleading.
8. **`validateEnvironment(env)` cannot see a missing `APP_ENV` on Workers**, because the framework
   hands the plugin an already-defaulted environment. The rule is implemented where it can be.
9. **The framework's `no-env-credentials` doctor guard fires on legitimate deployment scripts**, so
   those carry explicit `guard:allow-env-credential` annotations.
10. **The locale list is closed, and much more coupled than it looks.** Adding one locale upstream
    touches `SUPPORTED_LOCALES`, `LOCALE_METADATA`, a 578-key catalog and a loader — plus nine
    further exhaustive `Record<LocaleCode, …>` maps in `packages/core`, two locale-coverage unit
    tests (all sixteen auth marketing surfaces and all seven MCP connect guides), nine first-party
    template aggregates asserting exhaustiveness, and a localized-docs coverage guard that produces
    201 findings for a brand-new locale. Upstream feature request BuilderIO/agent-native#3985 asks
    for app-registered locales; until it lands, `nb-NO` is not selectable at runtime.
11. **Framework server-side messages are English only.** The app's own UI is fully localized through
    both catalogs, but strings the framework's server emits (sign-in chrome, auth errors, MCP connect
    guidance) come from the framework's own catalogs for the locales it supports.
12. **The template's `createAuthPlugin({ marketing })` serves the sign-in document at `/` and hides
    the index route**, and a loader `redirect("/jobs")` at `/` breaks the Cloudflare static-shell
    build. The redirect is therefore client-side, and a smoke test must expect 200 from `/`.
13. **Two environmental failure classes in the upstream repository**, both reproduced on unmodified
    `upstream/main` and therefore not caused by T25's branch: `LanguagePicker.spec.tsx` and
    `localization/server.spec.ts` need `window.localStorage`, which Node 26 only provides with
    `--localstorage-file` (CI's Node 22 runs them unmodified); and `src/coding-tools/*` needs a
    sandboxed subprocess that can open sockets, failing 21 tests across four files on a clean
    checkout. A third, smaller one: `server/auth.spec.ts` loses a race for `./data/pglite` in a fully
    parallel whole-package run.
14. **The framework CLI's tsx launcher wants a local IPC socket**, which a restricted sandbox
    blocks; the seed helper uses Node's tsx import hook instead.

---

## 6. Remaining manual steps

Nothing below has been done, and none of it could be: no task in this plan was permitted to touch a
Cloudflare, Google or GitHub production resource. `docs/bootstrap.md` is the authoritative
seventeen-step checklist; this is what is outstanding as of 2026-09-08.

### 6.1 Cloudflare

1. **Enable the Workers Paid plan** (5 USD/month at time of writing). The bundle is 3.87 MiB gzip
   and the Free plan allows 3 MB. Not automatable.
2. **Create an API token** with the "Edit Cloudflare Workers" template plus D1:Edit. Not
   automatable; the token itself is the credential everything else needs.
3. **Create the two D1 databases** (`<app>-staging`, `<app>-production`) in the EU jurisdiction and
   put their ids into `wrangler.jsonc`, which still holds `REPLACE_ME` in both environments.
   `scripts/bootstrap.mjs --yes` does this.
4. **Set the Worker secrets per environment** — `BETTER_AUTH_SECRET` (generated, never written to
   disk), `ANTHROPIC_API_KEY`, `GOOGLE_SIGN_IN_CLIENT_ID`, `GOOGLE_SIGN_IN_CLIENT_SECRET`,
   `SEED_PASSWORD` for staging only. `scripts/bootstrap.mjs --yes` does this.
5. **Replace `REPLACE_ME_STAGING_HOST` and `REPLACE_ME_PRODUCTION_HOST`** in `wrangler.jsonc` with
   the real origins. `scripts/bootstrap.mjs --yes` does this.
6. **Optionally put Cloudflare Access in front of staging** (D24: documented, staging only, never
   production).

### 6.2 Google

7. **Create the OAuth client** (identity scopes only) in a Google Cloud project, and register the
   redirect URI — which is the framework's own `/_agent-native/google/callback`, verifiable against
   your own build with `curl -s http://localhost:8080/_agent-native/google/auth-url`. Not
   automatable.
8. **After the first production sign-in, enable "require Google sign-in" for the organization** from
   the Team page. Production already sets `AUTH_REQUIRE_EMAIL_VERIFICATION=1` with no email provider
   configured, which is what closes password sign-up; this is the second half.

### 6.3 GitHub

9. **Set the template flag.** `is_template` is currently `false`, so "Use this template" — the
   primary distribution path in D25 — does not work yet. `scripts/bootstrap.mjs --yes` does this.
10. **Create the `production` and `production-backup` environments.** Only `staging` exists.
    `deploy-production.yml` needs `production` **with required reviewers** (that reviewer is the
    whole promotion gate in D21), and `backup-d1.yml` needs `production-backup` deliberately
    *without* reviewers so the nightly export does not sit waiting for approval.
    `scripts/bootstrap.mjs --yes` creates them; confirm the reviewer afterwards.
11. **Enable branch protection on `main`** with `CI / verify`, `CI / worker` and `CI / e2e` as
    required checks. `gh api …/branches/main/protection` returns 404 today, so those three checks are
    documented as required in `docs/repository-settings.md` but are not actually enforced.
    `scripts/bootstrap.mjs --yes` does this.
12. **Set the GitHub environment secrets and variables** (`CLOUDFLARE_API_TOKEN`,
    `CLOUDFLARE_ACCOUNT_ID`, `STAGING_URL`, `PRODUCTION_URL`, the backup destination keys).
    `scripts/bootstrap.mjs --yes` does this. Until then `Deploy staging` keeps failing at
    `pnpm db:migrate:staging`, which is exactly what it does today.
13. **Install the Renovate GitHub App.** `renovate.json` is committed and configured (framework
    packages grouped, pinned, three-day minimum release age, never automerged), but the app itself
    must be installed by the repository owner. Not automatable.
14. **Configure the backup destination** — an S3-compatible bucket and optionally an `age` recipient.
    Without it the nightly export falls back to a 30-day workflow artifact, which is a real backup
    but not an off-platform one.

### 6.4 Before the first real deployment

15. ~~**Produce the model-backed eval evidence.**~~ **Done 2026-09-08: 5/5, see §4.7.** Re-run
    `RUN_MODEL_EVALS=1 pnpm eval -- --out eval-evidence.json` before each release and after any
    change to `agent/AGENTS.md`, the action descriptions or the framework pin — a model update can
    change the result with no change to this repository. A run that ends in a per-eval `error`
    evaluated nothing, whatever the scores beside it say.
16. **Rehearse a restore.** `bash scripts/restore-d1-check.sh <dump>` is the tested-by-guard test
    restore and it never touches production, but it has never been run against a real export. Do it
    once against a real staging dump before trusting the procedure.
17. **Decide what to do about the seven `pnpm audit --prod` advisories**, and consider adding
    `pnpm audit --prod` to CI. It is not a CI step today, so nothing in the pipeline notices a new
    advisory. All seven are transitive through the framework and, as far as this review can tell,
    unreachable from any action or route here — but that is an assessment, not a proof, and the real
    fix is a framework version that moves them.
18. **Run `node scripts/rename-app.mjs`** before any of the above if this is a real application
    rather than the template: it renames `example-jobs`, the package, the display name and the
    sample organization, which every Wrangler and D1 name is derived from.

---

## 7. Discrepancies encountered

`docs/plan/DISCREPANCIES.md` holds **61 entries**, every one with a `Resolution:` line. They are
append-only evidence, not a defect list — the plan was written before the framework was probed, and
each entry is a place where the probe won. Grouped by theme:

| Theme | Entries | What they were |
| --- | --- | --- |
| Framework runtime and Workers behaviour | 9 | The preset that does not boot; the two throwing stubs; the cancelled SSE stream; `getDbExec()` advertising both `atomicBatch` and `transaction` until its first query; the static shell breaking on a loader `redirect`; minifier identifiers containing `$`; framework tables appearing only after the first request (twice); `validateEnvironment` unable to see a missing `APP_ENV`. |
| The framework's own tooling and guards | 8 | `pnpm doctor` being pnpm's doctor, not the framework's; `agent-native typecheck` exiting 0 on production errors; `no-env-credentials` firing on deployment scripts; `no-env-credentials` refusing `SEED_PASSWORD` from `process.env`; the missing `workerd` placeholder in `pnpm-workspace.yaml`; `oxfmt` reformatting the plan's Markdown; a naively generated migrations manifest failing `oxfmt --check`; `actionlint` running shellcheck over `run:` blocks. |
| The CLI and the action surface | 5 | `actions/run.ts` being the CLI dispatcher, so deleting it broke `pnpm action`; no per-action `--help`; the generated registry being `.ts`, not `.js`; the CLI's inspected-object output; the framework's own `POST /_agent-native/org` also creating an organization. |
| Plan self-inconsistencies found while building | 12 | B7 and B22 disagreeing on a file path; "every exported constant contains `org_id = ?`" being impossible for the `WHERE` fragments; the in-memory `to` filter inclusive where the SQL was exclusive; unordered in-memory rows versus ordered D1 rows; B9's undo `inverse` shape not being a member of B4's union; B9 unable to redo the undo of a redo; B9's concurrency example impossible in the written order; "creates are never redone" not evaluable from versions; the container needing an `accounting` dependency no earlier task provided; the audit-row guard letting a lost update write an operation row; an idempotent create's replay needing a bounded query; the `git check-ignore` and JSONC parser assumptions in T01/T02. |
| UI, routing and i18n | 7 | `flatRoutes()` nesting `jobs.$id.tsx` under `jobs.tsx`, so `/jobs/:id` served the list; a second `<main>` inside the scaffold's; `{date}` reaching the screen because the framework substitutes `{{name}}` only; the missing `EXTERNAL` error group; `home.tsx` staying the chat page; `useOrgRole` living in `client/org`; the sign-in page always containing "Continue as local dev"; the chat template's Sidebar lacking the entries T03 expected to delete. |
| Tests, CI and determinism | 6 | Playwright's teardown hanging on inherited stdio and then `SIGKILL`ing the server; the framework audit log outliving the scenario reset; `pnpm eval` needing a wrapper; a timing-sensitive guard becoming flaky next to a parallel test file; verification the plan left manual plus two ambiguous accessible names; `noUncheckedIndexedAccess` breaking two scaffold files. |
| Deployment, promotion and backups | 5 | A staging run's `head_sha` not being promotion provenance; the backup workflow needing its own environment; a local backup run leaving production rows in an untracked directory; the accounting intent needing serialization against undo; the shared implementation worktree. |
| Bootstrap and the rename script | 7 | The Google redirect URI being the framework's own callback; the rename script's incomplete file list, which would also have rewritten the plan; JSON bodies needing stdin rather than a temp file; `wrangler d1 create` not reporting the new id machine-readably; `INSERT OR IGNORE` with a generated organization id not being idempotent; a rename moving where `oxfmt` breaks a line. |
| Norwegian upstream (T25) | 2 | Adding a locale being a repo-wide upstream change, not a five-file edit; upstream `main` being 0.177.0 against the pinned 0.176.5. |

The largest single contributors were T24 (6 entries), then T03, T07 and T08 (5 each).

Three of them are worth remembering because they are the shape of the whole project rather than one
bug: **the framework creates its own tables on the first request**, which decided how seeding and
every test fixture work; **a held-open stream is fatal on Workers**, which decided the sync
transport; and **`actions/run.ts` is the CLI dispatcher**, which is the reason `pnpm action` works at
all and is easy to delete by accident.

---

## 8. Known limitations

Ordered by how likely each is to matter to whoever runs this next.

1. **Model-backed eval evidence: produced 2026-09-08, 5/5 (§4.7).** It was pending when this report
   was written, and closing it changed one of the report's own conclusions: the run found that
   `agent/AGENTS.md` instructed the agent to obtain the accounting approval in conversation, which
   left the framework's `needsApproval` gate unreachable in the deployed app. No structural test
   could have caught that, so re-run the evals after any change to the instructions, the action
   descriptions or the framework pin — and treat a stale eval result as no result.
2. **The build depends on a two-replacement patch of framework-generated code.** It fails loudly
   rather than silently, and its assumptions are asserted (`tests/guards/worker-patches.test.mjs`,
   `dist/_worker.js/PATCHED.json`), but it is still surgery on someone else's output. D27 is explicit
   that more runtime surgery means reassessing the Node + libSQL fallback rather than accreting
   patches.
3. **Nothing has ever been deployed.** Both deployment workflows, the backup workflow, the D1 Time
   Travel bookmark, the promotion provenance check and the restore procedure are implemented and
   guard-tested against stubs, and `Deploy staging` has run far enough to prove its pre-Cloudflare
   half — but no Cloudflare resource exists yet. First deployment will find things this report
   cannot.
4. **The Workers Paid plan is a hard requirement.** 3.87 MiB gzip against the Free plan's 3 MB. That
   is the framework's bundle, not ours, so it will not shrink by anything we do.
5. **Norwegian is prepared but not shipped.** `app/i18n/nb-NO.ts` exists with all 129 keys and is
   wired behind a `@ts-expect-error` that becomes a compile error the moment the framework accepts
   the locale. The upstream change is on a fork branch (`anbergem/agent-native`,
   `feat/locale-nb-no`, commit `04fda1576`, 40 files) awaiting the maintainer's review before a PR
   is opened; `docs/plan/upstream-issues/nb-NO-pr.md` has the checklist. Until then Norwegian is not
   selectable at runtime.
6. **Framework server messages are English only**, even once the app's own UI is in another locale.
7. **The sync channel polls instead of streaming.** A deliberate trade for a runtime constraint
   (§5.3). Updates arrive on a poll interval rather than instantly, which for 1–20 users is
   invisible, and it is the reason `pnpm dev:worker` does not die.
8. **`pnpm audit --prod` exits 1 with seven advisories**, all transitive through the framework, and
   audit is not a CI step. See §4.11 and §6.4.
9. **No branch protection, so the three "required" checks are not required.**
   `docs/repository-settings.md` documents them as required and they are green on every run, but
   GitHub is not enforcing anything today.
10. **Four framework-provided skill files cite four scripts this repository does not have**
    (§4.13). Harmless to a human, misleading to a coding agent.
11. **A freshly migrated database is not immediately usable.** The framework's tables appear on the
    first request, so `pnpm db:seed` needs a server that has already opened the database. Documented
    in `README.md` and `docs/database-and-migrations.md`, but it surprises everyone once.
12. **One guard test skips in a restricted sandbox** (`process-group teardown waits for the detached
    launcher`), because that environment cannot signal a process group. Verified to run and pass in
    an unrestricted working tree on the same machine, and it runs in CI.
13. **The install measured here reused a warm pnpm store**, so "installs cleanly from a fresh clone"
    is proven for lockfile integrity and for the 1028-package graph, but not for a cold network
    fetch.
14. **`pnpm dev` and `pnpm dev:worker` use different databases** — a Node SQLite file and local D1 —
    from the same migrations. That is the design (D05), but a change seeded in one is not visible in
    the other, which reads as a bug the first time it happens.
15. **The repository is not registered as an Agent-Native community template.** D25 makes that a
    post-first-stable-tag step, so `create --template community:…` does not work yet, and "Use this
    template" needs the flag from §6.3.

---

## 9. Definition of done

Every line of `docs/plan/README.md`'s definition of done, with the evidence and the caveat where
there is one.

| Line | Status | Evidence |
| --- | --- | --- |
| Repository installs cleanly from a fresh clone with `pnpm install` | **met (caveat)** | §4.1. `--frozen-lockfile`, 1028 packages, exit 0. Warm store, so no cold network fetch was exercised. |
| `pnpm dev` starts the local app; `pnpm dev:worker` starts the built Worker on local D1 | **met** | §4.10 (dev on :8080, HTTP 200) and §4.5 (`verify:worker` builds and boots the bundle under `wrangler dev` on local D1, which is `dev:worker`'s serve step). |
| Local databases are initialised from the committed migrations only | **met** | §4.10 `pnpm db:reset` applies `0001_init.sql` and `0002_job_accounting.sql` and nothing else; §4.3 the same two on the integration database. |
| Deterministic seed data loads with `pnpm db:seed` | **met** | §4.10: 28 scenario statements, 5 users, fixed ids. |
| Local sign-in works with seeded users; production Google sign-in is documented | **met (caveat)** | §4.10 sign-in as `owner@example.invalid` returns a session that resolves to `org_acme`/`owner`. Google is documented in `docs/authentication-and-authorization.md` and `docs/bootstrap.md` step 3 with the framework's own callback URI; **never exercised**, because no Google client exists (§6.2). |
| Organization membership and roles work; cross-organization access is blocked and tested | **met** | §4.12; `tests/e2e/isolation.spec.ts` and `tests/e2e/authorization.spec.ts` pass (§4.6); `verify:worker`'s isolation check passes (§4.5); and live in §4.10 an outsider gets `NOT_FOUND` for another organization's job. |
| The sample Customer and Job flows work in the UI and through the agent, using the same actions | **met** | The UI half: `customers.spec.ts`, `jobs-lifecycle.spec.ts`, `jobs-list.spec.ts`, `complete-job.spec.ts` and `parity.spec.ts`, which asserts the UI and a direct HTTP call run the same action and differ only in `caller`. The agent half, as of 2026-09-08, is no longer structural: §4.7's 5/5 eval run has the model choosing `complete-job`, `undo-operation`, `list-jobs`, `send-job-to-accounting` and `archive-customer` through the same actions, with the approval gate and the authorization refusal both exercised. |
| Authorization is enforced inside the application layer, not in the UI | **met** | §4.11. `requireCapability` first in all 15 use cases; `tests/unit/application/authorization.test.ts`; `tests/e2e/authorization.spec.ts` asserts both that the button is hidden from a member *and* that the server refuses. |
| Every mutation produces an audit row; at least `complete-job` is undoable; undo refuses to overwrite newer changes | **met** | `complete-job.spec.ts` asserts the audit row and its `caller`; `undo.spec.ts` asserts undo restores status and is recorded as its own operation; `undo-conflict.spec.ts` asserts undo refuses when another user moved the record; `verify:worker`'s "reversible write, conflict, undo and isolation" proves the same on the built Worker. |
| Unit tests, the Worker smoke, and the hermetic Playwright suite pass locally and in GitHub Actions | **met** | Locally: §4.2 (312 + 38), §4.5 (12 checks), §4.6 (14 tests). In Actions: the CI run for `760f349` is green on all three jobs (§4.14). |
| Staging and production deployment workflows exist; staging smoke and production smoke exist | **met (caveat)** | All four workflows exist and `pnpm lint:workflows` is clean (§4.9). `Deploy staging` runs and fails at the first Cloudflare call for want of a token; `Deploy production` has never run. The smokes are `scripts/worker-smoke.mjs` (staging) and the read-only production smoke, both guard-tested (`tests/guards/worker-smoke.test.mjs`, `deployment-validation.test.mjs`). Never executed against a real environment. |
| A D1 backup workflow, restore instructions and Worker rollback instructions exist | **met (caveat)** | `backup-d1.yml`, `scripts/backup-d1.sh`, `scripts/restore-d1-check.sh`, `docs/backups.md` and `docs/runbook.md`. The restore *script* is covered by `tests/guards/restore-d1-check.test.mjs`; no real dump has been restored (§6.4.16). |
| No secrets are committed; framework packages are pinned exactly; Renovate is configured | **met (caveat)** | §4.11's whole-history scan finds only test fixtures. `@agent-native/core` `0.176.5` and `@agent-native/toolkit` `0.19.3`, no carets. `renovate.json` is committed and configured; **the Renovate GitHub App is not installed** (§6.3.13), so nothing is opening those pull requests yet. |
| `AGENTS.md`, `ARCHITECTURE.md`, `README.md` and the `docs/*.md` set are complete | **met (caveat)** | §4.13: all 18 present, every cited `pnpm` script in the repository's own documents exists, 371 path references check out, cited commands behave as described. Two counting errors were found and fixed in this change; four framework-provided skill files still cite four non-existent scripts. |
| The repository is usable as a GitHub template without retaining upstream git history | **pending** | `is_template` is `false` (§4.14, §6.3.9) — a maintainer setting, not a code gap. The history-free path itself is implemented and documented: "Use this template" starts a fresh history, `scripts/rename-app.mjs` renames everything, and `docs/template-workflow.md` covers porting with `git format-patch` / `git am --3way`. |
| MIT license present; no customer-specific information anywhere | **met** | `LICENSE` is MIT. Sample names are `Acme Services`, `Other Company`, `Example Customer A/B`, `Example Job` and addresses under `example.invalid` throughout; `scripts/check-config-hygiene.mjs` and the plan's generic-content rule keep it that way. |

**Summary: 16 of 17 lines met (7 of them with a stated caveat), 1 pending on a maintainer setting.**
Updated 2026-09-08: the agent-parity line lost its caveat when the eval evidence came in at 5/5
(§4.7). What now stands between this repository and a first real deployment is the
Cloudflare/Google/GitHub setup in §6, all of which `scripts/bootstrap.mjs` performs except the six
steps that need a browser, a payment method or a human decision.
