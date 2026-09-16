# T19 — Staging deployment workflow

Goal: `.github/workflows/deploy-staging.yml` per B20 plus the staging smoke and QA seed reset.
The workflow is written and validated by dry run; the maintainer performs the first real run
after bootstrap (T24).

Depends on: T18. Read: F10; B13, B19, B20; D11, D21.

## Steps

1. Write `deploy-staging.yml`: trigger `workflow_run` on workflow `CI` (types `completed`,
   branches `main`) guarded by `if: github.event.workflow_run.conclusion == 'success'`, plus
   `workflow_dispatch`; job `deploy` with `environment: staging`, `permissions: { contents: read,
   actions: read }`; steps: checkout at `${{ github.event.workflow_run.head_sha || github.sha }}`,
   pnpm/node setup, validate that this exact SHA has a completed, successful `ci.yml` run of this
   repository on `main` (a manual dispatch looks the run up by `head_sha`), write the immutable
   `deployment-manifest` artifact `{ repository, sha, sourceCiRunId }` that T20 promotes from,
   `pnpm install --frozen-lockfile`, `pnpm build:worker`, upload artifact
   `worker-bundle-${{ <sha> }}` with `retention-days: 90`, `pnpm db:migrate:staging`,
   `pnpm deploy:staging`, seed reset
   `node scripts/seed.mjs --target d1-remote --env staging --reset --base-url ${{ vars.STAGING_URL }}`,
   smoke `node scripts/worker-smoke.mjs --base-url ${{ vars.STAGING_URL }} --mode staging --qa-email owner@example.invalid --qa-password "${{ secrets.SEED_PASSWORD }}" --expect-org-id org_acme`.
   Environment for Wrangler steps: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` from
   secrets; `SEED_PASSWORD` from secrets; `STAGING_URL` from environment variables. Append the
   deployed sha and the smoke result to `$GITHUB_STEP_SUMMARY`.
2. Validate without cloud access: `pnpm lint:workflows` passes; `pnpm build:worker && pnpm
   exec wrangler deploy --env staging --dry-run --outdir /tmp/wrangler-dry` succeeds (if the
   dry run rejects the `REPLACE_ME` ids, use a temporary copy of the config with dummy UUIDs
   and say so in the PR).
3. Add `docs/plan/notes-deployment.md` (bullets only; folded into `docs/deployment.md` and
   deleted by T23 — done 2026-09-08): required secrets and variables per environment (`CLOUDFLARE_API_TOKEN` with
   permissions Workers Scripts:Edit, D1:Edit, Workers Routes:Edit; `CLOUDFLARE_ACCOUNT_ID`;
   `SEED_PASSWORD`; variable `STAGING_URL`).

## Deliverables

`.github/workflows/deploy-staging.yml`, `docs/plan/notes-deployment.md`.

## Acceptance

```bash
pnpm check
pnpm lint:workflows
```
plus the dry-run transcript.
