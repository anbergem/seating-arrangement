# Verified framework facts (Agent-Native 0.176.5)

Everything here was verified on 2026-09-05/06 by installing the packages, reading the bundled
docs and type definitions, scaffolding the `chat` template, building it for Cloudflare and
running it under `wrangler dev` with a local D1 binding. Re-verify on every framework upgrade
(see T22). Section numbers are referenced from task files as `F<n>`.

## F1. Versions and tools

| Item | Value |
| --- | --- |
| `@agent-native/core` | `0.176.5` (exact) |
| `@agent-native/toolkit` | `0.19.3` (exact) |
| `wrangler` | `4.129.0` (exact) |
| Node | 22 LTS in CI (`.nvmrc` = `22`); framework requires `>=22.22.0` |
| pnpm | 11.x (`packageManager` field pins the exact version present on the maintainer's machine, `pnpm --version`) |
| Zod | `zod` 4.x (already a template dependency) |
| Tests | `vitest` (template), `@playwright/test` (add, pin exact latest at task time) |

pnpm 11 specifics:
- Postinstall scripts are blocked unless allowed in `pnpm-workspace.yaml` under `allowBuilds`.
  The chat scaffold lists `tesseract.js`, `node-pty`, `esbuild`, `better-sqlite3`; add
  `workerd: true` (needed by wrangler). Verified in T00: no other package needed approval.
- `minimumReleaseAge` policy (24 h) is active by default and the framework's build runs
  `pnpm install` as a preflight, so a package published today fails the build. Keep the policy;
  it is the supply-chain guard.
- `CI=1` makes `pnpm install` frozen-lockfile.

## F2. Where the framework documents itself

- Version-matched docs: `node_modules/@agent-native/core/docs/content/*.mdx`.
- First-party template sources: `node_modules/@agent-native/core/corpus/templates/<name>/`.
- Compiled source and types: `node_modules/@agent-native/core/dist/**`.
- From an app root: `pnpm action docs-search --slug <slug>` and
  `pnpm action source-search --query "<text>"`; or `rg` over the paths above.
- Useful slugs: `actions-defining`, `actions-run-context`, `actions-access-control`,
  `audit-log`, `authentication`, `organizations-teams-permissions`, `multi-tenancy`,
  `server-database`, `cloudflare`, `cloudflare-d1`, `doctor`, `evals`, `internationalization`,
  `deployment-environment-variables`, `security`, `observability`, `tracking`.

## F3. Scaffolding

Non-interactive scaffold of the minimal template (verified):

```bash
CI=1 npx @agent-native/core@0.176.5 create <dir> --standalone --template chat --yes
```

It writes the app into `<dir>` (creates a git repo inside it; delete that `.git`). It does not
install dependencies. Generated files of interest: `package.json`, `pnpm-workspace.yaml`
(with `allowBuilds`, `overrides`, `minimumReleaseAgeExclude`), `agent-native.config.ts`,
`agent-native.json`, `vite.config.ts`, `react-router.config.ts`, `vitest.config.ts`,
`tsconfig.json`, `ssr-entry.ts`, `actions/{hello,navigate,run,view-screen}.ts`,
`app/` (routes, components, i18n), `server/{middleware/auth.ts,plugins/auth.ts,
plugins/agent-chat.ts,plugins/agent-native-email-branding.ts,routes/[...page].get.ts}`,
`scripts/migrate-production.ts`, `.agents/skills/**`, `AGENTS.md`, `CLAUDE.md -> AGENTS.md`,
`DEVELOPING.md`, `DESIGN.md`, `netlify.toml`, `learnings*.md`, `changelog/`.

Scaffold `package.json` scripts: `dev` = `agent-native dev --open`, `build` = `agent-native
build`, `typecheck` = `agent-native typecheck`, `action` = `agent-native action`,
`doctor` = `agent-native doctor`, `test` = `vitest --run --passWithNoTests`.

## F4. Import paths for symbols this plan uses

| Import path | Symbols |
| --- | --- |
| `@agent-native/core/action` | `defineAction`, `fail`, `ActionContractError`, `isActionContractError`, types `ActionRunContext`, `ActionCaller` |
| `@agent-native/core/db` | `getDbExec`, `createGetDb`, `getDialect`, `isPostgres` |
| `@agent-native/core/db/schema` | `table`, `text`, `integer`, `real`, `now` |
| `@agent-native/core/server` | `createAuthPlugin`, `createAgentChatPlugin`, `loadActionsFromStaticRegistry`, `defineAppConfig`, `runWithRequestContext`, `getRequestContext`, `runAuthGuard` |
| `@agent-native/core/org` | `createOrganization`, `isOrgMember`, `orgRoleAtLeast`, `getOrgContext`, `queryOrgMembers`, tables `organizations`, `orgMembers`, type `OrgRole` |
| `@agent-native/core/client/hooks` | `useActionQuery`, `useActionMutation`, `callAction`, `actionErrorMessage`, `useSession`, `AppProviders`, `useDbSync` |
| `@agent-native/core/client/org` (also exported as `.../client/org-team`; the scaffold uses the shorter path and so does this app) | `OrgSwitcher`, `TeamPage`, `useOrgRole` (`{ canManageOrg, ... }`), `RequireActiveOrg` |
| `@agent-native/core/client/i18n` | `createAgentNativeI18nCatalog`, `useT`, `useFormatters`, `LanguagePicker`, `getLocaleInitScript`, type `LocaleCode` |
| `@agent-native/core/client/agent-chat` | agent chat helpers (the scaffold's `Layout` already renders the sidebar; keep it) |
| `@agent-native/core/eval` | `defineEval`, `usesTool`, `contains`, `createScorer` |
| `@agent-native/core/config` | `defineAgentNativeConfig` |

## F5. `defineAction` contract

Verified option names: `description` (required), `schema` (Zod object, required), `outputSchema`,
`run(args, ctx?)`, `http` (`{ method?: "GET"|"POST"|"PUT"|"DELETE", path?: string } | false`),
`agentTool` (default true), `mcpTool` (default = `agentTool`), `readOnly`, `toolCallable`,
`publicAgent`, `chatUI`, `needsApproval`, `authorize`, `audit`.

Semantics that matter:
- The action name is the file name without extension: `actions/complete-job.ts` is
  `complete-job` on every surface (agent tool, `POST /_agent-native/actions/complete-job`,
  MCP tool, `pnpm action complete-job`).
- `http: { method: "GET" }` marks a read action; GET actions are callable with query
  parameters and are **not** audited. Mutating actions default to POST and are audited.
- Files whose name starts with `_` and files named `helpers`, `run`, `registry`, `_utils`,
  `db-connect`, `db-status` are skipped by discovery. Subdirectories are not scanned.
  `actions/run.ts` is the framework's CLI dispatcher (`pnpm action` loads it); it is not an
  action and must never be deleted (T08 restored it after T03 removed it).
- Wrapper order: validate input, `authorize`, `run`, validate output, audit.
- `audit`: `{ target?: (args, result) => { type, id, ownerEmail?, visibility? }, summary?: (args, result) => string, onRead?: boolean, enabled?: boolean, recordInputs?: boolean }`.
- Errors: `fail(message, { errorCode?, statusCode?, details? })` throws an
  `ActionContractError` whose message, `errorCode` and `details` are returned to every caller and
  whose `statusCode` becomes the HTTP status. A plain `throw new Error()` becomes a generic
  HTTP 500 with the message withheld. Zod validation failures become HTTP 400 with message
  starting `Invalid action parameters`.
- `ctx` (`ActionRunContext`): `userEmail?: string`, `orgId: string | null`, `caller:
  "tool"|"http"|"frontend"|"cli"|"mcp"|"webmcp"|"a2a"|"automation"`, `actionName?`,
  `threadId?`, `runId?`, `turnId?`, `send?`, `signal?`, `attachments?`, `automation?`.
  `userEmail` is never defaulted to a dev identity.
- Client: `useActionQuery("name", args)` for GET actions, `useActionMutation("name")` for
  mutations, `callAction("name", args)` imperative. Browser calls carry the
  `X-Agent-Native-Frontend: 1` header so `ctx.caller === "frontend"`.

## F6. Identity, sessions, organizations

- Session cookie name in production/local standalone: `an_session` (HttpOnly, SameSite=Lax);
  companion `an_session_hint`.
- Endpoints (all JSON): `POST /_agent-native/auth/register` `{ email, password }` → `{ ok: true }`;
  `POST /_agent-native/auth/login` `{ email, password }` → `{ ok: true }` + cookies;
  `POST /_agent-native/auth/logout`; `GET /_agent-native/auth/session`;
  `GET /_agent-native/org/me` → `{ email, orgId, orgName, role, orgs: [...], ... }`.
  Password minimum length exists (register returns 400 below it); use 16+ character seed
  passwords. Registering an existing email returns HTTP 409. GET actions reject POST with
  HTTP 405 `Method not allowed. Use GET.`
- Unauthenticated action call returns HTTP 401.
- Organization tables (framework-owned, SQLite dialect):
  `organizations(id TEXT PK, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, allowed_domain TEXT, a2a_secret TEXT, workspace_url TEXT, required_auth_provider TEXT, ...)`
  and `org_members(id TEXT PK, org_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL, UNIQUE(org_id, email))` plus a unique index on `(org_id, LOWER(email))`.
  Before inserting seed rows, read `node_modules/@agent-native/core/dist/org/migrations.js`
  and include every NOT NULL column. `created_at` and `joined_at` are epoch milliseconds.
- Roles: exactly `owner`, `admin`, `member`. Helper `orgRoleAtLeast(role, "admin")`.
- Active organization: the user's `active-org-id` setting, else the first membership. With one
  membership per user the membership is the active org.
- `AUTO_CREATE_DEFAULT_ORG=0` stops the framework from creating a personal organization for a
  user with no membership.
- Role lookup inside an action: there is no role on `ctx`. Query
  `SELECT role FROM org_members WHERE org_id = ? AND LOWER(email) = LOWER(?)` through
  `getDbExec()`. `getOrgContext(event)` needs an H3 event and is only usable in routes/plugins.
- CLI identity: `AGENT_USER_EMAIL` and `AGENT_ORG_ID` environment variables are honoured only
  when no request context exists (`pnpm action <name>`), never for HTTP requests.

## F7. Authentication configuration

- Google: `GOOGLE_SIGN_IN_CLIENT_ID`, `GOOGLE_SIGN_IN_CLIENT_SECRET` (identity scopes only).
  Redirect URI is `<APP_URL>/_agent-native/google/callback` (corrected in T23/T24; the earlier
  `/_agent-native/auth/ba/callback/google` is Better Auth's own social callback, which the
  sign-in page never uses). With the two credentials set, `createAuthPlugin` mounts
  `/_agent-native/google/auth-url` and `/_agent-native/google/callback`
  (`dist/server/auth.js:3485`), the sign-in page's Google button calls the first
  (`GOOGLE_AUTH_URL_PATH` in `dist/client/auth/AuthPage.js:14`), and it builds `redirect_uri`
  from `resolveOAuthRedirectUri`'s default path (`dist/server/google-oauth.js:292`). Verify
  against a running build rather than from source: `curl -s
  http://localhost:8080/_agent-native/google/auth-url` returns the authorization URL with the
  `redirect_uri` in it. Recorded in `docs/authentication-and-authorization.md`. Set
  `OAUTH_STATE_SECRET` (32+ chars) in production; the framework falls back to
  `BETTER_AUTH_SECRET` and throws in production if neither is set.
- `BETTER_AUTH_SECRET` (32+ chars) is hard-required in production.
- `APP_URL` is the canonical public origin; set it explicitly on every hosted environment.
- Password sign-up policy: the deployment alias `AUTH_REQUIRE_EMAIL_VERIFICATION` declares
  the policy (`1`/`0`); the framework treats it like `defineAppConfig({ auth: {
  requireEmailVerification } })`. With `1` and **no email provider configured**, password
  sign-up is disabled; that is the production setting (Worker var). With `0` (local, CI,
  staging) password sign-up works without verification. Verified in the spike: register/login
  worked on a Worker with `NODE_ENV=production` and no provider.
- `AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT=1` disables the localhost "Continue as local dev"
  button; we set it so local development uses seeded users. The button markup and its i18n
  string are still present in the HTML (hidden); verify behaviour via
  `GET /_agent-native/auth/local-dev` → `{"available":false}`, never by grepping the page.
- `createAuthPlugin({ rootAuth: false })` is required so the app's `/` route renders; the
  default `rootAuth: true` serves the sign-in document at `/` for every visitor (T03).
- On the deployed Worker `/` is answered by the static asset `dist/index.html`, so any redirect
  from `/` is client-side (`<Navigate to="/jobs" replace />`); a loader `redirect()` at `/`
  breaks the framework's static-shell render.
- Organization-level "require Google": `setRequiredAuthProvider(orgId, "google")` from
  `@agent-native/core/org`; exposed in the framework Team page; when set, password login for
  members of that organization is refused with HTTP 403.
- `ACCESS_TOKEN`/`ACCESS_TOKENS` are static MCP bearer tokens, never browser auth. Not used.

## F8. Database access

- `getDbExec()` returns `{ execute({ sql, args }) → { rows, rowsAffected }, transaction?(fn),
  atomicBatch?(statements) }`. On D1: `atomicBatch` present, `transaction` absent. On the local
  file (better-sqlite3) and libsql: `transaction` present (BEGIN IMMEDIATE), `atomicBatch`
  absent. Placeholders are `?`. Caveat (T07): the returned object is a lazy proxy that advertises
  both methods until the first query has run; calling `atomicBatch` on the local runtime throws
  "This database does not support atomic batches". Run one `SELECT 1` first, then inspect.
  Rows are plain objects on every runtime.
- Dialect detection: `DATABASE_URL` wins; unset plus `globalThis.__cf_env.DB` present → `d1`;
  otherwise local SQLite at `file:./data/app.db`.
- `createGetDb(schema)` from `server/db/index.ts` gives a typed Drizzle client; we keep it for
  the framework but repositories use `getDbExec()` (D01/D07).
- D1: `PRAGMA foreign_keys` is on; no interactive transactions; `batch()` is atomic.
- Framework tables are created by the framework at first database touch through its own
  migration runners (`_better_auth_migrations`, `_org_migrations`, ...). The Node dev server
  (`pnpm dev`) does this at boot; `wrangler dev` and the deployed Worker do it during the first
  request that touches the database (`GET /_agent-native/health` is enough); it takes a few
  seconds once. Consequence (T11): scenario SQL that inserts into `organizations`/`org_members`
  can only run after the app has touched the database; a freshly migrated D1 has no such tables.
  Hermetic tests that never start a server must create those two tables themselves with the
  framework DDL from F6.

## F9. Cloudflare build and runtime

Verified working configuration (spike, 2026-09-05):

```bash
NITRO_PRESET=cloudflare_pages NODE_ENV=production pnpm exec agent-native build
# output: dist/ (static assets + dist/_worker.js/index.js + dist/_worker.js/chunks + stubs)
```

```jsonc
// wrangler config that booted
{
  "name": "example-jobs",
  "compatibility_date": "2026-09-05",
  "compatibility_flags": ["nodejs_compat"],
  "main": "dist/_worker.js/index.js",
  "assets": { "directory": "dist", "binding": "ASSETS" },
  "d1_databases": [{ "binding": "DB", "database_name": "example-jobs-local", "database_id": "00000000-0000-0000-0000-000000000000" }],
  "vars": { "NODE_ENV": "production", "APP_URL": "http://127.0.0.1:8787" }
}
```

- `NODE_ENV=production` must be present as a Worker var; the framework reads it at runtime.
- The `cloudflare_module` Nitro preset output does **not** boot (module-scope `setInterval`,
  then `createRequire(undefined)`), on stable and nightly. Do not use it.
- Bundle: ~13.4 MB raw, ~4.05 MB gzip for the bare template. Workers Free limit 3 MB
  compressed, Paid 10 MB.
- Two runtime bugs in the single-file bundle, both in the bundler's Node built-in stubs
  (`packages/core/src/deploy/build.ts`, `cloudflareNodeBuiltinStubSource`): the default export
  proxy of `fs` and `os` throws for every property, while safe overrides exist only as named
  exports. Symptoms: `[agent-chat] Plugin init failed — registering error fallback:
  fs.existsSync is unavailable in Cloudflare Pages workers` (audit and MCP routes then 404, agent
  chat 503) and `os.homedir is unavailable in Cloudflare Pages workers` on agent chat.
- Verified patch (applied to `dist/_worker.js/index.js`), regexes over the minified text:

```js
// fs default-export proxy getter
/get\(([\w$]+),([\w$]+)\)\{return ([\w$]+)\("fs\."\+String\(([\w$]+)\)\)\}/
// replace with:
// get(A,P){const __safe={existsSync:()=>false,readdirSync:()=>[],realpathSync:(v)=>v,mkdirSync:()=>undefined,rmSync:()=>undefined,constants:{},promises:{}};if(Object.prototype.hasOwnProperty.call(__safe,P))return __safe[P];return U("fs."+String(P2))}
// os default-export proxy getter
/get\(([\w$]+),([\w$]+)\)\{return ([\w$]+)\("os\."\+String\(([\w$]+)\)\)\}/
// replace with the same shape and __safe={homedir:()=>"/",tmpdir:()=>"/tmp",platform:()=>"linux",hostname:()=>"worker",EOL:"\n",cpus:()=>[],totalmem:()=>0,freemem:()=>0,release:()=>"",type:()=>"Linux",arch:()=>"x64",userInfo:()=>({username:"worker"})}
```

  Each regex matched exactly once in the verified build. After the patch: ping, health, register,
  login, org/me, app action, `list-audit-events`, MCP (`POST /mcp` → 401 with
  `WWW-Authenticate` challenge) and agent chat (SSE with `missing_credentials` error when no
  provider key) all worked.
- A response held open with no pending I/O does not survive: the runtime answers
  `Uncaught Error: The Workers runtime canceled this request because it detected that your
  Worker's code had hung and would never generate a response`, and under `wrangler dev` 4.129.0
  that cancellation reaches `ProxyController.emitErrorEvent` and **kills the dev server**. The
  framework's `/_agent-native/events` sync stream (`createEventStream(event).send()`) is exactly
  that shape, so the app passes `sseUrl: false` to `useDbSync` and relies on
  `/_agent-native/poll` (T14/T16). Streams that produce data and finish, such as
  `POST /_agent-native/agent-chat`, are unaffected.
- Framework endpoints for smoke tests: `GET /_agent-native/ping` → `{"message":"pong"}`;
  `GET /_agent-native/health` → JSON with `ok`, `ready`, `db: true`, `database.dialect: "d1"`.
- Static assets are served by the `ASSETS` binding for GET/HEAD when a file exists; everything
  else reaches the Worker.
- Wrangler config: `vars` and `d1_databases` are **not** inherited by environments and must be
  repeated under `env.staging` and `env.production`; `name`, `main`, `assets`,
  `compatibility_*`, `observability` are inherited but `name` should be set per environment.
  `observability: { "enabled": true, "head_sampling_rate": 1 }` enables Workers Logs.

## F10. Wrangler commands (4.129.0)

```bash
wrangler d1 create <name> --jurisdiction eu        # EU jurisdiction; location hint ignored
                                                   # no --json: read the new uuid from `d1 list --json`
wrangler d1 migrations create <name> <message>     # creates migrations/NNNN_message.sql
wrangler d1 migrations list <name> [--local|--remote] [--env <env>]
wrangler d1 migrations apply <name> [--local|--remote] [--env <env>]
wrangler d1 execute <name> [--local|--remote] --file <sql> | --command "<sql>"
wrangler d1 export <name> --remote --output <file.sql> [--no-schema|--no-data|--table t]
wrangler d1 time-travel info <name> [--env <env>] [--json]
wrangler d1 time-travel restore <name> --timestamp <iso> | --bookmark <id>
wrangler deploy --env <env>
wrangler deployments list --env <env>
wrangler rollback [version-id] --env <env>
wrangler secret put <NAME> --env <env>
wrangler dev --port 8787 --ip 127.0.0.1 --local            # reads .dev.vars
wrangler r2 bucket create <name> --jurisdiction eu
```

Local D1 state lives under `.wrangler/state/v3/d1/`. Deleting `.wrangler/state` resets it.

Process management (verified T02): `wrangler dev` runs as `node .../wrangler.js dev ...` plus a
`workerd` child; `pkill -f "wrangler dev"` does not match. Stop it with
`pkill -f "wrangler.js dev"` (kill the wrangler process, not only workerd, or it respawns).
First boot after `rm -rf .wrangler/state` answers `ping` within seconds; the framework's own
table creation runs during the first request that touches the database. `.dev.vars` is created
locally with `sed -e "s|^BETTER_AUTH_SECRET=$|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" .dev.vars.example > .dev.vars`.
Under `wrangler dev` the health endpoint reports `auth.hostMismatch: true` (`localhost` vs
`127.0.0.1`); harmless locally.
Local D1 `database_id` can be any placeholder; `wrangler d1 migrations apply <name> --local`
keys the local database by `database_name`.

## F11. Audit log

- Table `agent_audit_log` (framework-owned): `id, created_at, action, caller
  (tool|frontend|http|cli|mcp|a2a), actor_kind (agent|human|system), actor_email, org_id,
  thread_id, turn_id, target_type, target_id, status (success|error|denied), summary, input
  (redacted JSON), error_code, owner_email, visibility`.
- Captured automatically for every non-GET action. Read with the framework actions
  `list-audit-events` (GET; filters `targetType`, `targetId`, `actorKind`, `status`,
  `action`, `sinceMs`, `limit`), `get-audit-event`, `export-audit-events`.
- `AGENT_NATIVE_AUDIT_RETENTION_DAYS` (default 365; `0` = forever).

## F12. Agent chat plugin

`server/plugins/agent-chat.ts` (scaffold shape):

```ts
import { getOrgContext } from "@agent-native/core/org";
import { createAgentChatPlugin, loadActionsFromStaticRegistry } from "@agent-native/core/server";
import actionsRegistry from "../../.generated/actions-registry.js";
export default createAgentChatPlugin({
  appId: "chat",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  initialToolNames: ["view-screen", "navigate", "hello"],
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `...`,
});
```

Options verified in docs: `frameworkTools: { preset?: "minimal", database?: "read"|"write"|"off",
extensions?, sharing?, review?, history?, featureFlags?, localization?, audit?, contextXray?,
userProfile?, automation?, docs?, resources?, web?, workspaceApps?, chat?, email? }`.
`.generated/actions-registry.ts` (imported as `.js` in the plugin) is produced by the framework
build/dev step from `actions/`; it is git-ignored and regenerated by `pnpm dev`/`pnpm build:worker`.

Agent chat endpoint: `POST /_agent-native/agent-chat` with `{ "message": "..." }` returns
`text/event-stream`; without a provider key the first event is
`{"type":"error","errorCode":"missing_credentials",...}`.

## F13. Evals and CLI

- `pnpm exec agent-native eval [pattern] [--json] [--threshold N]` discovers `**/*.eval.ts`
  and `evals/*.ts`, runs the real agent loop (needs a provider key), exits 0 when all pass or
  all skipped or none found. `defineEval({ name, input: { prompt }, scorers, threshold?,
  skipReason? })`; scorers `usesTool(name)`, `contains(...)`, `exactMatch`, `llmJudge`,
  `createScorer`.
- `pnpm action <name> '{"arg":"value"}'` or `pnpm action <name> --arg value` runs an action
  with `caller: "cli"`, identity from `AGENT_USER_EMAIL` / `AGENT_ORG_ID`, database from
  `DATABASE_URL` (default local file). There is no per-action `--help` in 0.176.5: `pnpm action
  --help` lists the app actions, and an invalid argument value (for example `--status nope`)
  prints the action's full parameter signature. Without identity the action fails with
  `errorCode: "AUTHENTICATION"`.
- `pnpm exec agent-native doctor` runs nine guards; must be clean. Relevant guards:
  `no-env-credentials` flags `process.env.X` reads outside an allowlist (`DATABASE_URL`,
  `BETTER_AUTH_SECRET`, `NODE_ENV`, ...); opt-out marker `// guard:allow-env-credential — reason`
  on the same line or the line above. `db-tool-scoping` requires every table in
  `server/db/schema.ts` to have `owner_email` or `org_id`. `no-drizzle-push` forbids
  `drizzle-kit push` in build/deploy hooks.

## F14. Internationalization

- Closed locale list: `en-US, es-ES, fr-FR, de-DE, pt-BR, zh-CN, zh-TW, ja-JP, ko-KR, hi-IN,
  ar-SA` (`SUPPORTED_LOCALES` in `dist/localization/shared.js`). `nb-NO` is rejected by
  `set-localization-preference`, filtered out of the picker, and has no framework UI catalog.
  Upstream request: BuilderIO/agent-native#3985.
- App catalogs: `app/i18n/index.ts` builds `createAgentNativeI18nCatalog({ messages: enUS,
  localeLoaders: { "<code>": () => import("./<code>") }, supportedLocales?: [...] })`.
  `useT()(key, params)`, `useFormatters()` for dates/numbers, `<LanguagePicker />`.
  Interpolation is `{{name}}` only (`template.replace(/\{\{(\w+)\}\}/g, ...)` in
  `dist/client/i18n.js`); a single-brace `{name}` is never substituted and reaches the screen
  verbatim, so `scripts/check-i18n-catalogs.mjs` rejects it (T15).
- Guard: `pnpm guard:i18n-catalogs` (add script from the template if missing; verify the exact
  command in `docs/content/internationalization.mdx`).
- Framework UI catalogs: `dist/localization/core-messages/<code>.js`; English source
  `en-US.js` about 33 KB.
- Locale metadata shape: `{ code, englishName, nativeName, dir: "ltr"|"rtl" }`.
- The locale list is coupled to far more than `SUPPORTED_LOCALES` + one catalog. Verified on
  upstream `main` (core 0.177.0) by T25: nine further exhaustive `Record<LocaleCode, …>` maps in
  `packages/core` (`MCP_CONNECT_MESSAGES`, `MCP_SETTINGS_MESSAGES`, `AUTH_LOCALE_COPY`,
  `NATIVE_AUTH_COPY`, `LANGUAGE_PICKER_COPY`, `errorCopy`, `FEEDBACK_COPY`, `BLOCK_COPY`,
  `EXTENSIONS_COPY`), two coverage tests (`auth-marketing-locales.spec.ts` wants a tagline plus
  matching feature bullets for all sixteen built-in marketing surfaces; `mcp-connect-content.spec.ts`
  wants all seven MCP connect guides translated), nine first-party template aggregates that assert
  `satisfies Record<LocaleCode, Messages>`, and a localized-docs coverage guard that fires once per
  English doc. `pnpm guard:i18n-catalogs` does **not** require template catalogs for every locale —
  `pnpm typecheck` is the gate that does. See `docs/plan/DISCREPANCIES.md` 2026-09-08 T25 and
  `docs/plan/upstream-issues/nb-NO-pr.md`.

## F15. Telemetry and outbound calls

- Browser analytics only when `VITE_AGENT_NATIVE_ANALYTICS_PUBLIC_KEY` (or
  `configureTracking({ key })`) is set; default endpoint `https://analytics.agent-native.com/track`.
- Builder.io APIs (`api.builder.io/agent-native/...`) only when `BUILDER_PRIVATE_KEY` or a
  Builder connection exists.
- Sentry only when `SENTRY_DSN` is set.
- Nothing else phones home in the verified configuration.

## F16. Framework upgrade command

`pnpm exec agent-native upgrade check` (doctor-only) and `pnpm exec agent-native doctor --only
migration-manifest` report scheduled import moves. Do not run `agent-native upgrade` blindly; T22
describes the manual, reviewed upgrade.
