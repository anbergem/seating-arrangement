# Task index

Status values: `todo`, `in-progress (<who>)`, `blocked (<discrepancy id>)`, `done (<PR>)`.
Update this table in the same pull request that delivers the task. Pick ready tasks in this order after T11: review corrections → T12/T13 with CI → T27 →
T14/T15/T16 → T17/T18 → delivery/docs/final verification. CI grows with each milestone.

| ID | Title | Depends on | Status |
| --- | --- | --- | --- |
| T00 | Scaffold and repository baseline | — | done (PR #2) |
| T01 | Toolchain, scripts, hygiene checks | T00 | done (PR #3) |
| T02 | Worker build pipeline and Wrangler configuration | T01 | done (PR #4) |
| T03 | Framework configuration and template cleanup | T02 | done (PR #5) |
| T04 | Domain layer | T01 | done (PR #6) |
| T05 | Application core: errors, authorization, actor, ports, in-memory doubles | T04 | done (PR #7) |
| T06 | Schema, migrations, local migration runner, readiness route | T03, T05 | done (PR #8) |
| T07 | Infrastructure: repositories, atomic writes, container | T06 | done (PR #9) |
| T08 | Query use cases and actions | T07 | done (PR #10) |
| T09 | Command use cases and actions | T08 | done (PR #11) |
| T10 | Undo and redo | T09 | done (PR #12) |
| T11 | Seed scenario and seed script | T07 | done (PR #13) |
| T12 | Worker smoke script | T10, T11 | done (PR #15) |
| T13 | Integration tests through the CLI surface | T10, T11 | done (PR #15) |
| T14 | User interface | T10, T27 | done (PR #17) |
| T15 | Internationalization | T14 | done (PR #17) |
| T16 | Playwright end-to-end suite | T12, T15 | done (PR #17) |
| T17 | Agent evals | T10, T11 | done (PR #17) |
| T18 | CI workflow | T13, T16, T17 | done (PR #17) |
| T19 | Staging deployment workflow | T18 | done (PR #16) |
| T20 | Production deployment workflow | T19 | done (PR #16) |
| T21 | Backups and restore | T20 | done (PR #16) |
| T22 | Renovate, upgrade playbook, repository settings | T18 | done (PR #16) |
| T23 | Documentation set | T21, T22 | done (PR #19) |
| T24 | Bootstrap script, checklist and rename script | T23 | done (PR #19) |
| T25 | Norwegian Bokmål upstream change (prepared for maintainer review) | T15 | done (PR #18) |
| T26 | Final verification and report | T24, T25 | done (PR #20) |
| T27 | External integration port and `send-job-to-accounting` | T10 | done (PR #15) |

Parallelism: T04 and T05 can run in parallel with T02/T03. T11 can run in parallel with
T08–T10. T27 follows the Worker/CLI proof (T12/T13) and precedes T14. T14/T15 can run in parallel with T12/T13. T25 can run any time after T15.

## Common acceptance rule

Unless a task says otherwise, every task's acceptance includes `pnpm check` passing (once T01
exists) and `git diff --stat` showing the listed deliverables, documented correctness fixes needed for the task, plus
`docs/plan/tasks/README.md` and, when applicable, `docs/plan/DISCREPANCIES.md`.
