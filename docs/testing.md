# Testing

Seven layers, each answering a question the layer below it cannot. A feature is not complete
when only the UI works.

| Layer | Where | Command | Runtime |
| --- | --- | --- | --- |
| Domain | `tests/unit/domain` | `pnpm test:unit` | Node, no I/O |
| Application | `tests/unit/application` | `pnpm test:unit` | Node, in-memory doubles |
| Guards | `tests/guards` | `pnpm test:guards` | Node, the scripts themselves |
| Integration | `tests/integration` | `pnpm test:integration` | Node, a real SQLite file |
| Worker smoke | `scripts/worker-smoke.mjs` | `pnpm verify:worker` | workerd, local D1 |
| Browser | `tests/e2e` | `pnpm test:e2e:full` | Chromium against workerd |
| Evals | `evals/` | `pnpm eval` | The real model, opt-in |

```bash
pnpm check              # lint, typecheck, doctor, boundaries, config, unit, guards, i18n
pnpm test:integration
pnpm verify:worker
pnpm test:e2e:full
```

Those four are what CI runs and what a pull request pastes.

## Domain tests

`tests/unit/domain/{customer,job,operation}.test.ts`. Pure functions in, pure functions out:
which transitions are allowed, which throw `INVARIANT`, which inputs throw `VALIDATION`, that
`version` increments exactly once, that `updatedAt` is the `now` that was passed in.

They are fast because there is nothing to set up — the domain imports nothing, takes time as an
argument and has no I/O. That is the whole reason for the boundary.

**What they prove:** the business rules. **What they cannot:** that anybody is allowed to invoke
them.

## Application tests

`tests/unit/application/`. Every use case, against the in-memory repositories in
`tests/fixtures/in-memory.ts`.

| File | What it covers |
| --- | --- |
| `authorization.test.ts` | The whole role/capability table. Adding a capability fails this until you update it. |
| `actor.test.ts` | `resolveActor`: no user → `AUTHENTICATION`; no org → `AUTHORIZATION`; no membership → `AUTHORIZATION` |
| `queries.test.ts` | Filters, defaults, and that a foreign organization's rows are never returned |
| `commands.test.ts` | Each command's happy path, capability denial, `NOT_FOUND` for a foreign id, `CONFLICT` on a stale version, and the operation row it writes |
| `undo.test.ts` | The undo and redo algorithm, including the concurrency scenario below |
| `send-job-to-accounting.test.ts`, `accounting-history.test.ts` | The external-integration flow: response loss, concurrent requests, an archive between the vendor call and the local commit, and that undo cannot reopen a job with a pending export |
| `errors.test.ts` | `DomainError` → `AppError` mapping and the HTTP status table |

The concurrency scenario is worth naming, because it is the property that makes undo safe:
user A reschedules a job v12 → v13; user B completes it v13 → v14; A's undo of their own
reschedule is refused with `CONFLICT`; B's undo of the completion succeeds, taking it to v15;
A's undo is *still* refused, because 15 is not 13. The test asserts all four outcomes.

**What they prove:** authorization, organization scoping, orchestration, conflict handling —
without a database. **What they cannot:** that the SQL says what the in-memory double says.

The doubles are deliberately faithful about the things that have bitten us: they sort like the
D1 adapters, and their `to` filter is exclusive like the SQL fragment. When a double and an
adapter disagree, one of them is a bug.

## Guard tests

`tests/guards/*.test.mjs`, run by `node --test`. These test the *scripts*, which are as
load-bearing as the application and easier to break silently.

| File | What it covers |
| --- | --- |
| `boundaries.test.mjs` | Fixtures for every import form — multiline, side-effect, dynamic, type-only, re-export — proving the checker still catches each |
| `worker-patches.test.mjs` | Both bundle patches against executable fixtures, plus missing, duplicate and throwing-unknown-API cases |
| `deployment-validation.test.mjs` | Every promotion refusal: failed run, unrelated workflow, wrong branch, wrong repository, incomplete run, wrong SHA, mismatched manifest, tampered bundle hash |
| `restore-d1-check.test.mjs` | The restore check imports a fixture dump and reports real row counts |
| `worker-smoke.test.mjs` | The smoke script's own argument handling and check selection |
| `i18n-catalogs.test.mjs` | That two catalogs agreeing on a *broken* placeholder still fail the guard |
| `bootstrap.test.mjs` | The bootstrap script against stub `wrangler`, `gh` and `pnpm` on a temporary PATH: the plan, idempotency, the exact argument arrays and JSON bodies, every refusal, and that no secret reaches stdout or stderr |
| `wrangler-vars.test.mjs` | That a var declared only at the top level of `wrangler.jsonc` is reported for every environment that omits it — wrangler does not inherit `vars`, and the only other sign is a warning in a deploy log |
| `eval-json.test.mjs` | That a model-backed `--json` run puts one JSON document on stdout and its preparation output on stderr, that `--out` writes that document itself and still gates on the exit code, with every provider credential stripped so it makes no paid request |

