# T22 — Renovate, upgrade playbook, repository settings

Goal: dependency automation configuration, the framework upgrade playbook, and the recommended
GitHub repository settings document.

Depends on: T18. Read: F1, F16; D01, D22.

## Steps

1. `renovate.json`: `extends: ["config:recommended"]`, `dependencyDashboard: true`,
   `schedule: ["before 6am on monday"]`, `rangeStrategy: "pin"`, `packageRules`:
   (a) `matchPackagePatterns: ["^@agent-native/"]`, `groupName: "agent-native framework"`,
   `automerge: false`, `minimumReleaseAge: "3 days"`, labels `["framework-upgrade"]`;
   (b) `matchPackageNames: ["wrangler"]`, `groupName: "wrangler"`, `automerge: false`;
   (c) `matchUpdateTypes: ["minor", "patch"]`, `groupName: "minor and patch"`, `automerge: false`;
   (d) `matchManagers: ["github-actions"]`, `groupName: "github actions"`.
2. `docs/upgrade-playbook.md`: numbered procedure: read the framework release notes; update
   the two pins; `pnpm install`; `pnpm exec agent-native doctor --only migration-manifest`;
   `pnpm check`; `pnpm build:worker` (the patch script is the first thing that breaks on a
   changed bundle: what to do when it reports 0 or >1 matches — re-derive the regex from
   `dist/_worker.js/index.js` by searching `"fs."+String(` and `"os."+String(`, or delete the
   patch if upstream fixed the stubs and `pnpm smoke` passes without it); `pnpm test:integration`;
   `pnpm test:e2e:full`; re-verify every fact in `docs/plan/02-framework-facts.md` marked with
   the version (list the sections most likely to change: F5, F9, F12, F14); update the facts
   file; merge; watch the staging smoke.
3. `docs/repository-settings.md`: branch protection for `main` (require PR, require `CI /
   verify` and `CI / worker`, no force push, no direct push, linear history optional),
   environments `staging` (secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `SEED_PASSWORD`; variable `STAGING_URL`) and `production` (same secrets minus
   `SEED_PASSWORD`, plus backup secrets; variable `PRODUCTION_URL`; required reviewers),
   template repository flag, Renovate app installation, Actions permissions (read-only
   `GITHUB_TOKEN` by default), and why framework upgrades are never automerged (two sentences).

## Deliverables

`renovate.json`, `docs/upgrade-playbook.md`, `docs/repository-settings.md`.

## Acceptance

```bash
pnpm check
npx --yes renovate-config-validator renovate.json
```
