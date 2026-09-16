# T01 — Toolchain, scripts, hygiene checks

Goal: the `package.json` script surface from B15 (those that can exist before application
code), lint/format configuration, the layer-boundary checker, the config-hygiene checker, and
the environment example files.

Depends on: T00. Read: B2, B13, B15; F13 (doctor guards); D16, D17.

## Steps

1. Add devDependencies (exact versions, latest at task time): `oxlint`, `oxfmt` (skip if the
   scaffold already provides them through the catalog), `vitest` (present), `tsx`.
2. `package.json` scripts, exactly these names and commands (add the rest in later tasks):
   `dev`: `agent-native dev`; `lint`: `oxlint . && oxfmt --check .`; `typecheck`:
   `agent-native typecheck`; `agent-native:doctor`: `agent-native doctor` (pnpm 11 has a built-in `doctor` subcommand that shadows a script of that name, so never use the bare `doctor` name); `check:boundaries`:
   `node scripts/check-boundaries.mjs`; `check:config`: `node scripts/check-config-hygiene.mjs`;
   `test:unit`: `vitest --run --passWithNoTests`; `check`: `pnpm lint && pnpm typecheck &&
   pnpm agent-native:doctor && pnpm check:boundaries && pnpm check:config && pnpm test:unit`; `action`:
   `agent-native action`. Remove the scaffold's `script` alias and `migrate:production`.
3. `.oxlintrc.json`: enable the `correctness` category as errors, ignore `dist`, `.output`,
   `.wrangler`, `node_modules`, `.react-router`, `.generated`, `build`, `data`. `.oxfmtrc.json`:
   keep the scaffold's file; add an `ignore` list with the same directories if the format
   supports it (check `oxfmt --help`).
4. `scripts/check-boundaries.mjs` (ESM, Node 22, no dependencies): walk `src/`, `actions/`,
   `app/` recursively for `.ts`/`.tsx` files; for each file determine its layer from B2; extract
   specifiers from `import ... from "<spec>"`, `export ... from "<spec>"`, and `import("<spec>")`
   (regex; ignore type-only imports? No: type-only imports count, except that `app/` may import
   types from `src/domain`); resolve relative specifiers to repository paths; apply the B2
   table; print `path:line forbidden import "<spec>" (<layer> may not import <target>)` per
   violation; exit 1 if any. Create an empty `src/domain/.gitkeep` so the script has a
   directory to walk; the script must succeed when directories are missing.
5. `scripts/check-config-hygiene.mjs`: fail (exit 1, one line per finding) when: any of
   `VITE_AGENT_NATIVE_ANALYTICS_PUBLIC_KEY`, `VITE_AGENT_NATIVE_ANALYTICS_ENDPOINT`,
   `BUILDER_PRIVATE_KEY`, `BUILDER_PUBLIC_KEY`, `SENTRY_DSN`, `ACCESS_TOKEN`, `ACCESS_TOKENS`,
   `AUTH_DISABLED`, `AGENT_PROD_CODE_EXECUTION` appears as a key in `.env.example`,
   `.dev.vars.example`, `wrangler.jsonc` `vars` (any environment) or `agent-native.config.ts`;
   any of `BETTER_AUTH_SECRET`, `OAUTH_STATE_SECRET`, `GOOGLE_SIGN_IN_CLIENT_SECRET`,
   `ANTHROPIC_API_KEY`, `SEED_PASSWORD` appears as a key inside `wrangler.jsonc` `vars`; `.env`
   or `.dev.vars` is not ignored (`git check-ignore -q .env .dev.vars`); any line in
   `.env.example`/`.dev.vars.example` has a non-empty value after `=` other than the documented
   local defaults listed in step 6. Skip `wrangler.jsonc` checks when the file does not exist
   yet. Parse `wrangler.jsonc` by stripping `//` and `/* */` comments before `JSON.parse`.
6. `.env.example` (Node dev server) with exactly these lines, comments allowed:
   `APP_ENV=local`, `DATABASE_URL=file:./data/app.db`, `APP_URL=http://localhost:8080`,
   `BETTER_AUTH_SECRET=` (comment: 32+ chars, `openssl rand -hex 32`), `AUTO_CREATE_DEFAULT_ORG=0`,
   `AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT=1`, `AUTH_REQUIRE_EMAIL_VERIFICATION=0`,
   `SEED_ENABLED=1`, `SEED_PASSWORD=Example-Seed-Password-2026`, `ANTHROPIC_API_KEY=` (optional).
   `.dev.vars.example` (Wrangler local) with: `BETTER_AUTH_SECRET=`, `SEED_PASSWORD=Example-Seed-Password-2026`,
   `ANTHROPIC_API_KEY=` and a comment that non-secret vars live in `wrangler.jsonc`.
7. `vitest.config.ts`: keep the scaffold's aliases; set `test.include` to
   `["tests/unit/**/*.test.ts", "src/**/*.test.ts"]`.
8. `tsconfig.json`: ensure `include` covers `src`, `tests`, `scripts`, `actions`, `app`,
   `server`, `evals`; `strict: true`; `noUncheckedIndexedAccess: true`.
9. Run `pnpm lint` and fix scaffold formatting only by running `oxfmt --write .` once (commit
   the result separately in the same PR).

## Deliverables

`package.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `scripts/check-boundaries.mjs`,
`scripts/check-config-hygiene.mjs`, `.env.example`, `.dev.vars.example`, `vitest.config.ts`,
`tsconfig.json`, `src/domain/.gitkeep`.

## Acceptance

```bash
pnpm check
node scripts/check-boundaries.mjs      # prints "boundaries ok"
node scripts/check-config-hygiene.mjs  # prints "config hygiene ok"
```
