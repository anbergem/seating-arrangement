# T00 — Scaffold and repository baseline

Goal: turn the empty repository into a pinned, installable Agent-Native app scaffold with the
template parts we do not want removed, without adding any application code yet.

Depends on: nothing. Read: `docs/plan/README.md`; facts F1, F2, F3; blueprint B1; decisions D01.

## Steps

1. Verify prerequisites: `node -v` prints 22.x or newer (22.22 minimum), `pnpm -v` prints 11.x,
   `git status` is clean, current branch is `task/T00-scaffold` created from `main`.
2. In a directory **outside** the repository (for example `/tmp/an-scaffold`), run:
   `CI=1 npx @agent-native/core@0.176.5 create example-jobs --standalone --template chat --yes`.
   Verify `example-jobs/package.json` exists and its `dependencies["@agent-native/core"]` is
   `0.176.5`. If the CLI prompts interactively, record a discrepancy and try
   `--template chat --standalone` without `--yes` under `CI=1` with stdin closed (`< /dev/null`).
3. Copy the scaffold into the repository root with `rsync -a`, excluding: `.git/`, `CLAUDE.md`,
   `netlify.toml`, `changelog/`, `learnings.md`, `learnings.defaults.md`, `DESIGN.md`,
   `scripts/migrate-production.ts`, `app/routes/database.tsx`, `app/routes/extensions.tsx`,
   `app/routes/extensions._index.tsx`, `app/routes/extensions.$id.tsx`,
   `app/routes/extensions.$id.$slug.tsx`, `README.md`, `AGENTS.md`, `DEVELOPING.md`,
   `pnpm-lock.yaml` (if present). Then copy the scaffold's `README.md`, `AGENTS.md` and
   `DEVELOPING.md` into `docs/plan/scaffold-reference/` with the same names (reference only; do
   not edit them). Do not overwrite the repository's `LICENSE`, `AGENTS.md` or `docs/`.
4. Under `.agents/skills/`, delete every directory except `actions`, `agent-native-docs`,
   `security`, `storing-data`.
5. Edit `package.json`: `"name": "agent-native-cloudflare-starter"`, `"version": "0.1.0"`,
   `"private": true`, `"license": "MIT"`, `"packageManager": "pnpm@<exact output of pnpm -v>"`,
   `"engines": { "node": ">=22.22.0" }`; set `"@agent-native/core": "0.176.5"` and
   `"@agent-native/toolkit": "0.19.3"` (no caret). Leave every other dependency as scaffolded.
   Add devDependencies `"wrangler": "4.129.0"` and `"@playwright/test": "<exact latest>"` (find
   with `npm view @playwright/test version`).
6. Edit `pnpm-workspace.yaml`: replace the line `workerd: set this to true or false` with
   `workerd: true`. Leave the rest untouched.
7. Create `.nvmrc` containing `22`.
8. Ensure `.gitignore` contains these lines (add missing ones): `.dev.vars`, `.dev.vars.*`,
   `!.dev.vars.example`, `.wrangler/`, `dist/`, `data/`, `tests/e2e/.auth/`, `test-results/`,
   `playwright-report/`, `.env`, `.env.*`, `!.env.example`, `.output/`.
9. Run `pnpm install`. Commit the generated `pnpm-lock.yaml`.
10. Verify the dev server boots: run `pnpm dev` in the background, poll
    `curl -s http://localhost:8080/_agent-native/ping` until it returns `{"message":"pong"}`
    (at most 90 s), then stop it. Delete `data/` afterwards.
11. Create `.oxlintrc.json` only if the scaffold did not; leave lint configuration for T01.

## Deliverables

All scaffold files as described, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
`.nvmrc`, `.gitignore`, `docs/plan/scaffold-reference/{README.md,AGENTS.md,DEVELOPING.md}`.

## Acceptance

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm agent-native:doctor
node -e "const p=require('./package.json');if(p.dependencies['@agent-native/core']!=='0.176.5')process.exit(1)"
node -e "const p=require('./package.json');if(p.dependencies['@agent-native/toolkit']!=='0.19.3')process.exit(1)"
test ! -e CLAUDE.md && test ! -e netlify.toml && test ! -e app/routes/database.tsx
git ls-files | grep -E '^\.env$|^\.dev\.vars$' ; test $? -eq 1
```

Out of scope: any application code, wrangler configuration, scripts beyond the scaffold.
