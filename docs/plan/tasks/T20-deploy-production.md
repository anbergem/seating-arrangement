# T20 — Production deployment workflow

Goal: `.github/workflows/deploy-production.yml` implementing artifact promotion, Time Travel
bookmark, migrations, deploy, and the read-only production smoke.

Depends on: T19. Read: F10; B19, B20; D21.

## Steps

1. Write `deploy-production.yml`: `workflow_dispatch` with inputs `staging_run_id` (required,
   string) and `confirm` (required, string, must equal `deploy`); job `promote` with
   `environment: production` (required reviewers are configured by the maintainer), permissions
   `contents: read, actions: read`; steps: verify `inputs.confirm == 'deploy'`; validate `staging_run_id` as digits; query
   that run through the GitHub API and require workflow path `deploy-staging.yml`, head branch
   `main`, this repository, status `completed`, and conclusion `success`. Resolve the deployed
   SHA from that run's `deployment-manifest` artifact, which T19 writes, rather than from the
   workflow-run `head_sha`, which can describe the workflow's default-branch context instead of
   the deployed commit; re-validate that the manifest names this repository and a completed,
   successful `ci.yml` run for that exact SHA. Checkout that SHA (including migrations, lockfile
   and Wrangler config);
   pnpm/node setup; install (needed for wrangler); download the artifact:
   `gh run download "$STAGING_RUN_ID" --name worker-bundle-<sha> --dir dist` where `<sha>` is the
   manifest SHA;
   verify that `dist/BUILD_INFO.json`'s `sha` equals that sha and equals the checked-out commit
   (`git rev-parse HEAD`), and that `dist/_worker.js/PATCHED.json` matches the SHA-256 of the
   downloaded `dist/_worker.js/index.js`, else fail; record
   `pnpm exec wrangler d1 time-travel info example-jobs-production --env production --json`
   into `$GITHUB_STEP_SUMMARY`; `pnpm db:migrate:production`; `pnpm deploy:production`;
   `node scripts/worker-smoke.mjs --base-url ${{ vars.PRODUCTION_URL }} --mode production`;
   on failure append to the summary: the bookmark, the previous deployment id from
   `wrangler deployments list --env production`, and the rollback command
   `wrangler rollback --env production`.
2. Ensure `pnpm deploy:production` does not rebuild: `wrangler deploy` uses `dist/` as
   downloaded; add a guard step that fails if `dist/_worker.js/PATCHED.json` is missing.
3. Serialize production deployments with a non-cancelling environment concurrency group.
   Pass workflow inputs through environment variables/structured arguments, never interpolate
   unchecked inputs into shell code. Test rejection of failed or unrelated staging runs.
4. Validate with `actionlint` and a dry run as in T19.

## Deliverables

`.github/workflows/deploy-production.yml`.

## Acceptance

```bash
pnpm check
pnpm lint:workflows
```
plus the dry-run transcript.
