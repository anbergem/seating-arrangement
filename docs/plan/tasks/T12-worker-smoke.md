# T12 — Worker smoke script

Goal: `scripts/worker-smoke.mjs` implementing the B19 contract for local, staging and production.

Depends on: T10, T11. Read: F9, F12; B19.

## Steps

1. Implement the script with `fetch` (Node 22 global), a cookie jar for the QA session (parse
   `set-cookie`, send `cookie`), `--run-id` (default `<timestamp>`), one check per row of the
   B19 table gated by `--mode`, output `[ok] <check>` / `[fail] <check>: <detail>`, exit 1 on
   any failure, overall timeout 120 s. Readiness: retry `ping` up to 60 times with 2 s sleeps
   before the first check. Agent-chat check: read past metadata until meaningful content or an error, bounded by 2 KB and the request deadline; cancel the reader. Local missing credentials proves runtime wiring only.
2. `package.json`: `smoke` per B15.
3. Verify locally with `pnpm verify:worker`. This builds the Worker, reserves a local port,
   applies application migrations into a fresh temporary D1 persist directory, boots framework
   tables through health, loads the scenario and registers users, runs all local checks, and
   terminates the entire Wrangler/workerd process group before removing state. No development
   database is reset. The standalone smoke needs explicit `--base-url` and `--mode` arguments.

## Deliverables

`scripts/worker-smoke.mjs`, `scripts/verify-worker.mjs`, HTTP helper, guard tests, `package.json`, CI smoke step.

## Acceptance

```bash
pnpm check
```
plus the step 3 transcript showing every `[ok]` line.