`bootstrap.test.mjs` is the pattern to copy for anything that drives a cloud CLI: the stubs
record their argv and their stdin and answer from a small mutable world, so the test can assert
that the second run creates nothing, and the real tool is never invoked.

## Integration tests

`pnpm test:integration` runs `scripts/test-integration.mjs`, which owns the whole database
lifecycle: it creates `data/test-integration.db`, applies `migrations/`, seeds the scenario by
SQL, then runs Vitest and the CLI assertions. Vitest only checks that the prepared database
exists, so it cannot erase the CLI fixtures mid-run.

- `repositories.test.ts` — the real parameterized SQL and the real atomic batches: that a
  stale `commit` throws `CONFLICT` **and leaves no operation row**, that a create against an
  archived customer is `NOT_FOUND`, that `markUndone` cannot outlive a batch whose guards
  failed, and that the executor probe works when the first database call of the process is a
  write.
- `use-cases-d1.test.ts` — the same use cases the unit tests cover, against real SQL, so a
  divergence between the double and the adapter shows up.
- The CLI surface: `AGENT_USER_EMAIL=member1@example.invalid AGENT_ORG_ID=org_acme pnpm action
  complete-job '{"jobId":"job_in_progress"}'` returns a completed job and writes a `forward`
  operation; `outsider@example.invalid` asking for an Acme job gets `NOT_FOUND`;
  `member1@example.invalid` claiming `org_other` gets `AUTHORIZATION` *before* any resource
  access.

That last one is the parity claim tested at its cheapest layer: the CLI is a different
`ctx.caller` reaching the same action.

**What they prove:** the SQL, the atomicity, the version guards, and one non-browser surface.
**What they cannot:** that the bundle boots on workerd.

## Worker smoke

`pnpm verify:worker` builds the Worker, creates its **own** temporary D1 state, applies
migrations, seeds, starts `wrangler dev`, runs `scripts/worker-smoke.mjs` against it and then
removes only its own temporary state.

Playwright uses port 8787 by default. Set `E2E_PORT` to another unused loopback port when a
separate local Worker already owns it, for example `E2E_PORT=8797 pnpm test:e2e:full`.

```bash
node scripts/worker-smoke.mjs --base-url http://127.0.0.1:8787 --mode local \
  --qa-email owner@example.invalid --qa-password "$SEED_PASSWORD" --expect-org-id org_acme
```

| Check | local | staging | production |
| --- | :-: | :-: | :-: |
| `GET /_agent-native/ping` is 200 `{"message":"pong"}` | ✓ | ✓ | ✓ |
| `GET /_agent-native/health` 200, `db === true`, `dialect === "d1"` | ✓ | ✓ | ✓ |
| `GET /api/ready` 200 with `applied === expected` | ✓ | ✓ | ✓ |
| `GET /sign-in` 200 HTML | ✓ | ✓ | ✓ |
| `GET /` is 200 — the static shell, never a 302 | ✓ | ✓ | ✓ |
| `list-jobs` unauthenticated is 401 | ✓ | ✓ | ✓ |
| `POST /mcp` unauthenticated is 401 with `WWW-Authenticate` | ✓ | ✓ | ✓ |
| Sign in as the QA user, `org/me.orgId` matches | ✓ | ✓ | — |
| `list-jobs` authenticated is a 200 array | ✓ | ✓ | — |
| A reversible write: `create-job` with an idempotency key, then `archive-job` | ✓ | ✓ | — |
| `POST /_agent-native/agent-chat` returns `text/event-stream` | ✓ | ✓ | — |

**The production smoke is read-only.** No sign-in, no writes, no agent chat: a deployment check
must not create rows in a customer's database. Locally the agent-chat check expects the first
event to be `missing_credentials`, which proves the runtime path without a provider key.

**What it proves:** the built bundle boots on workerd, the framework's own migrations run, and a
real authenticated action flow works end to end. **What it cannot:** that the UI wires any of it
up.

## Browser tests

`pnpm test:e2e:full` builds the Worker and runs Playwright against it — one worker, Chromium,
no mocks. `scripts/e2e-server.mjs` resets `.wrangler/state`, applies migrations, starts
`wrangler dev`, waits for `ping`, requests `/_agent-native/health` once so the framework
creates its tables, then applies the scenario SQL while the server keeps running. It generates
its own Wrangler configuration in a temporary directory and sets
`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`, so the suite is independent of any developer's
`.dev.vars`.

`global-setup.ts` registers the five seed users over HTTP, signs each in, and stores a storage
state per role. The fixtures are `ownerPage`, `adminPage`, `memberPage`, `outsiderPage`.

Two properties every page fixture carries:

- **A no-phone-home assertion.** Each fixture attaches a request listener that fails the test
  on any request whose origin differs from `baseURL`. So a dependency that starts calling an
  analytics endpoint fails the browser suite, which is the only place that could catch it. The
  configuration side of the same promise is `scripts/check-config-hygiene.mjs`, which forbids
  the analytics, Builder and Sentry keys from appearing anywhere.
- **A scenario reset before every test**, which also deletes this organization's rows from the
  framework's `agent_audit_log` — the framework's table is not in the application's reset, so
  audit-count assertions would otherwise depend on the order the suite happened to run in.

