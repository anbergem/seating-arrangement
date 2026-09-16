# T02 — Worker build pipeline and Wrangler configuration

Goal: `pnpm build:worker` produces a patched, size-checked Worker bundle; `pnpm dev:worker`
runs it under `wrangler dev` with local D1; `wrangler.jsonc` defines local, staging and
production.

Depends on: T01. Read: F1, F9, F10; B13, B14, B15; D02, D03, D04.

## Steps

1. `wrangler.jsonc` exactly as the B14 skeleton (keep the `$schema`, use `REPLACE_ME` ids for
   staging/production, the placeholder id for local). Add the production var
   `"AUTH_REQUIRE_EMAIL_VERIFICATION": "1"` and staging/local `"0"` (already in the skeleton
   for local/staging; add for production).
2. `scripts/build-worker.mjs`: runs `pnpm exec agent-native build` with env
   `NITRO_PRESET=cloudflare_pages`, `NODE_ENV=production` (spawn with `stdio: "inherit"`, fail
   on non-zero); then `node scripts/patch-worker-bundle.mjs`; then
   `node scripts/check-bundle-size.mjs`; then writes `dist/BUILD_INFO.json` with
   `{ sha: <git rev-parse HEAD or "unknown">, builtAt: <ISO>, coreVersion: <from node_modules/@agent-native/core/package.json> }`.
   Also writes `src/infrastructure/migrations-manifest.ts` by calling
   `node scripts/gen-migrations-manifest.mjs` **if that script exists** (it arrives in T06).
3. `scripts/patch-worker-bundle.mjs`: target `dist/_worker.js/index.js`. If
   `dist/_worker.js/PATCHED.json` exists and lists both patch ids, print `already patched` and
   exit 0. Otherwise apply the two regexes from F9 (copy them verbatim). For each: count matches;
   if not exactly 1, print `patch <id>: expected 1 match, found <n>` and exit 1. Replacement
   bodies: fs → `get(A,P){const __safe={existsSync:()=>false,readdirSync:()=>[],realpathSync:(v)=>v,mkdirSync:()=>undefined,rmSync:()=>undefined,constants:{},promises:{}};if(Object.prototype.hasOwnProperty.call(__safe,P))return __safe[P];return U("fs."+String(P2))}`
   with `A`, `P`, `U`, `P2` substituted from the capture groups; os → same shape with
   `__safe={homedir:()=>"/",tmpdir:()=>"/tmp",platform:()=>"linux",hostname:()=>"worker",EOL:"\n",cpus:()=>[],totalmem:()=>0,freemem:()=>0,release:()=>"",type:()=>"Linux",arch:()=>"x64",userInfo:()=>({username:"worker"})}`.
   Write the file, then `PATCHED.json` `{ "patches": ["fs-default-proxy","os-default-proxy"], "coreVersion": "0.176.5", "patchedAt": <ISO> }`.
   The script header comment must explain the upstream bug in three sentences and reference
   `docs/plan/upstream-issues/fs-os-default-export-stubs.md`.
4. `scripts/check-bundle-size.mjs`: gzip (`node:zlib`, level 9) every `.js`/`.mjs` under
   `dist/_worker.js/`, sum, print `worker bundle gzip total: <MiB>`; exit 1 above 8 MiB.
5. `package.json` scripts: `build:worker`, `dev:worker`, `dev:worker:serve`,
   `db:migrate:worker`, `deploy:staging`, `deploy:production` per B15.
   Extend `scripts/check-config-hygiene.mjs` (T01 did not implement this B15 rule): the literal
   `REPLACE_ME` may appear in `wrangler.jsonc` only inside the `env.staging` and
   `env.production` objects; anywhere else (top-level `vars`, `d1_databases`, scripts,
   `.env.example`, `.dev.vars.example`) is a finding. Every new script must be `oxfmt`-clean
   (`pnpm lint` formats root-level JS and JSON too).
6. `docs/plan/upstream-issues/fs-os-default-export-stubs.md`: an issue draft for
   BuilderIO/agent-native: title `cloudflare_pages worker bundle: default-import fs/os stubs throw (agent-chat init fails)`;
   body with: framework version, repro (`create chat`, build with `NITRO_PRESET=cloudflare_pages`,
   deploy `dist/` as a Worker with `main: dist/_worker.js/index.js` and a D1 binding, log lines),
   root cause (`cloudflareNodeBuiltinStubSource` overrides only named exports; default proxy
   throws; callers `loadHostedHarnessConfig` → workspace-core lookup uses `fs.existsSync`,
   mcp-client config uses `os.homedir`), proposed fix (make the proxy getter return the override
   when present), and the patch we apply. The maintainer opens the issue; do not open it.
7. Create `.dev.vars` locally (not committed) from `.dev.vars.example` with a random
   `BETTER_AUTH_SECRET`. Create an empty `migrations/` directory with a `.gitkeep`.
8. Verify end to end: `pnpm build:worker` (expect `patch fs-default-proxy: ok`, `patch
   os-default-proxy: ok`, size line, `dist/BUILD_INFO.json`), then
   `rm -rf .wrangler/state && pnpm dev:worker:serve` in the background; poll
   `http://127.0.0.1:8787/_agent-native/ping` until `{"message":"pong"}` (max 120 s); then:
   `curl -s http://127.0.0.1:8787/_agent-native/health` contains `"dialect":"d1"`;
   `curl -s -X POST -H 'content-type: application/json' -d '{"email":"t@example.invalid","password":"Example-Seed-Password-2026"}' http://127.0.0.1:8787/_agent-native/auth/register` returns `{"ok":true}`;
   login the same way with `-c cookies.txt` returns `{"ok":true}`;
   `curl -s -b cookies.txt "http://127.0.0.1:8787/_agent-native/actions/list-audit-events"` returns JSON with `events`;
   `curl -s -b cookies.txt -X POST -H 'content-type: application/json' -d '{"message":"hi"}' http://127.0.0.1:8787/_agent-native/agent-chat` returns an SSE body containing `missing_credentials`;
   `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8787/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` prints `401`.
   Stop the server. Record each output in the PR.

## Deliverables

`wrangler.jsonc`, `scripts/build-worker.mjs`, `scripts/patch-worker-bundle.mjs`,
`scripts/check-bundle-size.mjs`, `package.json`, `migrations/.gitkeep`,
`docs/plan/upstream-issues/fs-os-default-export-stubs.md`.

## Acceptance

```bash
pnpm check
pnpm build:worker
node scripts/patch-worker-bundle.mjs   # prints "already patched"
node -e "const b=require('./dist/_worker.js/PATCHED.json');if(b.patches.length!==2)process.exit(1)"
```
plus the verification transcript from step 8 in the PR body.
