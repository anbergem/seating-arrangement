# T18 — CI workflow

Goal: finish the CI workflow per B20, green on GitHub Actions. The review corrections
introduce the initial workflow; T12 adds smoke and T16 adds Playwright as soon as they exist.

Depends on: T13, T16, T17. Read: B20; D21.

## Steps

1. Extend the existing `ci.yml`: triggers `pull_request` and `push` to `main`; `concurrency` group
   `ci-${{ github.ref }}` with cancel-in-progress; job `verify` (ubuntu-latest, 20 min):
   `actions/checkout@v4`, `pnpm/action-setup@v4` (version from `packageManager`),
   `actions/setup-node@v4` with `node-version-file: .nvmrc` and `cache: pnpm`,
   `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:integration`; job `worker`
   (needs verify, 30 min): install as above, `pnpm verify:worker` (builds the bundle and proves
   it boots), `actions/upload-artifact@v4` name `worker-bundle` path `dist/` retention 7 days
   with `include-hidden-files: true` so `dist/.assetsignore` survives; job `e2e` (needs worker,
   30 min): install as above, `actions/download-artifact@v4` into `dist`,
   `pnpm exec playwright install --with-deps chromium`, `pnpm test:e2e`, upload
   `playwright-report/` on failure. No `.dev.vars` is written: `scripts/e2e-server.mjs`
   generates its own Wrangler configuration with the vars the Worker needs and disables
   Wrangler's `.dev.vars`/`.env` lookup, so the browser suite depends on no developer file.
2. No secrets are required by this workflow. Pin action versions to major tags as written.
3. Push the branch, open the PR, and iterate until both jobs are green. Paste the run URL in
   the PR body.

## Deliverables

`.github/workflows/ci.yml`.

## Acceptance

A green run of `ci.yml` on the PR (link in the PR body).
