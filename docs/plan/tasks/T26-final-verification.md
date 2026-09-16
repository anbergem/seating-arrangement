# T26 — Final verification and report

Goal: prove the definition of done and write the final report.

Depends on: T24, T25. Read: `docs/plan/README.md` definition of done; the original spec
section 46.

## Steps

1. Fresh clone into a new directory; `pnpm install --frozen-lockfile`; `pnpm check`;
   `pnpm test:integration`; `pnpm build:worker`; `pnpm test:e2e`; `pnpm db:reset && pnpm dev`
   + `pnpm db:seed` + manual sign-in; `pnpm eval` (skipped run), plus the real agent write/read/undo and approval evidence from
   T17 when credentials are available. A skipped run cannot satisfy that release criterion;
   explicitly list it as pending when unavailable. Record every command and its
   last lines.
2. Security review checklist (write results into the report): every SQL constant scoped
   (test exists); every action goes through `runAppAction`; no `authorize`-less path to a use
   case; env-check covers production; `check:config` passes; `git log -p | grep -iE
   "secret|token|api[_-]?key" ` shows only names; `pnpm audit --prod` output summarised.
3. Organization scoping review: grep for `orgId` in use cases, confirm every repository call
   passes `actor.orgId`.
4. Docs versus reality: run the script from T23's acceptance again; open each doc and verify
   the commands.
5. Confirm GitHub: CI green on `main`; template flag set (maintainer); environments exist
   (maintainer). Anything the maintainer must still do goes into the report's "remaining manual
   steps".
6. Write `docs/plan/FINAL-REPORT.md` with the six headings from the original spec section
   46 item 10, plus "Discrepancies encountered" summarising `DISCREPANCIES.md`, and "Known
   limitations" (framework patch, Norwegian pending upstream, Workers Paid plan, first-request
   framework bootstrap on D1, English-only framework server messages).
7. Remove the "while the plan is active" section from `AGENTS.md` and mark every task `done`
   in `tasks/README.md`. Keep `docs/plan/` in the repository as design history.

## Deliverables

`docs/plan/FINAL-REPORT.md`, `AGENTS.md`, `docs/plan/tasks/README.md`.

## Acceptance

All commands in step 1 pass from a fresh clone; the report exists and is complete.
