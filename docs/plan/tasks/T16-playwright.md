# T16 — Playwright end-to-end suite

Goal: the hermetic browser suite from B18 running against the built Worker on local D1.

Depends on: T12, T15. Read: F6, F9; B12, B18, B19.

## Steps

1. `scripts/e2e-server.mjs`: own a fresh temporary Wrangler configuration and `--persist-to`
   directory (never the repository's `.wrangler/state`); `wrangler d1 migrations apply
   example-jobs-local --local`; spawn `wrangler dev --port 8787 --ip 127.0.0.1 --local`
   detached, with its stdio **piped and forwarded**, never inherited — a descendant holding
   Playwright's own stdio handles keeps them open and hangs the whole run at teardown; poll
   `http://127.0.0.1:8787/_agent-native/ping`; request `/_agent-native/health` once (this makes
   the framework create `organizations`, `org_members` and its other tables — they do not exist
   before the first request, T11); then apply the scenario SQL with `wrangler d1 execute
   example-jobs-local --local --file` while the server runs (verified in T11), and record the
   configuration and persist paths in the `--state-file` the caller passes, last, so the global
   setup and the reset fixture can tell a seeded server from a merely listening one. Keep the
   process alive until killed, forward SIGTERM/SIGINT by terminating the whole Wrangler process
   group, and report an exit nobody asked for as a failure. Requires `dist/`; exit 1 with a
   message if missing.
2. `playwright.config.ts`: `testDir: "tests/e2e"`, `workers: 1`, `fullyParallel: false`,
   `retries: process.env.CI ? 1 : 0`, `reporter: [["list"], ["html", { open: "never" }]]`,
   `use: { baseURL: "http://127.0.0.1:8787", trace: "on-first-retry" }`,
   `webServer: { command: "node scripts/e2e-server.mjs --state-file <absolute path>", url: "http://127.0.0.1:8787/_agent-native/ping", timeout: 180_000, reuseExistingServer: false, gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 } }`,
   `globalSetup: "tests/e2e/global-setup.ts"`, one `chromium` project. `gracefulShutdown` is
   required: Playwright's default teardown is SIGKILL, which no handler can catch, and the
   detached Wrangler group then survives holding port 8787.
3. `tests/e2e/global-setup.ts`: the scenario SQL was applied by the server script; here only
   register the five users over HTTP (`node scripts/seed.mjs` cannot be reused for that alone,
   so call the register/login endpoints directly, treating HTTP 409 as "exists") and log each in,
   saving storage state to `tests/e2e/.auth/<name>.json`; then run the local-mode smoke
   (`scripts/worker-smoke.mjs` as a child process with the owner QA credentials) and fail setup
   if it fails.
4. `tests/e2e/fixtures.ts`: `test` extended with `ownerPage`, `adminPage`, `memberPage`,
   `outsiderPage` (new context per fixture from the stored state) and an `assertSameOrigin`
   auto-fixture that registers `page.on("request")` and throws on any URL whose origin differs
   from `baseURL` (allow `data:` and `blob:`).
5. Give each mutating test a fresh scenario (reset and reseed the two test orgs) or unique
   resources. One worker prevents concurrency but does not prevent state leaking between tests.
   The reset must also delete the two organizations' rows from the framework's own
   `agent_audit_log`, which `buildScenarioResetSql()` deliberately does not touch: without it
   the global setup's smoke rows and earlier tests' rows make every exact audit assertion
   depend on the order the suite ran in.
   Specs (one file each): `auth.spec.ts` (owner loads `/jobs`, header shows the email and
   "Acme Services"); `jobs-list.spec.ts` (member sees three jobs); `complete-job.spec.ts`
   (member completes `job_in_progress`; status badge updates; activity page shows the
   operation; `GET /_agent-native/actions/list-audit-events?targetType=job&targetId=job_in_progress`
   via `page.request` contains `action: "complete-job"`, `caller: "frontend"`); `undo.spec.ts`
   (complete then Undo from the toast; status restored; activity shows an `undo` operation);
   `undo-conflict.spec.ts` (member reschedules `job_scheduled` in the UI; admin completes it via
   `page.request.post("/_agent-native/actions/complete-job")`; member clicks Undo; the UI shows
   the CONFLICT message; status stays completed); `isolation.spec.ts` (outsider visits
   `/jobs/job_scheduled` and sees the not-found state; `page.request.get(".../get-job?jobId=job_scheduled")`
   returns 404); `authorization.spec.ts` (member's `page.request.post(".../archive-customer")`
   returns 403 with `errorCode: "AUTHORIZATION"`; admin's returns 200); `parity.spec.ts`
   (member calls `complete-job` for `job_in_progress` via `page.request` (caller `http`), then the
   audit trail lists the row with `caller: "http"`, and the job page reflects the change).
   Two more specs carry the T14 verification that is otherwise only manual:
   `customers.spec.ts` (a member creates a customer in the dialog and opens its detail route)
   and `accounting.spec.ts` (the export button is hidden from a member, an admin confirms the
   irreversible dialog, the returned reference is shown, and the recorded operation is neither
   undoable nor redoable).
6. `package.json`: `test:e2e`, `test:e2e:full` per B15; add `playwright-report/` and
   `test-results/` to `.gitignore` (T00 did).

## Deliverables

`scripts/e2e-server.mjs`, `playwright.config.ts`, `tests/e2e/{global-setup.ts,fixtures.ts,*.spec.ts}`,
`package.json`.

## Acceptance

```bash
pnpm check
pnpm exec playwright install --with-deps chromium
pnpm test:e2e:full
```
