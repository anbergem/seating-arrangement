# T23 — Documentation set

Goal: every user-facing document from B21 except those written by T21/T22, plus the final
`AGENTS.md`. Every command mentioned must exist in `package.json` or `scripts/`; verify each
by running it or `--help` before writing it down.

Depends on: T21, T22. Read: the whole plan; the original spec sections 26, 29, 30, 31, 32.

## Steps

1. `README.md` (under 250 lines) with the spec's section 32 headings: what this is; what it
   includes; quick start (`git clone`, `pnpm install`, `cp .env.example .env` + secret,
   `pnpm db:reset`, `pnpm dev`, `pnpm db:seed`, sign in as `owner@example.invalid`); a
   compact Mermaid diagram (UI/agent/MCP/HTTP → actions → use cases → domain → repositories
   → D1); the example application; authentication setup (local seeded accounts, staging QA
   accounts, production Google-only invite-only); deployment pointer; creating a new app
   ("Use this template" then `docs/bootstrap.md`); requirements and cost (Workers Paid plan,
   Anthropic key); philosophy bullets; license.
2. `ARCHITECTURE.md` with Mermaid diagrams for each item in spec section 30, concrete examples
   using `complete-job` and `undo-operation`, the two-schema-owners explanation, the parity
   table (UI click, agent request, MCP call, HTTP call, CLI call → same action → same use case),
   and the "deliberately avoided" list with one sentence each.
3. `AGENTS.md` (final): the spec section 29 content adapted to this repository: architecture
   rules with file paths; "adding a feature" checklist mapped to concrete files
   (`src/domain`, `src/application/use-cases`, `actions/`, `migrations/`, `tests/`, `app/`,
   `evals/`); the mutating action checklist; database change rules; testing expectations; agent
   safety; scope discipline; how to look up framework facts (F2); and a short "while the plan
   is active" section pointing at `docs/plan/README.md` (remove after T26 marks the plan
   complete).
4. `docs/adding-a-feature.md` (walk through adding a hypothetical `assign-job` action end to
   end, naming every file); `docs/actions-and-use-cases.md` (action anatomy, runner, error
   model with the code→status table, idempotency, action catalogue); 
   `docs/authentication-and-authorization.md` (identity vs membership vs capability, environment
   policies, Google OAuth setup with the redirect URI, adding another provider, roles table,
   QA accounts, "require Google" per organization); `docs/database-and-migrations.md` (two
   owners, migration commands per environment, expand/contract guidance, Worker rollback does
   not roll back D1, local runner, D1 jurisdiction); `docs/testing.md` (layers, commands, what
   each proves, evals vs Playwright, no-phone-home assertion); `docs/undo-and-history.md`
   (classification table, ledger vs audit trail, algorithm, conflict rule, UI behaviour);
   `docs/integrations.md` (first-class, per D26 and B22: the boundary that never moves; where
   data lives — own aggregates in D1, vendor-owned aggregates behind API-backed ports, optional
   read models synced from the vendor; the two-step write with idempotency keys; classification
   of external effects; `needsApproval` for the agent; MCP versus vendor API guidance; error
   mapping and timeouts; how to replace the mock adapter with a real one and where its
   credentials live; the walk-through of `send-job-to-accounting` as the worked example); `docs/deployment.md`
   (environments, Wrangler config, secrets, workflows, promotion, smoke, Cloudflare Access on
   staging optional, Node + libSQL fallback); `docs/runbook.md` (every item of spec section 26
   as a heading with commands); `docs/observability.md` (Workers Logs, structured action log
   line, audit vs logs vs Cloudflare logs, Sentry optional, telemetry stance);
   `docs/internationalization.md` (catalogs, guard, Norwegian status, adding a locale);
   `docs/template-workflow.md` (ownership recommendations from spec section 27, porting with
   `git format-patch`/`git am --3way`, community template registration).
5. Delete `docs/plan/notes-deployment.md` after folding it into `docs/deployment.md`.

## Deliverables

All files above.

## Acceptance

```bash
pnpm check
node -e "const fs=require('fs');for(const f of ['README.md','ARCHITECTURE.md','AGENTS.md','docs/adding-a-feature.md','docs/actions-and-use-cases.md','docs/authentication-and-authorization.md','docs/database-and-migrations.md','docs/testing.md','docs/undo-and-history.md','docs/integrations.md','docs/deployment.md','docs/backups.md','docs/runbook.md','docs/observability.md','docs/internationalization.md','docs/template-workflow.md','docs/upgrade-playbook.md','docs/repository-settings.md'])if(!fs.existsSync(f)){console.error('missing',f);process.exit(1)}"
```
plus a script run in the PR: extract every `pnpm <script>` mentioned in the docs and assert each
exists in `package.json` (write it inline in the PR body).
