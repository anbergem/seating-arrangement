# Implementation plan — how to use it

## Status

**This plan was executed. It finished on 2026-09-08**, when task T26 verified the definition of
done below from a fresh clone of `main` at commit `760f349`; every task T00–T27 is now `done` in
`tasks/README.md` with its pull request number. The plan is kept in the repository as design
history, not as work in progress: nothing here describes anything still to be built, and root
`AGENTS.md` no longer routes work through it. **The final report is
[`FINAL-REPORT.md`](FINAL-REPORT.md)** — what was implemented, the decisions that shaped it, the
commands that were run with their output, the framework limitations that were hit, what a
maintainer must still do for Cloudflare, Google and GitHub, and the definition-of-done table with
its caveats. Read that first; read the rest of this directory when you want to know *why*
something is the way it is. `docs/bootstrap.md` says when it is safe to delete.

## What this directory is

This directory is the complete, self-contained specification for building the
`agent-native-cloudflare-starter` template repository. It was written so that an
implementer with no memory of the design conversation can pick up any single task and
finish it correctly.

## Files

| File | What it is | When to read it |
| --- | --- | --- |
| `README.md` (this file) | Workflow, rules, definition of done | Always, first |
| `01-decisions.md` | Every design decision with its reasoning | Skim once; consult when a task references a decision id such as D07 |
| `02-framework-facts.md` | Verified facts about Agent-Native 0.176.5, Wrangler, D1, pnpm, including known bugs and their exact workarounds | Read the sections your task lists |
| `03-blueprint.md` | The target architecture: layout, layers, names, types, SQL, algorithms, environments, CI design | Read the sections your task lists |
| `tasks/README.md` | Task index, dependency order, status table | To pick a task and to update status |
| `tasks/T*.md` | One self-contained task each | Your assigned task |
| `DISCREPANCIES.md` | Append-only log of places where reality differed from the plan | Whenever you hit one |

The original product specification that this plan implements lives at
`docs/plan/00-original-spec.md`. It is the source of the requirements; the plan is the source
of the implementation. If the two conflict, the plan wins, and the conflict is recorded in
`01-decisions.md`.

## Workflow for one task

1. Pick the lowest-numbered task in `tasks/README.md` whose status is `todo` and whose
   dependencies are all `done`.
2. Set its status to `in-progress` with your name in the same PR that delivers it.
3. Create a branch from `main` named `task/<ID>-<slug>`, for example `task/T12-authorization`.
4. Read, in this order: this file; the task file; the listed sections of
   `02-framework-facts.md` and `03-blueprint.md`; every existing file the task lists under
   "Read before starting".
5. Implement the task’s intended behavior. Use the numbered steps as a starting point. Where a step
   says "verify", run the command and keep the output for the PR.
6. Run every command under the task's "Acceptance" heading. All must pass. If a command does
   not exist yet because an earlier task was not done, that is a dependency error: stop and
   report it.
7. Open a pull request titled `<ID>: <task title>`. The PR body must contain: the acceptance
   command outputs, the list of files changed, and any `DISCREPANCIES.md` entries added.
8. Set the task status to `done` in `tasks/README.md` in the same PR.

## Rules

- **Scope.** Keep changes focused on the task’s intended behavior. Include small correctness
  fixes to dependencies, fixtures, signatures and guards when needed; explain them in the PR
  and update affected plan instructions. Unrelated features remain out of scope.
- **Dependencies.** Prefer existing packages. A necessary new package must be pinned exactly,
  justified in a decision record, and included in the lockfile and verification.
- **Framework evidence.** `02-framework-facts.md` is a versioned record of observations, not
  a substitute for testing. Verify APIs against installed docs/types and update stale facts.
- **Discrepancy protocol.** Append evidence and resolution to `DISCREPANCIES.md`. Correct
  affected normative text in the blueprint and downstream task files in the same change.
  Preserve product intent, invariants and security policy. Escalate material design changes;
  mark a task blocked only when a required decision or external dependency prevents progress.
- **Determinism.** Seeds, fixtures and tests use the fixed identifiers in
  `03-blueprint.md` section 12. Never generate random test data.
- **Secrets.** Only `*.example` files are committed. Real values live in `.env` (Node dev
  server), `.dev.vars` (Wrangler), GitHub environment secrets, and Cloudflare Worker secrets.
- **Production.** No task touches production Cloudflare, Google or GitHub resources. Production
  steps are documented for the human operator and executed by workflows with manual approval.
- **Generic content only.** No customer names, no real company data, no private
  infrastructure identifiers. Example names are `Acme Services`, `Example Customer A`,
  `Example Job`, and addresses under `example.invalid`.
- **Style.** TypeScript strict. Named exports. No default exports except where the framework
  requires them (action files, Nitro plugins, React Router routes). No classes for domain
  entities; use plain objects plus pure functions. Comments explain why, not what.

## Definition of done for the whole project

Taken from the original specification, section 44. The project is finished when every line
below is true and demonstrated by task T26's report.

- Repository installs cleanly from a fresh clone with `pnpm install`.
- `pnpm dev` starts the local app; `pnpm dev:worker` starts the built Worker on local D1.
- Local databases are initialised from the committed migrations only.
- Deterministic seed data loads with `pnpm db:seed`.
- Local sign-in works with seeded users; production Google sign-in is documented.
- Organization membership and roles work; cross-organization access is blocked and tested.
- The sample Customer and Job flows work in the UI and through the agent, using the same
  actions.
- Authorization is enforced inside the application layer, not in the UI.
- Every mutation produces an audit row; at least `complete-job` is undoable; undo refuses to
  overwrite newer changes.
- Unit tests, the Worker smoke, and the hermetic Playwright suite pass locally and in GitHub
  Actions.
- Staging and production deployment workflows exist; staging smoke and production smoke exist.
- A D1 backup workflow, restore instructions and Worker rollback instructions exist.
- No secrets are committed; framework packages are pinned exactly; Renovate is configured.
- `AGENTS.md`, `ARCHITECTURE.md`, `README.md` and the `docs/*.md` set are complete.
- The repository is usable as a GitHub template without retaining upstream git history.
- MIT license present; no customer-specific information anywhere.