| Spec | What it proves |
| --- | --- |
| `auth.spec.ts` | Sign-in and the dashboard |
| `jobs-list.spec.ts` | A member lists and filters jobs |
| `jobs-lifecycle.spec.ts` | Start, reschedule, complete, archive through the UI |
| `complete-job.spec.ts` | The mutation appears in activity **and** in the framework audit trail with `caller: "frontend"` |
| `undo.spec.ts` | Undo restores the status and appears as its own operation |
| `undo-conflict.spec.ts` | Reschedule in the UI, complete over HTTP as another user, then undo shows the conflict |
| `customers.spec.ts` | A member creates a customer in the dialog and opens its detail route |
| `authorization.spec.ts` | A member calling `archive-customer` over HTTP gets 403 |
| `isolation.spec.ts` | An outsider at `/jobs/job_scheduled` sees not-found, and `get-job` returns 404 |
| `accounting.spec.ts` | The export button is hidden from a member; an admin confirms an irreversible dialog; the operation is neither undoable nor redoable |
| `parity.spec.ts` | A UI click and an HTTP call reach the same action — the audit rows differ **only** in `caller` |

Two teardown details, learned the hard way and easy to reintroduce: Wrangler's stdio is piped
rather than inherited (a descendant holding Playwright's own handles hangs the run at
teardown), and `playwright.config.ts` sets `gracefulShutdown: { signal: "SIGTERM" }` (the
default `SIGKILL` cannot be caught, so the cleanup handler never ran and the detached Wrangler
group survived).

**What they prove:** the wiring, the real Worker, real cookies, real navigation, and parity.
**What they cannot:** whether the model chooses the right action.

## Evals

`evals/*.eval.ts`, run by `pnpm eval` → `scripts/run-evals.mjs`. Evals ask a different kind of
question: given a sentence a person might type, does the model pick the right action, aim it at
the right target, get a successful tool result, and leave the intended state behind?

```bash
pnpm eval                                       # all skipped, exits 0 — proves discovery only
RUN_MODEL_EVALS=1 ANTHROPIC_API_KEY=… pnpm eval # the real thing

# the release artifact
RUN_MODEL_EVALS=1 pnpm eval -- --out eval-evidence.json
```

`--out` implies `--json` and writes the file from inside the script, never through a shell
redirection: `pnpm run` writes its `[ELIFECYCLE]` failure line to stdout, which would corrupt the
document on precisely the runs worth recording. `tests/guards/eval-json.test.mjs` holds both paths
clean — it runs the model-backed path with every provider credential stripped from the child
environment, so engine resolution refuses before any request is made and the guard costs nothing.

`pnpm eval` runs `scripts/eval-suite.ts`, not `agent-native eval`. The CLI at 0.176.5 calls
`runEvalSuite` without a `systemPrompt`, and the Anthropic engine then puts `cache_control` on an
empty system block, which the API rejects — every eval fails with
`system.0: cache_control cannot be set for empty text blocks` before the model is consulted. The
driver supplies `instructions.runtime` from `agent-native.config.ts`, so the evals score the agent
the app actually deploys, and mirrors the CLI's arguments, JSON shape and exit codes. See
`docs/plan/upstream-issues/eval-system-prompt.md`.

Read a report carefully: a scorer that asserts an *absence* passes vacuously when the agent never
ran, so `no-mutations` and `persisted-state` can score 1 on a run that made no model call at all.
A per-eval `error` field means nothing was evaluated, whatever the scores beside it say.

`scripts/run-evals.mjs` creates a temporary SQLite database, applies `migrations/` and seeds the
scenario **only** for `RUN_MODEL_EVALS=1`, and sets `NODE_OPTIONS=--import tsx` because
`agent-native eval` loads the eval files in a plain Node process whose type stripping cannot
resolve the extensionless imports the application layers use. A skipped run touches no
database.

| Eval | What it asserts |
| --- | --- |
| `complete-job` | `usesTool("complete-job")`, aimed at the in-progress job |
| `list-today` | `usesTool("list-jobs")`, and a custom scorer asserting **no** mutating tool was called |
| `undo` | `usesTool("undo-operation")` after a completion |
| `accounting-approval` | The agent pauses for explicit human approval and leaves no export request |
| `member-denial` | Ends in an authorization denial, not merely the right tool choice |

Evals are **release evidence, not a pull-request gate** — they cost money, they need a
provider key, and a model update can change the result without any code changing. Run them
before a release and record the outcome; a skipped run is not model validation, and the
upgrade playbook says to report release evidence as pending rather than claim it.

## What no test covers

Two things still need a person, and they are listed here so nobody assumes otherwise:

- **The agent answering a real question** ("list my jobs") in the deployed UI, and the German
  or Norwegian round trip of the language picker. Both need a provider key or a human eye.
- **A restore from a real production backup.** `scripts/restore-d1-check.sh` proves a dump
  imports and has plausible row counts; it cannot prove your production backup is the one you
  think it is. `docs/backups.md` asks for that quarterly, by hand, with the date and the counts
  written down.
