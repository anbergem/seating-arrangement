# Discrepancies between the plan and reality

Append-only. One entry per discrepancy. Newest at the bottom. Never delete an entry; if it is
resolved, add a `Resolution:` line.

Template:

```
## <YYYY-MM-DD> <task id> — <one-line title>

Expected (plan reference): <file and section of the plan that made the assumption>
Observed: <exactly what you saw: command, output, file path, line>
Impact: <which task steps are blocked or changed>
Proposed handling: <what you did instead, or "blocked, needs a decision">
Resolution: <filled in later by the maintainer>
```

---

## 2026-09-06 T00 — `pnpm-workspace.yaml` has no `workerd` placeholder line

Expected (plan reference): `docs/plan/02-framework-facts.md` F1 ("The scaffold leaves a
placeholder line `workerd: set this to true or false`; it must become `workerd: true`. Also
needed: `better-sqlite3`, `esbuild`, `node-pty`, `@resvg/resvg-js`.") and
`docs/plan/tasks/T00-scaffold.md` step 6 ("replace the line `workerd: set this to true or
false` with `workerd: true`").

Observed: after `CI=1 npx @agent-native/core@0.176.5 create example-jobs --standalone
--template chat --yes`, the generated `pnpm-workspace.yaml` `allowBuilds` block reads exactly:

```
allowBuilds:
  tesseract.js: true
  node-pty: true
  esbuild: true
  better-sqlite3: true
```

There is no `workerd` line at all (placeholder or otherwise), and no `@resvg/resvg-js` line.
Plausible cause: the `chat` template does not depend on `wrangler`, so `workerd` is not in its
dependency graph until this task adds `wrangler` as a devDependency.

Impact: T00 step 6 as literally written cannot be executed (there is no line to replace). No
other step is affected.

Proposed handling: added `workerd: true` as a new entry at the end of the existing
`allowBuilds` block, which reaches the end state F1 requires, and left the rest of the file
untouched. `@resvg/resvg-js` was not added, because step 6 says to leave the rest untouched and
nothing in the dependency graph after `pnpm install` requires it — `pnpm install` completed with
no "ignored build scripts" warning and `workerd@1.20260903.1` plus
`@cloudflare/workerd-darwin-arm64@1.20260903.1` built successfully.

Resolution: 2026-09-06 — F1 rewritten to the observed scaffold (add `workerd: true`).
## 2026-09-06 T00 — `pnpm doctor` runs pnpm's built-in doctor, not `agent-native doctor`

Expected (plan reference): `docs/plan/tasks/T00-scaffold.md` "Acceptance" lists `pnpm doctor`,
and `docs/plan/02-framework-facts.md` F3 records the scaffold script `doctor` =
`agent-native doctor`, so the acceptance command was clearly meant to run the framework doctor.

Observed: pnpm 11.23.0 has a built-in `doctor` command, which shadows the `doctor` script in
`package.json`. `pnpm doctor` prints pnpm environment checks ("Versions: pnpm 11.23.0,
Node.js 26.6.0 … All checks passed") and exits 0; it never invokes `agent-native`. The
framework doctor is reached with `pnpm run doctor` (or the scaffold's `pnpm agent-native:doctor`
alias), which prints "agent-native doctor: … Clean — no findings." and also exits 0.

Impact: none for T00 — both commands exit 0 and both outputs are recorded in the pull request.
Later tasks that rely on the framework guards (`no-drizzle-push`, `no-empty-migrations`,
`no-unscoped-queries`, …) must use `pnpm run doctor` or `pnpm agent-native:doctor`, not bare `pnpm doctor`.

Proposed handling: ran both and recorded both outputs. Suggest T01, which owns the script
table, standardises on an unambiguous script name for the framework doctor and that later task
files and CI use `pnpm run doctor`.

Resolution: 2026-09-06 — the plan now uses the script name `agent-native:doctor` everywhere (B15, T01, all acceptance blocks); no script named `doctor` will exist.

## 2026-09-06 T01 — `git check-ignore -q` rejects more than one pathname

Expected (plan reference): `docs/plan/tasks/T01-toolchain.md` step 5 specifies the check
"`.env` or `.dev.vars` is not ignored (`git check-ignore -q .env .dev.vars`)".

Observed: with git 2.39.5, `git check-ignore -q .env .dev.vars` prints
`fatal: --quiet is only valid with a single pathname` and exits 128, so the check reported a
false finding (".gitignore: .env and .dev.vars must both be git-ignored") on a repository where
both files are correctly ignored. `git check-ignore -q .env` and `git check-ignore -q .dev.vars`
each exit 0.

Impact: T01 step 5 only; the check itself is unchanged in meaning.

Proposed handling: `scripts/check-config-hygiene.mjs` runs `git check-ignore -q <file>` once per
file and reports the offending file by name. No plan change needed beyond the command spelling.

Resolution: 2026-09-06 — Accepted; the checker tests one path at a time.
## 2026-09-06 T01 — `oxfmt` reformats the plan's Markdown, so `docs/` and `.agents/` are ignored

Expected (plan reference): `docs/plan/tasks/T01-toolchain.md` step 3 ("`.oxfmtrc.json`: … add an
`ignore` list with the same directories") and step 9 ("fix scaffold formatting only by running
`oxfmt --write .` once"), i.e. the formatter was expected to touch scaffold source only.

Observed: oxfmt 0.66.0 formats Markdown and YAML as well as TS/JS/JSON. `oxfmt --list-different .`
reported 36 files, of which 31 are documents, not scaffold source: `docs/plan/*.md` (the
implementation plan itself, including `03-blueprint.md`), `docs/plan/tasks/T*.md`, and the three
framework-provided `.agents/skills/*/SKILL.md`. On `docs/plan/03-blueprint.md` alone
`oxfmt --write` produced a 941-line diff: it pads every Markdown table and re-wraps the
normative TypeScript inside the fenced code blocks. The config key is also spelled
`ignorePatterns` (per `node_modules/oxfmt/configuration_schema.json`); there is no `ignore` key.

Impact: T01 step 9. Running `oxfmt --write .` literally would rewrite the specification that
every remaining task reads, in a toolchain pull request.

Proposed handling: `.oxfmtrc.json` `ignorePatterns` lists `docs` and `.agents` in addition to the
eight build directories from step 3, so `oxfmt` owns source and root Markdown (`AGENTS.md`,
and later `README.md`/`ARCHITECTURE.md` from T23) but never the plan or the framework skills.
`oxfmt --write .` was then run once over the remainder as step 9 requires.

Resolution: 2026-09-06 — Accepted; `docs/` and `.agents/` stay ignored by oxfmt.
## 2026-09-06 T01 — `noUncheckedIndexedAccess` breaks two scaffold files

Expected (plan reference): `docs/plan/tasks/T01-toolchain.md` step 8 ("`tsconfig.json`: … `strict:
true`; `noUncheckedIndexedAccess: true`") with `pnpm check` (which runs `agent-native typecheck`)
passing under "Acceptance".

Observed: after enabling the flag, `pnpm typecheck` failed with two pre-existing scaffold errors:

```
app/components/layout/Sidebar.tsx(113,38): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
app/hooks/use-navigation-state.ts(33,38): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
```

Both are the same line, `const value = decodeURIComponent(match[1]).trim();`, inside a
`threadIdFromPath` helper that has already returned when `match` is null.

Impact: T01 step 8 and the acceptance command `pnpm check`.

Proposed handling: changed both to `decodeURIComponent(match[1] ?? "")`. The regex
`/^\/chat\/([^/]+)/` always fills group 1 when it matches, so runtime behaviour is unchanged;
this is the smallest edit that keeps the flag the plan requires. No other scaffold file needed a
change.

Resolution: 2026-09-06 — Accepted; the two scaffold fixes are the intended behaviour.
## 2026-09-06 T02 — `wrangler.jsonc` is JSONC with trailing commas, which T01's parser rejected

Expected (plan reference): `docs/plan/03-blueprint.md` B14 gives the `wrangler.jsonc` skeleton,
and `docs/plan/tasks/T01-toolchain.md` step 5 / B15 say `scripts/check-config-hygiene.mjs`
parses that file ("no `REPLACE_ME` outside env blocks; secrets not in vars"). T01 implemented
the parse as `JSON.parse(stripJsonComments(source))`, which assumes comments are the only
JSONC-only syntax in the file.

Observed: `oxfmt` 0.66.0 formats `.jsonc` with `trailingComma: "all"` (our `.oxfmtrc.json`), so
after `pnpm lint` every object and array in `wrangler.jsonc` ends with a trailing comma. Removing
them is not an option: `oxfmt --check .`, part of `pnpm lint` and therefore of `pnpm check`,
then reports the file as unformatted. With the commas in place the T01 parser failed:

```
wrangler.jsonc: not parseable as JSON after stripping comments (SyntaxError: Expected double-quoted property name in JSON at position 615 (line 25 column 3))
1 config hygiene finding(s)
```

Impact: T02 step 5 (extending the checker) and the acceptance command `pnpm check`. Without the
fix the checker fails on a correctly formatted `wrangler.jsonc` and its `REPLACE_ME` and
secrets-in-vars rules never run at all.

Proposed handling: added a string-aware `stripTrailingCommas()` next to the existing
`stripJsonComments()` in `scripts/check-config-hygiene.mjs` and composed the two before
`JSON.parse`. Commas are overwritten with spaces rather than deleted so byte offsets in a parse
error still point at the right place in the original file. No behaviour change other than
accepting the JSONC that the repository's own formatter produces.

Resolution: 2026-09-06 — Fixed in `scripts/check-config-hygiene.mjs` (string-aware trailing-comma stripper).
## 2026-09-06 T03 — the `chat` template's Sidebar has no Database or Extensions entries

Expected (plan reference): `docs/plan/tasks/T03-framework-config.md` step 10 ("Remove
navigation entries for Database and Extensions in `app/components/layout/Sidebar.tsx` and the
`i18n` keys that reference them") and D12 ("The template's database browser page and extensions
pages are removed").

Observed: `app/components/layout/Sidebar.tsx` as generated by the `chat` template has exactly
two navigation lists — `navItems` with one entry (Chat, `/home`) and `bottomNavItems` with one
entry (Settings, `/settings`). There is no Database entry, no Extensions entry, and no
`/database` or `/extensions` route anywhere under `app/routes/`. The Database/Extensions
surface D12 describes belongs to the `default` template, not `chat`.

The i18n keys did exist: `navigation.database`, `navigation.extensions` and
`pages.databaseTitle` were present in all eleven `app/i18n/<locale>.ts` catalogs. The only code
that read one of them was a dead branch in `app/components/layout/Header.tsx`:
`if (pathname.startsWith("/extensions")) return t("navigation.extensions");`.

Impact: T03 step 10, the Sidebar half only. Nothing else changes; `Sidebar.tsx` is unchanged in
this pull request even though it is listed under Deliverables.

Proposed handling: removed the three keys from all eleven catalogs as the step requires, and
removed the one dead `Header.tsx` branch that referenced a now-deleted key rather than leave a
`t()` call pointing at nothing. `Sidebar.tsx` needed no edit. The unused
`app/i18n-data.ts` (imported by nothing) still carries the same keys and was left alone; T15
owns the catalogs.

Resolution: 2026-09-06 — Accepted; T03 removed only the dead i18n keys. F3 note stands.
## 2026-09-06 T03 — the sign-in page always contains the string "Continue as local dev"

Expected (plan reference): `docs/plan/tasks/T03-framework-config.md` step 11 ("sign-in page HTML
does not contain `Continue as local dev`") with F7's
`AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT=1` as the mechanism.

Observed: the flag works, but it does not remove the string from the served HTML. In
`node_modules/@agent-native/core/dist/client/auth/AuthPage.js` the local-dev block is rendered
unconditionally and hidden by React state that starts `false`:

```js
const [localDevAvailable, setLocalDevAvailable] = React.useState(false);
...
React.createElement("div", { className: "local-dev-signin", id: "local-dev-signin", hidden: !localDevAvailable },
  React.createElement("button", { ... id: "local-dev-btn", ... }, ... t("localDevButton")),
```

so `curl http://localhost:8080/sign-in` returns markup containing
`id="local-dev-signin" hidden=""` around a button whose label is `Continue as local dev`. The
string also appears a second time in the page's embedded i18n copy blob
(`"localDevButton":"Continue as local dev"`), which is served whatever the flag says.

Impact: T03 step 11's first check as literally written can never pass on 0.176.5.

Proposed handling: verified the behaviour the check was written to protect, three ways instead
of grepping the HTML:
`curl -s http://localhost:8080/_agent-native/auth/local-dev` returns
`{"available":false,"reason":"not-allowed"}` (the button only un-hides when this says `true`);
the served markup carries `id="local-dev-signin" hidden=""`; and in a real browser
`document.getElementById("local-dev-signin").hidden === true`,
`document.body.innerText.includes("Continue as local dev") === false`. A future task that wants
a machine check should assert on the `/_agent-native/auth/local-dev` response, not on the HTML.

Resolution: 2026-09-06 — F7 updated: verify via `GET /_agent-native/auth/local-dev`, never by grepping HTML.
## 2026-09-06 T03 — `createAuthPlugin({ marketing })` serves the sign-in document at `/` and hides the index route

Expected (plan reference): `docs/plan/tasks/T03-framework-config.md` step 4 (keep
`createAuthPlugin`, set `marketing.appName`, remove `workspaceAppPublicPaths`) together with
step 10 (`/` redirects to `/jobs`) and B17 (`/` → redirect `/jobs`).

Observed: with only those two edits, `GET /` returned the sign-in document for **every**
visitor, signed in or not (`<title>Example Jobs — Sign in</title>`), the `_index` route module
was never loaded, and the response carried none of the middleware's security headers. The cause
is in `node_modules/@agent-native/core/dist/server/auth.js`:

```js
rootAuth: options.rootAuth ?? Boolean(options.marketing),
...
if (config.rootAuth && p === "/" && resolveAppHomePath(getAppConfig().app) !== "/" && isHtmlDocumentRequest(event, p)) {
    return loginHtmlResponse(config.loginHtml, event, { includeRootAuthRedirect: true, requestIndependent: true });
}
```

Providing `marketing` at all turns `rootAuth` on, and that branch is deliberately
session-independent ("the cached root document stays identical for every visitor"), so a
signed-in user at `/` is handed off to `app.homePath` — `/home` — and never reaches the redirect
step 10 asks for.

Impact: T03 steps 4, 9 and 10, and the `GET /` part of step 11.

Proposed handling: added `rootAuth: false` to `createAuthPlugin` — one key step 4 does not list,
with a comment saying why. `/` is now an ordinary authenticated page: it loads `routes/_index`,
carries `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`, and an
anonymous visitor is taken through `/jobs` to
`/sign-in?c=JTJGam9icw` (`JTJGam9icw` decodes to `%2Fjobs`) by the framework's client session
gate. The alternative the framework's own comment offers — `app.homePath: "/"` — reaches the
same place and was not used because it would also move the post-sign-in landing page.

Resolution: 2026-09-06 — F7 updated: `rootAuth: false` is required in `createAuthPlugin`.
## 2026-09-06 T03 — a loader `redirect("/jobs")` at `/` breaks the Cloudflare static-shell build

Expected (plan reference): `docs/plan/tasks/T03-framework-config.md` step 10 offers two ways to
implement the root redirect: "`redirect("/jobs")` in a loader, or a component that navigates".

Observed: the loader form makes `pnpm build:worker` fall back. The Cloudflare build renders `/`
through the React Router handler to produce `dist/index.html`
(`writeCloudflarePagesStaticShell` in `dist/deploy/build.js` requests
`https://agent-native.local/` with `X-React-Router-SPA-Mode: yes`), and a redirecting root
returns no HTML, so its assertion fails:

```
Error: React Router did not render a usable Cloudflare Pages static shell
[deploy] React Router static shell render failed; using manifest fallback. ...
[deploy] Wrote Cloudflare Pages static app shell fallback.
```

The build still exits 0 and the framework writes a manifest-generated shell, so this is a
degradation rather than a failure. With the component form the line is
`[deploy] Wrote Cloudflare Pages static app shell.` again, identical to T02.

Impact: T03 step 10 only — the choice between the two forms the step offers.

Proposed handling: used the component form, `<Navigate to="/jobs" replace />` in
`app/routes/_index.tsx`, with a comment recording why. Note for T12 and T14: the deployed Worker
serves `dist/index.html` for `/` as a static asset before the Worker runs, so `/` is a
client-side redirect there whichever form is used; a Worker smoke test must not expect an HTTP
302 from `/`.

Resolution: 2026-09-06 — F7 and B19 updated: client-side `<Navigate>` at `/`; never expect a 302 from `/`.
## 2026-09-06 T03 — `validateEnvironment(env)` cannot implement B13's "APP_ENV missing → error on Workers"

Expected (plan reference): `docs/plan/03-blueprint.md` B13 ("`APP_ENV` missing → treated as
`local` on the Node dev server, error on Workers") and `docs/plan/tasks/T03-framework-config.md`
step 8 plus the Acceptance note, which fix both the signature
(`validateEnvironment(env: Record<string, string | undefined>): string[]`) and the exact list of
thirteen variables the plugin may read.

Observed: those two requirements cannot both hold. The mandated input is thirteen named
variables, none of which distinguishes a Worker from the Node dev server — `NODE_ENV`, the one
value that would (B13 has it unset locally and `"production"` on every Worker), is not on the
list, and the runtime signals that would (`globalThis.__cf_env`, per F8) are not environment
variables at all.

Impact: T03 step 8, one rule out of the B13 set. Every other B13 rule is implemented.

Proposed handling: `resolveEnvironmentClass` treats a missing `APP_ENV` as `local`, which is
B13's Node-dev-server half, and an `APP_ENV` that is set but is not one of the four classes is
reported as a violation (so a typo such as `prod` fails loudly rather than silently selecting
the local rules). The Workers half is unreachable from our own configuration: `wrangler.jsonc`
sets `APP_ENV` in `vars` for the default, `staging` and `production` environments, and
`scripts/check-config-hygiene.mjs` parses that file. If the maintainer wants the rule enforced
anyway, the smallest change is to add `NODE_ENV` to the plugin's read list and treat
"`APP_ENV` unset and `NODE_ENV=production`" as a violation.

Resolution: 2026-09-06 — B13 rewritten: missing `APP_ENV` resolves to `local`; unknown value is a violation.
## 2026-09-06 T05 — B7's `ports.ts` step and B22's own file path for `ExternalAccountingSystem` disagree

Expected (plan reference): `docs/plan/tasks/T05-application-core.md` step 4 ("`src/application/ports.ts` per B7 (all interfaces, `Dependencies`)") and the Deliverables list, which names only
`src/application/ports.ts` (no subdirectory). `docs/plan/03-blueprint.md` B7's own code block,
however, annotates the `ExternalAccountingSystem` interface with a trailing comment
`// src/application/ports/external-accounting.ts`, and B22 repeats this explicitly: "Files:
`src/application/ports/external-accounting.ts` (port + `ExternalSystemError`)".

Observed: step 4's instruction ("all interfaces … in ports.ts") and B7/B22's own file
annotation for one of those interfaces name two different locations for the same type.

Impact: T05 step 4 only, and the "git diff --stat shows only listed deliverables" acceptance
rule in `docs/plan/tasks/README.md` — one extra file, `src/application/ports/external-
accounting.ts`, is not on the Deliverables list.

Proposed handling: followed B22's explicit file path, since T27 (which the same task file
told this task to read B22 for) will need `ExternalSystemError` and depends on this exact
location. `src/application/ports/external-accounting.ts` exports `ExternalAccountingSystem`
and `ExternalSystemError`; `src/application/ports.ts` re-exports both with `export * from
"./ports/external-accounting"` and imports the interface type for use in `Dependencies`, so
every other file can still do `import { ExternalAccountingSystem, Dependencies, ... } from
"../application/ports"` as step 4 implies. `tests/fixtures/in-memory.ts` implements a trivial
in-memory `ExternalAccountingSystem` (deterministic `ACC-<jobId>` reference, an `alreadyExisted`
flag keyed by idempotency key, no `failNextCall`) so `Dependencies` is complete for every
use-case test before T27 adds the real, independently tested mock adapter.

Resolution: 2026-09-06 — Accepted: the port lives in `src/application/ports/external-accounting.ts` and `ports.ts` re-exports it.
## 2026-09-06 T06 — a naively generated `migrations-manifest.ts` fails `oxfmt --check`

Expected (plan reference): `docs/plan/tasks/T06-schema-migrations.md` step 4 —
`scripts/gen-migrations-manifest.mjs` "writes `src/infrastructure/migrations-manifest.ts`
containing `export const MIGRATION_FILES = [ ...sorted names ] as const;` … Commit the
generated file" — together with the standing rule that `pnpm check` (which runs
`oxlint . && oxfmt --check .`) passes.

Observed: the two requirements collide. oxfmt 0.66.0 has an opinion about array layout: with
one migration it collapses the emitted

```ts
export const MIGRATION_FILES = [
  "0001_init.sql",
] as const;
```

onto one line, so immediately after `node scripts/gen-migrations-manifest.mjs` (or after any
`pnpm db:migrate` / `pnpm build:worker`, both of which run the generator) `pnpm lint` reports
`src/infrastructure/migrations-manifest.ts … Format issues found in above 1 files`. Emitting
the single-line form instead only moves the problem: with the second migration (T27's
`0002_job_accounting.sql`) the line is 84 characters, over the repository's
`printWidth: 80`, and oxfmt expands it again.

Impact: T06 step 4, and `pnpm check` after any command that regenerates the manifest.

Proposed handling: the generator writes the file and then runs the repository's own formatter
on it (`node_modules/.bin/oxfmt --write <file>`) when that binary is present, so the committed
file matches `.oxfmtrc.json` for any number of migrations rather than duplicating oxfmt's
line-breaking rule in the generator. Verified idempotent at one and at three migration files.
A production-only install has no oxfmt; the generator then leaves its own valid-TypeScript
output in place and says so. Note for T27: adding `0002_job_accounting.sql` changes this file
from one line back to three, which is expected.

Resolution: 2026-09-06 — Accepted; the generator formats its output with the repository's oxfmt.
## 2026-09-06 T07 — `getDbExec()` advertises both `atomicBatch` and `transaction` until its first query

Expected (plan reference): `docs/plan/02-framework-facts.md` F8 ("On D1: `atomicBatch` present,
`transaction` absent. On the local file (better-sqlite3) and libsql: `transaction` present
(BEGIN IMMEDIATE), `atomicBatch` absent") and `docs/plan/03-blueprint.md` B11's `runAtomic`
("if `exec.atomicBatch`: use it; else if `exec.transaction`: run sequentially inside it").

Observed: F8 describes the executor **after** it has initialised. `getDbExec()` returns a lazy
proxy (`node_modules/@agent-native/core/dist/db/client.js:1851`) that defines `execute`,
`transaction` *and* `atomicBatch` up front and only replaces the unsupported one with
`undefined` when its first `execute()` has chosen a driver. With
`DATABASE_URL=file:./data/probe.db`:

```
pre-init:  { execute: 'function', transaction: 'function', atomicBatch: 'function' }
post-init: { transaction: 'function', atomicBatch: 'undefined' }
```

So a `runAtomic` that feature-detects on a freshly obtained executor sends a local-file write
down the `atomicBatch` path, which throws `This database does not support atomic batches.`
(verified). Calling it again does not help: the failed call leaves `atomicBatch` still defined
on the proxy. In practice the first database call of a request is the membership lookup in
`resolveActor`, which would hide this — until the first process where a write happens to come
first, such as a seed script or an integration test.

Impact: T07 steps 2 and 4 (`runAtomic` and every repository).

Proposed handling: `runAtomic` is exactly B11's three-branch rule and is unchanged. The
repositories reach their executor through `resolveExec` (`src/infrastructure/d1/atomic.ts`),
which issues one throwaway `SELECT 1` when — and only when — an executor advertises both
capabilities, since a real one never does. `tests/integration/repositories.test.ts` exercises
this: its first database call is a `create`, which fails without the workaround. Suggest F8
gains a sentence about the pre-initialisation shape.

Resolution: 2026-09-06 — F8 updated; `resolveExec` probes with `SELECT 1` first.
## 2026-09-06 T07 — B11's audit-row guard lets a lost update write an operation row

Expected (plan reference): `docs/plan/03-blueprint.md` B11's `commit` batch — statement 1 the
versioned `UPDATE`, statement 2 the operation `INSERT` guarded by
`EXISTS (SELECT 1 FROM jobs WHERE org_id = ? AND id = ? AND version = ?)   -- new version`,
with the note "Statement 2's guard makes the batch a no-op when statement 1 did not apply" —
together with `docs/plan/tasks/T07-infrastructure.md` step 8, which requires that a `commit`
with a stale version "throws CONFLICT and leaves no operation row".

Observed: the guard is not sufficient, and the first run of the integration test proved it. Two
callers read `job_acme` at version 1 and both complete it. The winner writes version 2. The
loser's `UPDATE ... AND version = 1` affects zero rows as intended, but its operation insert is
guarded on the version *it* wanted to write — also 2 — which now matches the winner's row, so
the guard passes and an audit row is written for a change that never happened:

```
AssertionError: expected { id: 'op_stale_job_acme', …(15) } to be null
+ Received: { "action": "complete-job", "versionBefore": 1, "versionAfter": 2, … }
```

The same batch's optional third statement, `MARK_OPERATION_UNDONE` as B11 spells it, has no
guard at all, so a refused commit would still mark an earlier operation undone by an audit row
that was never inserted.

Impact: T07 steps 1, 2 and 4, and the correctness of the undo history every later task reads.

Proposed handling: same statements, corrected guards. The operation insert now runs **first**
and is guarded on the version the caller read (`expectedVersion`), which is the same predicate
the update carries; both statements see the same pre-image inside one transaction, so they
apply together or not at all whatever version the update would have written.
`MARK_OPERATION_UNDONE` gained `AND EXISTS (SELECT 1 FROM operations WHERE org_id = ? AND
id = ?)` naming the undoing operation, so it cannot outlive a batch whose guards failed. The
CONFLICT decision now reads both counts (`affected[0] !== 1 || affected[1] !== 1`) rather than
B11's `rowsAffected[0]`, because index 0 is no longer the update. Both cases are covered in
`tests/integration/repositories.test.ts`. Suggest B11 is rewritten to this shape.

Resolution: 2026-09-06 — B11 rewritten to the verified shape (operation insert first, both row counts checked).
## 2026-09-06 T07 — "every exported constant contains `org_id = ?`" cannot hold for the WHERE fragments

Expected (plan reference): `docs/plan/tasks/T07-infrastructure.md` step 1 — "Every constant
except `SELECT_MEMBER_ROLE` contains `org_id = ?`" and, in the same paragraph, "`SELECT_JOBS`
supports optional filters by building the WHERE clause in code from a fixed set of fragments
(status, customer_id, scheduled_at >= ?, scheduled_at < ?) — the fragments are also exported
constants" — with step 6's test: "iterate every exported string, assert it contains
`org_id = ?`".

Observed: the two cannot both be true. A fragment is ` AND status = ?`; it has no `org_id` of
its own and cannot have one, because it is appended to a statement that already carries the
predicate. Exporting the fragments as loose string constants would make step 6's test fail on
statements that are correct.

Impact: T07 steps 1 and 6.

Proposed handling: the fragments are exported, but grouped in one frozen record per list
statement (`SELECT_JOBS_PARTS`, `SELECT_CUSTOMERS_PARTS`) rather than as loose strings, so
"every exported string" still means "every whole statement" and step 6's assertion holds
unweakened for all 18 of them. `tests/unit/infrastructure/sql-scoping.test.ts` checks the
fragments too, against the stricter rule that actually applies to them: each must match a fixed
`AND <column> <operator> ?` / `ORDER BY …` pattern with at most one placeholder, so no caller
value can ever reach the SQL text. `SELECT_CUSTOMERS` needed the same treatment as
`SELECT_JOBS`; step 1 only mentions the latter, but `CustomerRepository.list` takes `status`
and `search` filters (B7).

Resolution: 2026-09-06 — B11 updated: `*_PARTS` records and a fixed allow-list for fragments.
## 2026-09-06 T07 — the in-memory `to` filter is inclusive, the SQL fragment T07 specifies is exclusive

Expected (plan reference): `docs/plan/tasks/T07-infrastructure.md` step 1 lists the job filter
fragments as "(status, customer_id, scheduled_at >= ?, scheduled_at < ?)", i.e. a half-open
window.

Observed: `tests/fixtures/in-memory.ts` (T05), which the same ports are implemented against and
which every use-case unit test runs on, filters with
`.filter((j) => (filter.to ? j.scheduledAt <= filter.to : true))` — inclusive. A job scheduled
exactly at `to` is returned by the in-memory repository and not by the D1 one.

Impact: no T07 step fails; the difference only surfaces in T08, whose `list-jobs` use case is
unit-tested against the in-memory repository and integration-tested against this one.

Proposed handling: followed the task file, which is normative for T07 — `SELECT_JOBS_PARTS.to`
is `AND scheduled_at < ?`. `tests/fixtures/in-memory.ts` was left untouched because it is a T05
deliverable and this task's scope rule forbids editing it. T08 should either change that one
character in the fixture (making both half-open, which is what a day or week filter wants) or
record the inclusive form in B7; the two implementations of one port must not stay divergent.

Resolution: 2026-09-06 — T08 step 4 changed `tests/fixtures/in-memory.ts` to
`j.scheduledAt < filter.to`. Both implementations are now half-open, and
`ListJobsInput` in `src/application/use-cases/list-jobs.ts` documents it.

## 2026-09-06 T07 — the container has to fill `Dependencies.accounting`, which no task before T27 provides

Expected (plan reference): `docs/plan/tasks/T07-infrastructure.md` step 5 lists the container's
job as `getDependencies(): Dependencies` and names no accounting adapter;
`docs/plan/03-blueprint.md` B7 makes `accounting: ExternalAccountingSystem` a required field of
`Dependencies`, and B22 gives the real mock adapter
(`src/infrastructure/mock/mock-accounting.ts`) to T27.

Observed: `getDependencies()` cannot type-check without an `accounting` value, and T07 is not
asked to build one.

Impact: T07 step 5 only.

Proposed handling: `container.ts` fills the field with a four-line adapter that throws
`ExternalSystemError("The accounting system is not configured")`. Nothing calls it before T27
adds `send-job-to-accounting`, and refusing loudly in the port's own error type is safer than a
stub that returns a plausible invoice reference. T27 replaces the constant with the real mock
adapter.

Resolution: 2026-09-06 — T27 updated: replace the placeholder adapter that throws `not configured`.
## 2026-09-06 T08 — `actions/run.ts` is the CLI dispatcher, and deleting it broke `pnpm action`

Expected (plan reference): `docs/plan/03-blueprint.md` B16 ("`hello.ts` and `run.ts` are
deleted") and `docs/plan/tasks/T03-framework-config.md` step 6, whose acceptance asserts
`test ! -e actions/run.ts`. `docs/plan/02-framework-facts.md` F13 at the same time promises
`pnpm action <name> '{"arg":"value"}'` as a working surface, and T08's acceptance runs
`pnpm action list-jobs --help`.

Observed: with `actions/run.ts` absent,

```
$ pnpm action list-jobs --help
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/Users/.../agent-native-cloudflare-starter/scripts/run.ts' imported from ...
```

`node_modules/@agent-native/core/dist/cli/index.js` (case `"action"`, lines 697-710) resolves
`actions/run.ts`, falls back to `scripts/run.ts`, and executes whichever exists. The scaffolded
file is two lines — `import { runScript } from "@agent-native/core/scripts"; void runScript();`
— i.e. the CLI's dispatcher entry point, not a demo action. F5 already records that a file named
`run` is skipped by action discovery, so it never was an action.

Impact: T08's second acceptance command, and every later task or document that uses
`pnpm action <name>` (F13, B15).

Proposed handling: restored `actions/run.ts` byte-for-byte from the scaffold commit
(`git show e9e68a4:actions/run.ts`). Verified that it does not become an action: after deleting
`.generated/` and re-running `pnpm dev`, `actions-registry.ts` still lists exactly the seven app
actions and no `run`. T03's `test ! -e actions/run.ts` assertion is now false; B16's sentence
should be narrowed to `hello.ts`, and T03's acceptance line dropped.

Resolution: 2026-09-06 — F5 and B16 updated: `run.ts` stays; T03's acceptance line is superseded.
## 2026-09-06 T08 — `pnpm action <name> --help` runs the action instead of printing its parameters

Expected (plan reference): `docs/plan/tasks/T08-queries.md` acceptance,
`pnpm action list-jobs --help  # prints the action's parameters`.

Observed: with `actions/run.ts` restored (entry above), `--help` after an action name is parsed
as an ordinary argument. `dist/scripts/parse-args.js` turns `--help` into `{ help: "true" }`,
`dist/scripts/runner.js` handles `--help` only when it appears *instead of* an action name
(`if (!actionName || actionName === "--help")`), and `dispatchAction` then calls the action's
wrapped `run`. So the command runs the query:

```
$ pnpm action list-jobs --help
{"level":"error","event":"action","action":"list-jobs","outcome":"error","errorCode":"AUTHENTICATION","caller":"cli","orgId":null,"durationMs":0}
Action "list-jobs" failed: Sign in required
```

(`AUTHENTICATION` because the CLI has no identity until `AGENT_USER_EMAIL` / `AGENT_ORG_ID` are
set; with them the action runs and prints `[]`.) The runner's own banner text — "Run any action
with --help for usage details" — is not implemented for `defineAction`-style local actions in
0.176.5.

Impact: T08's second acceptance command cannot pass as written. The same line is likely to be
copied into T09, T10 and T27.

Proposed handling: the two commands that do print the parameter list were run and their output
recorded in the pull request instead:

- `pnpm action --help` lists every app action by name.
- Any call that fails schema validation prints the full signature, e.g.
  `pnpm action list-jobs --status nope` →
  `Invalid action parameters — status: … Expected: { status?: "scheduled"|"in_progress"|"completed"|"archived", customerId?: string, from?: string, to?: string, includeArchived?: boolean } (where * = required, ? = optional).`

The acceptance line should become one of those two, in this task file and in the later ones.

Resolution: 2026-09-06 — F13 updated: use `pnpm action --help` or an invalid argument value to see the signature.
## 2026-09-06 T08 — the in-memory repositories return rows unordered; the D1 ones order them

Expected (plan reference): `docs/plan/03-blueprint.md` B7 gives one `list` signature per
repository and says nothing about ordering; T07 chose `ORDER BY scheduled_at ASC, id ASC`
(`SELECT_JOBS_PARTS.order`) and `ORDER BY name ASC, id ASC`
(`SELECT_CUSTOMERS_PARTS.order`) in `src/infrastructure/d1/sql.ts`.

Observed: `tests/fixtures/in-memory.ts` returns `Array.from(map.values()).filter(...)`, i.e.
insertion order, for both `customers.list` and `jobs.list`. A `listJobs` unit test that asserted
`scheduled_at` order passed against D1 and failed against the fixture. (`operations.listRecent`
and `listForResource` do sort, so only the two `list` methods diverge.)

Impact: no acceptance command fails. `tests/unit/application/queries.test.ts` cannot assert
ordering, so it asserts sets (its `ids()` helper sorts) and carries a comment pointing here.

Proposed handling: left both implementations as they are — T08 was asked to reconcile the `to`
filter only — and recorded it. The fix is three lines in the fixture (sort by `scheduledAt`
then `id`, and by `name` then `id`); a task that needs order-sensitive unit tests, or T15's
integration suite, should make it.

Resolution: 2026-09-06 — T11 updated: in-memory repositories sort like the D1 adapters.
## 2026-09-06 T08 — B9's "creates are never redone" cannot be evaluated from resource versions

Expected (plan reference): `docs/plan/tasks/T08-queries.md` step 2 —
`redoable` "computed with `canUndo` and the redo rule from B9 against the current resource
versions — load each distinct resource once". B9's redo rule has three parts: the operation is
an undo that has not itself been reverted (1), the resource is still at `undoOp.versionAfter`
(2), and the original forward operation was not a create, because "creates are never redone
(their undo is a compensation): INVARIANT" (3).

Observed: parts 1 and 2 are properties of the operation row and the resource version. Part 3 is
a property of a *different* row — the forward operation at `undoOp.relatedOperationId` — which
is not necessarily inside the page `listRecent` returned, and loading it per undo operation is
the N+1 the same sentence forbids.

Impact: `listRecentActivity` in `src/application/use-cases/list-recent-activity.ts`. An undo of
a `create-customer` or `create-job` is reported `redoable: true`; `redo-operation` (T10) will
refuse it with INVARIANT.

Proposed handling: implemented parts 1 and 2 only, with the flag documented in the use case as
an affordance rather than an authority (T10's `redoOperation` re-checks everything). If the
false positive matters to the UI, the cheapest fix is a `payload` or `classification` on the
undo row that records whether its forward operation was a create, written by T10 where the
forward operation is already loaded.

Resolution: 2026-09-06 — T10 updated: `redoable` is false when the related forward operation is a create (`versionBefore === 0`).
## 2026-09-06 T08 — the generated registry is `actions-registry.ts`, not `.js`

Expected (plan reference): `docs/plan/02-framework-facts.md` F12,
"`.generated/actions-registry.js` is produced by the framework build/dev step from `actions/`".

Observed: `pnpm dev` writes `.generated/actions-registry.ts` and `.generated/action-types.d.ts`;
no `.js` file is produced. `server/plugins/agent-chat.ts` imports
`"../../.generated/actions-registry.js"` and works, because that is the TypeScript ESM
convention for importing a `.ts` module.

Impact: none observed — the import specifier the scaffold uses is correct as written. Recorded
so a later task does not go looking for a file that is never written.

Proposed handling: none; F12's file name should read `.ts`.

Resolution: 2026-09-06 — F12 updated.
## 2026-09-06 T09 — an idempotent create's replay can only find its own operation row through a bounded query

Expected (plan reference): `docs/plan/03-blueprint.md` B8's last paragraph — "before building
the resource, `deps.idempotency.find(orgId, action, key)`; when it returns an id, load and
return that resource with `operationId` of its creating operation (query `listForResource` and
take the `forward` create op)".

Observed: `listForResource` cannot be asked for the create op. `OperationRepository`
(`docs/plan/03-blueprint.md` B7) is
`listForResource(orgId, type, id, limit): Promise<Operation[]>` — `limit` is required, there is
no filter by `action` or `kind`, and both implementations return the *newest* rows first
(`SELECT_OPERATIONS_FOR_RESOURCE` in `src/infrastructure/d1/sql.ts` is
`ORDER BY performed_at DESC, id DESC LIMIT ?`; `tests/fixtures/in-memory.ts` sorts the same
way). The creating operation is the oldest row for its resource, so a replay finds it only
while the resource has fewer than `limit` operations. No other route exists: `idempotency_keys`
stores `resource_id` and not the operation id (B10), and `CommandResult` requires one
(B8).

Impact: T09 step 1, the idempotent creates only. Nothing else reads a create's operation id.

Proposed handling: `CREATE_OPERATION_LOOKUP_LIMIT = 100` in
`src/application/use-cases/command.ts`, with the reasoning next to it. A replay is a retry of a
call that just happened, so in practice the create is the only operation on the resource; the
verification transcript shows a replayed `create-customer` returning the first call's
`operationId` with no second row written. A key whose resource has since accumulated more than
100 operations is reported as `AppError("INTERNAL", "Unexpected error")` — the create is not
repeated and no wrong operation id is returned. Making it exact needs a new port method
(`findCreateOperation(orgId, type, id, action)`, one statement:
`... AND kind = 'forward' AND action = ? ORDER BY performed_at ASC LIMIT 1`), which is a B7
decision rather than this task's.

Resolution: 2026-09-06 — B7 gains `OperationRepository.findCreateOperation(orgId, resourceType, resourceId)`; T10 implements it in both repositories and removes the bounded lookup from `command.ts`.
## 2026-09-06 T10 — B9's undo `inverse` shape is not a member of B4's `InverseCommand` union

Expected (plan reference): `docs/plan/03-blueprint.md` B9 step 5 — build the undo operation with
"`inverse` = the forward command description needed for redo:
`{ type: "redo", action: op.action, args: <original semantic args> }`".

Observed: `InverseCommand` (`docs/plan/03-blueprint.md` B4, implemented in
`src/domain/operation.ts`) has five variants — `restore-job-status`,
`restore-job-schedule`, `archive-job`, `restore-customer`, `archive-customer` — and no `redo`
variant, so that object does not type-check as an `Operation.inverse`. The same B9 step then
supersedes its own instruction: "store the original args on the forward operation as `payload`
(add `payload: Record<string, unknown> | null` to `Operation`; creates store the create input;
transitions store `{}`; reschedule stores `{ scheduledAt }`)" — which is what T09 implemented
and what `redo-operation` actually needs, because it also needs the forward operation's
*action*, and that is on the forward row too.

Impact: T10 step 1, the undo operation row only.

Proposed handling: an undo row carries `inverse: null` and `payload: {}`; `redoOperation` reads
the action and arguments to replay from the forward operation it reaches through
`relatedOperationId`, which B9's own redo step 3 tells it to load anyway. Nothing reads an undo
row's `inverse`: `canUndo` refuses an undo as `not-forward` without looking at it. A *redo* row
does carry an inverse — the forward operation's own — because B9 lets a redo be undone
(`canUndo` accepts kind `redo`), and that is the inverse such an undo must apply.
Resolution: 2026-09-06 — B9 rewritten: undo rows carry `inverse: null`, `payload: {}`; redo reads the forward operation.

## 2026-09-06 T10 — B9's redo cannot redo the undo of a redo, a state B9's own rules allow

Expected (plan reference): `docs/plan/03-blueprint.md` B9, redo step 3 — "Load the forward op
`undoOp.relatedOperationId`; re-run its domain transition with the stored `payload`".

Observed: `canUndo` (B4) accepts `kind === "redo"`, so a redo may be undone, and that undo's
`relatedOperationId` names the *redo* row. That row's `action` is `redo-operation`, not a domain
command, so "re-run its domain transition" has nothing to run: the sequence
complete → undo → redo → undo leaves an undo operation that B9's algorithm cannot redo. Reaching
the original forward operation would mean walking `relatedOperationId` twice (undo → redo →
undo → forward), which B9 does not describe.

Impact: `src/application/use-cases/redo-operation.ts` only, and only for that fourth step;
undo → redo → undo all work.

Proposed handling: refused with `AppError("INVARIANT", "This operation cannot be redone")` —
never a guess and never a wrong write — with the test
`refuses to redo the undo of a redo, rather than guessing` in
`tests/unit/application/undo.test.ts` pinning the behaviour. If the UI wants an unlimited
undo/redo toggle (T14), the cheapest fix is to follow `relatedOperationId` while the operation
it names is itself an undo or redo, which is a B9 decision rather than this task's.
Resolution: 2026-09-06 — B9 updated: refused with INVARIANT `This operation cannot be redone`.

## 2026-09-06 T10 — B9's concurrency example cannot happen in the order it is written

Expected (plan reference): `docs/plan/03-blueprint.md` B9, last paragraph — "user A completes
job v12→v13 (op1); user B reschedules v13→v14 (op2); A calls undo(op1) → CONFLICT; B calls
undo(op2) → ok, v15; A calls undo(op1) → still CONFLICT (version 15 ≠ 13)".

Observed: the second step is impossible. `rescheduleJob` (B4, `src/domain/job.ts`) is "allowed
from `scheduled` or `in_progress`" and throws `INVARIANT "Cannot reschedule a job that is
completed"` for a job A has just completed. Verified inside the required test: the literal
sequence returns `INVARIANT`, not a version 14.

Impact: T10 step 4, the concurrency test only.

Proposed handling: the test runs the two commands in the order the domain allows — A
reschedules v12→v13, B completes v13→v14 — which preserves every version number and every
outcome the example states (A's undo CONFLICT, B's undo ok at v15, A's undo still CONFLICT), and
asserts the refusal of the literal order first so the reason the order is swapped is in the test
rather than only here. B9's prose should swap the two actions.
Resolution: 2026-09-06 — B9 updated: A reschedules v12→13, B completes v13→14; same outcomes.

## 2026-09-06 T11 — the framework's `organizations` table does not exist until the app has served a request

Expected (plan reference): `docs/plan/tasks/T11-seed.md` step 2 — the seed's order is "(1) if
`--reset`, execute reset SQL; (2) execute scenario SQL … (3) unless `--skip-users`, for each
user: `POST …/auth/register`", and `docs/plan/03-blueprint.md` B12 has `buildScenarioSql()`
insert into `organizations` and `org_members`. Nothing says the two tables have to be created
first, and `docs/plan/tasks/T11-seed.md` step 4 puts `pnpm db:reset && pnpm db:seed` in one
command line for the Node target.

Observed: `organizations` and `org_members` are framework-owned (F6) and are created by the
framework's own migration runner, not by `migrations/`, so `pnpm db:reset` leaves a database
with the application tables and without those two. Seeding it then fails:

```
$ pnpm db:reset && pnpm db:seed:worker
seed: target d1-local, 28 scenario statements, 5 users
✘ [ERROR] no such table: organizations: SQLITE_ERROR
```

F10 already records the cause ("the framework's own table creation runs during the first
request that touches the database") but not that it gates the seed. The two runtimes differ,
and only one of them is as bad as F10 says:

- `pnpm dev` (Node) applies the framework migrations **at boot**, with no request: `/tmp/dev.log`
  shows `[db] Applying 18 migration(s) on SQLite/libsql… v1001 …` above the first `GET`. A
  started dev server is enough, which is why the acceptance line passes as written.
- `wrangler dev` (Worker) defers them to the first request that touches the database, exactly as
  F10 says. One `GET /_agent-native/ping` does it — the `wrangler dev` log shows all 18 `v10xx`
  migrations applied before that first `ping` returns.

Impact: T11 step 2 (the order is right, but it has an unstated precondition). Neither acceptance
command changes: both start a server before seeding. `INSERT OR IGNORE` cannot help — the table
is missing, not the row.

Proposed handling: kept the seed's statement list exactly as B12 specifies — copying the
framework's DDL into this repository would be a second, drifting definition of a
framework-owned table — and made the failure name its own fix: `missingOrgTableHint` in
`scripts/seed.mjs` recognises `no such table: organizations|org_members` and prints the one
instruction that resolves it (start the server, let it answer `ping`, then seed). The rule for
every later task is: **a database can only be seeded after the app has been pointed at it — the
Node dev server having booted, or the Worker having answered one request.** T12 (Worker smoke)
and T16 (Playwright, which the plan has applying the scenario SQL *before* starting the Worker)
both run against `wrangler dev` and so must poll `ping` before seeding; T16's order as written
in the plan will fail.

T13 is the harder case: it seeds `data/test-integration.db` from `buildScenarioSql()` with no
server at all, and `tests/integration/global-setup.ts` runs `migrations/` only. A `getDbExec()`
query is *not* enough — T07 already found this and hand-wrote the framework's v1002 DDL in
`tests/integration/repositories.test.ts` (`describe("membership reader")`), and after
`pnpm test:integration` that database has `org_members` and still no `organizations`. So T13
either starts a server to build its database, or extends that existing hand-written DDL to
cover `organizations` as well. The second is the smaller change and keeps the suite hermetic,
at the cost of a copy of two framework tables in one test file, which T07 has already accepted
for one of them.

Resolution: 2026-09-06 — F8, B18, T12, T13 and T16 updated: seed only after the app has touched the database, or create the two org tables with the F6 DDL in hermetic tests.

## 2026-09-06 T11 — reading `SEED_PASSWORD` from `process.env` fails the framework's `no-env-credentials` guard

Expected (plan reference): `docs/plan/03-blueprint.md` B13 lists `SEED_PASSWORD` as an
environment variable per environment class, `.env.example` and `.dev.vars.example` already
name it, and `docs/plan/tasks/T11-seed.md` step 2 says "Password from `SEED_PASSWORD` (default
from B12)".

Observed: `agent-native doctor`'s `no-env-credentials` guard treats it as a user credential and
fails the Worker build, not just the doctor:

```
$ pnpm build:worker
[doctor] 1 finding(s) from `agent-native doctor` — fix them before the build can continue.
  [no-env-credentials] scripts/seed.mjs:389 — process.env.SEED_PASSWORD read — not a
  deploy-level allowlisted key. User credentials must be read via
  resolveCredential(key, { userEmail, orgId }), never process.env.
[doctor] Failing build: the doctor.failOnBuild gate is enabled (default: true).
```

`resolveCredential(key, { userEmail, orgId })` is the alternative the guard names, and it does
not apply: `scripts/seed.mjs` runs outside any request, so there is no `userEmail` or `orgId`
to resolve against, and the value is the password of the accounts the script is about to
create rather than a credential belonging to a user.

Impact: T11 step 2 and, because the gate runs inside `agent-native build`, the `pnpm
build:worker` half of step 4.

Proposed handling: the read carries the guard's own documented opt-out (F6/F10 record the
convention; `src/infrastructure/env.ts` and `server/plugins/00-env-check.ts` already use it for
the same reason) — `// guard:allow-env-credential — seed script's own configuration, never
logged`, on the line directly above the read, which is the only placement the guard accepts.
The password is never printed: `scripts/seed.mjs` logs step lines and HTTP statuses, never a
request body. Any later task that reads `SEED_PASSWORD` (T12's smoke, T16's Playwright
fixtures, T19/T20's workflows) needs the same marker.

Resolution: 2026-09-06 — Accepted; the guard opt-out marker is the documented mechanism for scripts outside a request.

## 2026-09-06 Review — authorization, guard enforcement and execution contracts

Expected: archive-customer stays admin-only across surfaces; import boundaries are enforced;
CI proves incremental progress; external retries reconcile accepted requests; production only
promotes successful staging.
Observed: a member could redo an admin archive; multiline imports escaped the regex; CI was
deferred; T16 requested an invalid transition; T20 never checked staging conclusion; B22 lost
recovery when a job was archived after vendor acceptance.
Resolution: maintainer explicitly authorized correction. Added shared history authorization
and role regression tests, AST import parsing with guard fixtures, initial CI, and D27. Updated
the affected task contracts for runtime proof, external reconciliation and promotion. T27 and
T20 implement their corrected contracts when those features are introduced.

## 2026-09-06 Review — minifier identifiers can contain `$`

Expected: both proxy patterns match once on core 0.176.5.
Observed: the real corrected build named the os thrower `$Ei`; `\w+` excluded `$`, so
`patch os-default-proxy: expected 1 match, found 0` stopped the build.
Resolution: match JavaScript identifier characters including `$`, keeping the exact proxy
shape and one-match requirement. Add executable fixtures for both proxies, missing/duplicate
patterns and throwing unknown APIs. Bind the idempotency marker to the bundle SHA-256 so a
stale marker cannot exempt a rebuilt bundle from patching.

## 2026-09-07 T12/T13 — isolated runtime checks and CLI result format

Observed: resetting Node SQLite does not initialize local D1; framework organization tables
are created only when the Worker first handles a request. The framework CLI at 0.176.5 prints
Node inspected objects, and failure messages without application error codes. Its tsx launcher
needs a local IPC socket, blocked in the restricted sandbox.
Resolution: the Worker verifier owns temporary D1 state, requests health before SQL seed,
registers users and tears down the whole process group. Integration setup has one database
lifecycle owner and reseeds between repository tests and CLI assertions. CLI checks inspect
actual result objects and nonzero status plus messages; direct use-case tests assert error
codes. The seed helper uses Node's tsx import hook without an unnecessary IPC listener.
Local SSE missing_credentials proves the runtime path, not model/tool execution.

## 2026-09-07 T27 — accounting intent and history must be serialized

Observed: recording pending export intent without changing job version allows undo to reopen
the completed job while an invoice is being accepted. Checking intent only before the write
leaves a race. Conditional batch statements also need to agree on whether a write succeeded.
Resolution: reopening history checks durable intent and its guarded repository commit requires
no accounting export; both the operation insertion and job update enforce this in SQL. Updates
are linked to the inserted operation. Activity hides unavailable Undo, and get-job exposes
accountingExportStatus so admins can retry pending exports after an archive. Reconciliation
preserves current fields. Tests cover response loss and intent appearing between read/write.

## 2026-09-07 Execution — shared implementation worktree

The maintainer requested continued implementation with Sol/Terra agents after the review
corrections were committed. Corrections are merged in PR #14. Bounded implementation slices
share task/implementation with non-overlapping file ownership; the coordinating agent reviews,
verifies and commits milestones. This replaces one branch per small task while preserving
review and acceptance evidence. Preparation may overlap, but integration remains gated by the
Worker/CLI proof before accounting/UI acceptance.

## 2026-09-07 T14 — `flatRoutes()` nests `jobs.$id.tsx` under `jobs.tsx`, so `/jobs/:id` served the list

Expected (plan reference): `docs/plan/tasks/T14-ui.md` step 1 and `docs/plan/03-blueprint.md`
B17 name the detail routes `app/routes/jobs.$id.tsx` and `app/routes/customers.$id.tsx`
alongside the list routes `jobs.tsx` and `customers.tsx`.

Observed: `app/routes.ts` is `flatRoutes()`, whose convention makes a dot-separated child a
**nested** route. The generated types are explicit:

```
$ cat .react-router/types/app/routes/+types/jobs.$id.ts
type Matches = [{ id: "root"; ... }, { id: "routes/jobs"; ... }, { id: "routes/jobs.$id"; ... }];
```

`jobs.tsx` is the list page and renders no `<Outlet />`, so `GET /jobs/job_in_progress`
rendered the **jobs list** with the URL unchanged. Every Playwright spec that opened a detail
page failed on a 30-second locator timeout, and `isolation.spec.ts` failed differently and
worse: an outsider at `/jobs/job_scheduled` saw their own organization's list instead of the
not-found state, so the spec could not observe the isolation it exists to prove (the server was
never wrong — `get-job` returned 404 throughout).

Impact: T14 step 1's two file names; the `/jobs/:id` and `/customers/:id` rows of B17; seven of
the twelve specs T16 delivers.

Proposed handling: renamed to `app/routes/jobs_.$id.tsx` and `app/routes/customers_.$id.tsx`.
The trailing underscore is the flat-routes opt-out from the parent layout and keeps the URL at
`/jobs/:id`. The alternative — `jobs.tsx` becomes an `<Outlet />` shell plus a new
`jobs._index.tsx` — adds a file and a layout the plan never asked for, for the same result.

Resolution: 2026-09-07 — B17 and T14 step 1 updated to the underscored file names, with the reason.

## 2026-09-07 T14 — route components rendered a second `main` inside the scaffold's `main`

Expected (plan reference): `docs/plan/03-blueprint.md` B17 ("The scaffold `Layout` with the
agent sidebar stays") and `docs/plan/tasks/T14-ui.md` step 2, neither of which says what
element a route component's root should be.

Observed: `app/components/layout/Layout.tsx` (scaffold) already wraps `{children}` in
`<main className="agent-native-app-main">`, and all five new route components opened with their
own `<main>`. The page therefore had nested `main` landmarks, and `locator("main")` in the
browser suite matched two elements, so a chained assertion could resolve to a filter
`<option>` in one `main` and a status badge in the other:

```
Error: strict mode violation: locator('main').getByText('In progress', { exact: true }) resolved to 2 elements:
    1) <option value="in_progress">In progress</option>
    2) <span class="...">In progress</span>
```

Impact: T14 step 2, plus the locators in five T16 specs.

Proposed handling: the five route components render `<div>` sections; a comment at the
`Layout` `main` says it is the document's only landmark. Status badges also carry a
`data-testid`, so the suite asserts on the badge rather than on a page-wide text match.

Resolution: 2026-09-07 — B17 and T14 step 2 updated: the scaffold layout owns the only `main`.

## 2026-09-07 T15 — the framework substitutes `{{name}}` only, so `{date}` reached the screen verbatim

Expected (plan reference): `docs/plan/02-framework-facts.md` F14 ("`useT()(key, params)`")
does not state the placeholder syntax, and `docs/plan/tasks/T15-i18n.md` step 2 only requires
"identical keys and placeholders" between the two catalogs.

Observed: `node_modules/@agent-native/core/dist/client/i18n.js:538` interpolates one form:

```js
return template.replace(/\{\{(\w+)\}\}/g, (_, name) => { ... });
```

Two app strings used a single brace — `jobs.scheduledFor: "Scheduled for {date}"` and
`jobs.accountingReference: "Accounting reference: {reference}"` — so the job detail page showed
the literal text `Scheduled for {date}`. The scaffold's own deleted catalog used `{{title}}`
throughout, which is where the correct form was visible all along; two of its accessible
labels (`chat.optionsFor`, `chat.renameThread`) had also lost their `{{title}}` in the rewrite
and read "Options for" for every thread.

Impact: T15 steps 1 and 2, and the guard in step 6, which compared both forms and so could
never catch it — two equally broken catalogs passed parity.

Proposed handling: all four strings use `{{name}}`. `scripts/check-i18n-catalogs.mjs` now
reports any single-brace placeholder by locale and key, with a regression fixture in
`tests/guards/i18n-catalogs.test.mjs` proving that two catalogs which agree on a broken
placeholder still fail.

Resolution: 2026-09-07 — F14 records the interpolation form; B17, T15 steps 1 and 6 updated.

## 2026-09-07 T15 — the `errors` group was missing `EXTERNAL`

Expected (plan reference): `docs/plan/tasks/T15-i18n.md` step 1 — "`errors` (one key per
`AppErrorCode`)".

Observed: `src/application/errors.ts` declares eight codes; both catalogs carried seven of
them plus the `UNKNOWN` fallback, and `EXTERNAL` was absent. `EXTERNAL` is the code B22's
accounting export returns when the vendor call does not confirm, so the one error a user is
most likely to have to act on rendered as the raw key. The guard's own `errors.` family list
had the same gap, so it agreed.

Impact: T15 step 1 and step 6.

Proposed handling: added `errors.EXTERNAL` to both catalogs, wording that says a retry
reconciles the request (B22 step 4), and added the code to the guard's `errors.` family with a
comment tying that list to `AppErrorCode`.

Resolution: 2026-09-07 — T15 step 1 updated to name all eight codes and the `UNKNOWN` fallback.

## 2026-09-07 T16 — a held-open SSE response is cancelled on Workers and kills `wrangler dev`

Expected (plan reference): `docs/plan/03-blueprint.md` B17 ("the framework's `useDbSync` also
refreshes") and `docs/plan/02-framework-facts.md` F9, which lists the endpoints verified on the
patched bundle and records no limit on streaming responses.

Observed: `app/root.tsx` mounts `useDbSync`, whose fast path is an `EventSource` on
`/_agent-native/events`; the framework serves it with `createEventStream(event).send()`
(`dist/server/sse.js`), a response held open with no pending I/O. The Workers runtime cancels
exactly that shape, and `wrangler dev` 4.129.0 treats the cancellation as fatal:

```
✘ [ERROR] Uncaught Error: The Workers runtime canceled this request because it detected that
  your Worker's code had hung and would never generate a response.
✘ [ERROR]
    at ProxyController2.emitErrorEvent (.../wrangler-dist/cli.js:200502:20)
    at ProxyController2.onProxyWorkerMessage (.../wrangler-dist/cli.js:200379:18)
```

The dev server then exits. Observed mid-suite as `page.goto: net::ERR_CONNECTION_REFUSED`
after a test had already passed its first assertions, which makes the browser suite flaky for
reasons that have nothing to do with the app.

Impact: T14 step 3 and B17's data-fetching paragraph; the stability of every T16 spec. It is
not confined to the local suite: a deployed Worker cannot hold that stream open either, so the
SSE path was never going to work on this runtime.

Proposed handling: `useDbSync({ ..., sseUrl: false })`, the framework's own documented switch
("Pass false to disable SSE and use polling only", `dist/client/use-db-sync.d.ts`), with a
comment naming the runtime reason. `/_agent-native/poll` is the transport the framework
describes for serverless and edge, and the UI still invalidates its own queries on every
mutation, so nothing about the product behaviour changes. Streams that produce data and finish
— `POST /_agent-native/agent-chat` — are unaffected and still verified by the smoke.

Resolution: 2026-09-07 — F9 records the cancellation and the wrangler-fatal behaviour; B17 records `sseUrl: false`.

## 2026-09-07 T16 — Playwright's teardown hangs on inherited stdio and SIGKILLs the server

Expected (plan reference): `docs/plan/tasks/T16-playwright.md` step 1 ("spawn `wrangler dev …`
(inherit stdio, keep the child) … forward SIGTERM/SIGINT to the child") and step 2's
`webServer` block, which sets no shutdown signal.

Observed: two separate faults, both at teardown.

1. With inherited stdio the detached Wrangler group holds the handles Playwright gave the
   server script. Playwright's web-server teardown waits for the process's stdout and stderr
   to close, so the run hung indefinitely after the last test with an orphaned `workerd` still
   on port 8787.
2. Playwright's default teardown is `SIGKILL`, which no handler can catch, so step 1's
   "forward SIGTERM/SIGINT" never ran at all.

A third, smaller fault surfaced once the server was allowed to exit on its own:
`terminateProcessGroup` probes `process.kill(-pid, 0)` and threw `Error: kill EPERM` from the
cleanup path after the launcher had exited and its pid had been recycled.

Impact: T16 steps 1 and 2; every local and CI run of the suite.

Proposed handling: Wrangler's stdio is `["ignore", "pipe", "pipe"]` and forwarded to the
script's own streams, so the pipes die with Wrangler and its output stays visible;
`playwright.config.ts` sets `gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 }` so the
handler runs; the handler and the `finally` share one `teardown()` that reports a failed
process-group stop and still removes the temporary state; and `groupExists()` treats `EPERM`
as "not ours" only once the launcher has exited, so a real failure to signal our own live
group still surfaces (the existing guard fixture for a sandbox without group signals still
skips as designed). Verified: `pnpm test:e2e` exits 0 and `pgrep -f "wrangler.js dev"`,
`pgrep -f workerd` and `lsof -nP -iTCP:8787 -sTCP:LISTEN` are all empty afterwards.

Resolution: 2026-09-07 — B18, T16 steps 1 and 2 updated with the stdio rule and the shutdown signal.

## 2026-09-07 T16 — the framework audit log outlives the scenario reset

Expected (plan reference): `docs/plan/tasks/T16-playwright.md` step 5 ("Give each mutating test
a fresh scenario") and `docs/plan/03-blueprint.md` B12, whose `buildScenarioResetSql()` covers
the application tables and the two organization tables.

Observed: `agent_audit_log` is framework-owned (F11) and is in neither list, so audit rows
accumulate across the whole run — including the rows the global setup's Worker smoke writes.
`parity.spec.ts` asserts that `job_in_progress` has exactly two `complete-job` rows and found
four, three of them left by `complete-job.spec.ts`, `undo.spec.ts` and `jobs-lifecycle.spec.ts`.
The assertion was correct; it was measuring the wrong population, and its result depended on
the order the suite happened to run in.

Impact: T16 step 5, and the audit assertions in `complete-job.spec.ts` and `parity.spec.ts`.

Proposed handling: the reset fixture (`tests/e2e/reset.ts`) prepends
`DELETE FROM agent_audit_log WHERE org_id IN ('org_acme', 'org_other')` to the scenario reset.
Org-scoped like every other reset statement, and kept in the end-to-end helper rather than in
`buildScenarioResetSql()`: B12's builders are the application scenario and are also used by the
seed script and the unit tests, none of which should be deleting framework rows.

Resolution: 2026-09-07 — B18 and T16 step 5 updated: the browser suite's reset also clears the org's audit rows.

## 2026-09-07 T14/T16 — verification the plan leaves manual, and two ambiguous accessible names

Expected (plan reference): `docs/plan/tasks/T14-ui.md` step 7 ("Verify manually … create a
customer, create a job for it, start, reschedule, complete, undo from the toast, redo from the
toast, archive … the member account does not see the archive-customer button") and step 4's
"Send to accounting" button, none of which T16's required spec list covers.

Observed: with the suite running against the built Worker, the parts of step 7 that a spec can
assert were left unasserted, and `app/routes/customers_.$id.tsx` had no coverage at all. Two
smaller findings came out of writing those specs: the customer dialog's inputs carried a
`placeholder` and no `aria-label` (unlike the job dialog's), which is both an accessibility gap
and unaddressable from a test; and creating a customer reported "Customer updated" because the
create and archive handlers shared one message.

Impact: T14 steps 4 and 7; T16 step 5's spec list.

Proposed handling: added `tests/e2e/customers.spec.ts` (a member creates a customer in the
dialog and opens its detail route) and `tests/e2e/accounting.spec.ts` (the export button is
hidden from a member; an admin confirms a dialog that states the action is irreversible; the
returned reference appears; the recorded operation is neither undoable nor redoable, and the
activity page renders no Undo for it). Added `aria-label` to the three customer inputs and a
`customers.created` message in both catalogs. The remaining manual parts of step 7 — the agent
answering "list my jobs", and the `de-DE` round trip of T15 step 5 — still need a person and a
provider key.

Resolution: 2026-09-07 — T16 step 5 lists the two added specs; T14 step 2 requires an `aria-label` on every control.

## 2026-09-07 T17/T18 — `pnpm eval` needs a wrapper, and CI runs the browser suite as its own job

Expected (plan reference): `docs/plan/03-blueprint.md` B15 (`eval` → `agent-native eval`),
`docs/plan/tasks/T18-ci.md` step 1 (the `worker` job builds, uploads, writes `.dev.vars` and
runs Playwright) and B20's matching paragraph.

Observed: two shapes the plan fixes could not be kept.

1. `agent-native eval` loads `evals/*.eval.ts` in a plain Node process, whose type stripping
   cannot resolve the extensionless imports the application layers use, so an eval that reaches
   a real use case fails to import. A model-backed run also needs a migrated and seeded
   database, which `agent-native eval` does not create.
2. Writing `.dev.vars` in CI has no effect on the browser suite: `scripts/e2e-server.mjs` runs
   Wrangler against a generated configuration in its own temporary directory and sets
   `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`, so the repository file is never read. Keeping
   the step would have implied a dependency that does not exist.

Impact: B15's `eval` row, T17 step 2, T18 step 1 and B20's `ci.yml` paragraph.

Proposed handling: `eval` runs `node scripts/run-evals.mjs`, which creates a temporary SQLite
database, applies `migrations/` and seeds the scenario **only** for `RUN_MODEL_EVALS=1`, sets
`NODE_OPTIONS=--import tsx`, and then delegates to `agent-native eval`; a skipped run therefore
still touches no database and exits 0. CI keeps `verify` and `worker` and adds a third `e2e`
job that downloads the `worker-bundle` artifact into `dist/`, installs Chromium and runs
`pnpm test:e2e`, uploading `playwright-report/` on failure — the bundle is built once (D21), the
`worker` job proves it boots with `pnpm verify:worker`, and no `.dev.vars` is written.

Resolution: 2026-09-07 — B15, B20, T17 step 2 and T18 step 1 updated to the delivered shapes.

## 2026-09-07 T14 — `home.tsx` stays the agent chat page

Expected (plan reference): `docs/plan/tasks/T14-ui.md` step 1 — "make `home.tsx` redirect to
`/jobs` and set the framework's `app.homePath` to `/jobs`".

Observed: the two halves of that sentence do the same job, and only the second one is safe.
`app/routes/chat.$threadId.tsx` is `export { default, meta } from "./home"`, and the scaffold
`Layout` treats `/home` as the chat route (its own toolbar, the full-screen chat surface, the
handoff from the sidebar) — a step 1 the plan also tells this task to keep. Turning `home.tsx`
into a redirect would delete the agent chat page and break `/chat/:threadId` with it.

Impact: T14 step 1 only.

Proposed handling: `app.homePath` is `/jobs` in
`server/plugins/agent-native-email-branding.ts`, so sign-in lands on the jobs list, and
`app/routes/_index.tsx` navigates `/` to `/jobs`. `/home` remains the chat page, reachable
only from the sidebar's Chat entry. The observable behaviour step 1 asks for — nobody lands on
`/home` by default — holds.

Resolution: 2026-09-07 — T14 step 1 updated: keep `home.tsx`, set `homePath`, redirect from `_index.tsx`.

## 2026-09-07 T14 — `useOrgRole` is imported from `@agent-native/core/client/org`

Expected (plan reference): `docs/plan/02-framework-facts.md` F4 lists
`@agent-native/core/client/org-team` as the import path for `OrgSwitcher`, `TeamPage`,
`useOrgRole` and `RequireActiveOrg`.

Observed: `node_modules/@agent-native/core/package.json` exports both `./client/org` and
`./client/org-team`, and the scaffold's own `app/routes/settings.tsx` — untouched by this task
— already imports `TeamPage` from `./client/org`. The app follows the scaffold.

Impact: F4's import table only; no behaviour.

Proposed handling: kept the shorter path the scaffold established and recorded both in F4,
together with the shape of `useOrgRole()`'s result (`canManageOrg`) that the role-aware UI uses.

Resolution: 2026-09-07 — F4 updated.

## 2026-09-07 T19/T20 — a staging workflow-run's `head_sha` is not promotion provenance

Expected (plan reference): `docs/plan/tasks/T20-deploy-production.md` step 1 resolved the
bundle to promote with `gh run view <staging_run_id> --json headSha -q .headSha`, and
`docs/plan/03-blueprint.md` B20 said to "verify `dist/BUILD_INFO.json.sha` equals the run's head
sha".

Observed: for a `workflow_run`-triggered run, the run's own `head_sha` describes the context the
workflow file was loaded from, not necessarily the commit the triggering CI run verified. Two
runs can therefore report the same `head_sha` while having deployed different commits, so a
promotion keyed on it can check out configuration and migrations from one commit and deploy a
bundle built from another. D27 requires the promotion to verify the artifact SHA and to check
out that SHA for migrations and configuration; `head_sha` cannot carry that guarantee on its
own.

Impact: T20 step 1's artifact-name and SHA-verification instructions, and the matching B20
paragraph.

Proposed handling: `deploy-staging.yml` proves the SHA once, at the moment it deploys — it
requires a completed, successful `ci.yml` run of this repository on `main` for that exact SHA
(`scripts/validate-ci-run.mjs`) and uploads an immutable `deployment-manifest` artifact
`{ repository, sha, sourceCiRunId }` (`scripts/write-deployment-manifest.mjs`).
`deploy-production.yml` promotes from that manifest: `scripts/validate-staging-run.mjs`
re-validates the staging run (workflow path, repository, branch, status, conclusion), the
manifest's repository and SHA, and that the manifest names the CI run that actually verified
that SHA, and only then is the SHA checked out and its `worker-bundle-<sha>` downloaded.
`scripts/verify-promotion-artifact.mjs` then requires `BUILD_INFO.json.sha`, `git rev-parse
HEAD` and the manifest SHA to agree, and `dist/_worker.js/PATCHED.json` to match the SHA-256 of
the downloaded `dist/_worker.js/index.js`, which also satisfies T20 step 2's "fail if
`PATCHED.json` is missing". T19 step 1, T20 step 1 and B20 were updated in the same change; the
decisions in D21 and D27 are unchanged.

Resolution: 2026-09-07 — implemented as described; the promotion validators are unit-tested in
`tests/guards/deployment-validation.test.mjs` (failed run, unrelated workflow, wrong branch,
wrong repository, incomplete run, wrong SHA, mismatched manifest, tampered bundle hash).

## 2026-09-07 T21 — the backup workflow needs its own environment, not `production`

Expected (plan reference): `docs/plan/03-blueprint.md` B20 said `backup-d1.yml` uses
`environment: production`, while `docs/plan/tasks/T21-backups.md` step 2 said
`environment: production-backup` (no required reviewers, account-scoped `D1 Read` token).

Observed: the two are mutually exclusive. The `production` environment carries required
reviewers (D21), and a required reviewer blocks a scheduled job until a human approves it, so a
nightly backup on `environment: production` would sit waiting for approval every night and the
schedule would never run unattended.

Impact: B20's backup paragraph.

Proposed handling: keep T21's `production-backup` environment, which is the newer and more
specific instruction, and correct B20 to name it. The two environments also separate
credentials: deployment needs Workers Scripts:Edit, D1:Edit and Workers Routes:Edit, while the
backup only needs account-scoped `D1 Read`.

Resolution: 2026-09-07 — B20 corrected in the same change; `docs/repository-settings.md` and
`docs/plan/notes-deployment.md` document both environments and the reason for the split.
(2026-09-08, T23: `notes-deployment.md` was folded into `docs/deployment.md` and deleted, as
T23 step 5 requires; `docs/deployment.md` and `docs/repository-settings.md` now carry it.)

## 2026-09-07 T19–T22 — the doctor's `no-env-credentials` guard fails the deployment scripts

Expected (plan reference): the T11 entry above established the `// guard:allow-env-credential —
reason` marker for scripts that read their own configuration from `process.env`, and noted that
"any later task that reads `SEED_PASSWORD` (T12's smoke, T16's Playwright fixtures, T19/T20's
workflows) needs the same marker".

Observed: the guard is not limited to credential-shaped names. `agent-native doctor` reported 19
findings for plain GitHub Actions metadata and runner file paths — `CI_RUN_JSON`,
`GITHUB_REPOSITORY`, `DEPLOY_SHA`, `GITHUB_OUTPUT`, `STAGING_RUN_ID`, `STAGING_RUN_JSON`,
`DEPLOYMENT_MANIFEST`, `ARTIFACT_DIR`, `STAGING_SHA`, `CHECKOUT_SHA`, `SOURCE_CI_RUN_ID` — and
because the gate runs inside `agent-native build`, it failed `pnpm check` *and*
`pnpm build:worker`, so T19's and T20's own dry-run acceptance could not be reached.

Impact: `scripts/validate-ci-run.mjs`, `scripts/validate-staging-run.mjs`,
`scripts/verify-promotion-artifact.mjs`, `scripts/write-deployment-manifest.mjs`.

Proposed handling: each read now names its value and why it is not a credential on the marker
line, and each script reads its environment once at the top so the markers sit next to the
reads. The guard only accepts a marker on the line directly above the read or trailing on the
same line, so a read wrapped across two lines by `oxfmt` is not covered — one read had to be
shortened to a single line to keep the marker adjacent.

Resolution: 2026-09-07 — `pnpm agent-native:doctor` reports "Clean — no findings"; `pnpm check`
and `pnpm build:worker` pass.

## 2026-09-07 T19–T22 — `actionlint` runs shellcheck over `run:` blocks

Expected (plan reference): `docs/plan/tasks/T19-deploy-staging.md` step 2 and
`docs/plan/tasks/T20-deploy-production.md` step 4 treat `npx actionlint@latest` as a workflow
schema check.

Observed: `actionlint` also runs shellcheck over every `run:` block and exits 1 on style
findings. Six findings failed the acceptance command: SC2129 (repeated `>> "$GITHUB_STEP_SUMMARY"`
redirects) in four steps, SC2155 (`local_var="$(cmd)"` masking the command's exit status) in the
step that reads the manifest's CI run id, and SC2016 on a summary line where a backtick had been
backslash-escaped inside single quotes — which would have written literal backslashes into the
job summary rather than a code span, so that finding was a real defect in the rollback
instructions.

Impact: T19 step 2 and T20 step 4 acceptance.

Proposed handling: summary and `$GITHUB_ENV` writes are grouped into a single
`{ …; } >> "$FILE"` block, the command substitution declares and assigns separately, and the
rollback guidance writes real fenced code blocks with the two commands (`wrangler rollback
<version-id> --env production` and, only when a migration corrupted data, `wrangler d1
time-travel restore`). No functional deployment behavior changed.

Resolution: 2026-09-07 — `actionlint .github/workflows/*.yml` exits 0.

## 2026-09-07 T21 — a local backup run would leave production rows in an untracked directory

Expected (plan reference): `docs/plan/tasks/T21-backups.md` step 1 defaults `BACKUP_DIR` to
`backups`, and `docs/plan/README.md` requires that no secrets or customer data are committed.

Observed: `backups/` was not in `.gitignore`, and `scripts/restore-d1-check.sh` writes its
report to `restore-report-<timestamp>.log` in the working directory. A maintainer running
`pnpm backup:d1` locally would end up with a full production dump — every customer row and
every user record — as an untracked file that `git add -A` would stage. (The report file was
already covered by the existing `*.log` rule.)

Impact: `.gitignore`.

Proposed handling: added `backups/` and an explicit `restore-report-*.log` rule with a comment
saying why. The GitHub workflow is unaffected: it points `BACKUP_DIR` at `$RUNNER_TEMP`.

Resolution: 2026-09-07 — `git check-ignore backups/ restore-report-x.log` matches both.

## 2026-09-08 T23/T24 — the Google redirect URI is the framework's own `/_agent-native/google/callback`

Expected (plan reference): `docs/plan/02-framework-facts.md` F7 — "Redirect URI is
`<APP_URL>/_agent-native/auth/ba/callback/google` — verify the exact path in
`docs/content/authentication.mdx` at implementation time and record it in
`docs/authentication-and-authorization.md`" — and `docs/plan/tasks/T24-bootstrap.md` step 3,
which asks for "the redirect URIs verified in
`node_modules/@agent-native/core/docs/content/authentication.mdx` and the framework's route
source".

Observed: the path F7 names is Better Auth's own social callback, mounted under
`/_agent-native/auth/ba` — but the sign-in page's Google button never goes there. It calls
`GET /_agent-native/google/auth-url` (`GOOGLE_AUTH_URL_PATH` in
`node_modules/@agent-native/core/dist/client/auth/AuthPage.js:14`), which `createAuthPlugin`
mounts whenever `GOOGLE_SIGN_IN_CLIENT_ID`/`_SECRET` are configured
(`dist/server/auth.js:3485-3500`), and that route builds the authorization URL with
`resolveOAuthRedirectUri(event)`, whose default path is `/_agent-native/google/callback`
(`dist/server/google-oauth.js:292`).

Verified at runtime rather than from the source alone. With
`GOOGLE_SIGN_IN_CLIENT_ID=verify-only.apps.googleusercontent.com` and a matching secret in
`.env`, on `pnpm dev`:

```
$ curl -s http://localhost:8080/_agent-native/google/auth-url
{"url":"https://accounts.google.com/o/oauth2/v2/auth?client_id=verify-only.apps.googleusercontent.com
 &redirect_uri=http%3A%2F%2Flocalhost%3A8080%2F_agent-native%2Fgoogle%2Fcallback
 &response_type=code&scope=openid+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email
 +https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile&access_type=online
 &prompt=select_account&state=…"}
```

Impact: T24 step 3 and T23's `docs/authentication-and-authorization.md`. Registering F7's path
in Google would produce `redirect_uri_mismatch` on the first production sign-in, with no other
symptom — the one bootstrap error that is invisible until a customer tries to log in.

Proposed handling: `docs/authentication-and-authorization.md`, `docs/bootstrap.md` and
`scripts/bootstrap.mjs`'s printed manual checklist all name
`<APP_URL>/_agent-native/google/callback`, and each of the two documents also gives the `curl`
above so a reader can re-verify it against their own build instead of trusting the document.
The Better Auth path is documented only where it belongs: as the callback shape a *second*
provider would need (`docs/authentication-and-authorization.md`, "Adding another provider"),
with the same instruction to verify it before registering it.

Resolution: 2026-09-08 — F7 corrected to `<APP_URL>/_agent-native/google/callback` for the
sign-in flow this app uses, with the verification command. T24 step 3 updated.

## 2026-09-08 T24 — the rename script's file list is incomplete, and `docs/**/*.md` would rewrite the plan

Expected (plan reference): `docs/plan/tasks/T24-bootstrap.md` step 1 — replace the two strings
"in `package.json` (`name`), `wrangler.jsonc`, `server/plugins/config.ts`,
`server/plugins/auth.ts`, `server/plugins/agent-chat.ts`, `README.md`, `docs/**/*.md`,
`scripts/*.mjs`, `scripts/*.sh`, `.github/workflows/*.yml`, `.bootstrap.env.example`" — with
the acceptance rule that "the rename diff must touch only the files listed in step 1".

Observed: that list is both too small and too large.

Too small — `rg -l 'example-jobs|Example Jobs'` over the tracked tree finds seven load-bearing
files the list omits: `app/lib/app-config.ts` (the browser bundle's app slug and title),
`app/root.tsx` (`configureTracking`'s app id), `server/plugins/agent-native-email-branding.ts`
(the app name and `homePath`), `server/routes/api/ready.get.ts` (a comment naming the local
database), `public/manifest.json` (the PWA name), `agent/AGENTS.md` (the *runtime agent's
system prompt*, which would keep telling the model it operates "Example Jobs"), and
`tests/e2e/reset.ts`. Leaving `app/lib/app-config.ts` at `example-jobs` also disagrees with
`server/plugins/config.ts`'s `app.id`, which the framework uses for credential scoping.

Too large — `docs/**/*.md` matches `docs/plan/**/*.md`, which is the implementation plan:
`01-decisions.md` D18 *states* that the sample Worker is named `example-jobs`, and
`DISCREPANCIES.md` quotes command output containing it. Rewriting those makes the record say
something that never happened.

Impact: T24 step 1 and its acceptance rule.

Proposed handling: `scripts/rename-app.mjs` walks the repository rather than a hand-written
list, rewrites only files that actually contain one of the two strings, and prints every one.
Excluded: `docs/plan/` (the historical record; T26 deletes it), `pnpm-lock.yaml`,
`tests/e2e/.auth/`, every generated or vendored tree, and `scripts/rename-app.mjs` itself —
whose own `FROM_NAME`/`FROM_DISPLAY` constants are what it searches for, so renaming them
would leave a script that can never be run again. `package.json`'s `name` is set as a field
rather than by string replacement, because it currently holds
`agent-native-cloudflare-starter` and the string replacement would never reach it.
The acceptance rule becomes "the diff touches only files that contained one of the two
strings, and the script printed all of them", which is checkable rather than a list to
maintain.

Resolution: 2026-09-08 — T24 step 1 and its acceptance rewritten to the scan-driven rule with
the exclusions and the reasons.

## 2026-09-08 T24 — the JSON bodies reach `gh api` on stdin, not through a temporary file

Expected (plan reference): `docs/plan/tasks/T24-bootstrap.md` step 0.7 — branch protection with
"a JSON body from a temporary file".

Observed: `gh api --input -` reads the request body from standard input (`gh api --help`:
"a request body may be read from file specified by `--input`. Use `-` to read from standard
input"), which is strictly better here for three reasons. It matches the rule the same step
sets two paragraphs later — "secret values are passed only through stdin or the child
environment" — so there is one channel for every body instead of two. It removes a file that
has to be created, chmod-considered and cleaned up on every exit path, including the refusal
paths. And it lets `tests/guards/bootstrap.test.mjs` assert the **exact** body: the stub logs
its stdin, whereas a temporary file is gone by the time the assertions run.

Impact: T24 step 0.5 and 0.7 (the environment bodies and the protection body).

Proposed handling: both use
`gh api --method PUT <endpoint> --input -` with the body on stdin. The guard test asserts the
argument array and the byte-exact JSON for the staging environment, the production environment
with resolved reviewer ids, and branch protection.

Resolution: 2026-09-08 — T24 steps 0.5 and 0.7 updated; the "temporary file" wording removed.

## 2026-09-08 T24 — `wrangler d1 create` does not report the new database id in a machine-readable form

Expected (plan reference): `docs/plan/tasks/T24-bootstrap.md` step 0.2 — "`wrangler d1 create
<APP_NAME>-<env> --jurisdiction eu` unless `wrangler d1 list --json` already lists it; write
the `database_id` into `env.<env>.d1_databases[0].database_id`".

Observed: `pnpm exec wrangler d1 create --help` on 4.129.0 offers `--location`,
`--jurisdiction`, `--use-remote`, `--update-config` and `--binding`, and **no `--json`**. Its
output is a human-readable block. `wrangler d1 list --json` is the only machine-readable source
of a database's `uuid`, so the step's own "unless already listed" probe is also the way to
learn the id of a database it just created.

Impact: T24 step 0.2 only.

Proposed handling: after a successful `d1 create`, `scripts/bootstrap.mjs` re-runs
`wrangler d1 list --json` and reads the `uuid` of the entry whose `name` matches; it refuses
with `created <name> but 'wrangler d1 list --json' does not report its id` rather than writing
a guess. `--update-config` was not used: it would let Wrangler rewrite `wrangler.jsonc` in a
shape we do not control, and the whole point of the in-place text edit is that the file's
comments and per-environment structure survive.

Resolution: 2026-09-08 — F10 gains the note that `d1 create` has no `--json`; T24 step 0.2
records the second `d1 list` call.

## 2026-09-08 T24 — `INSERT OR IGNORE` with a generated organization id is not idempotent

Expected (plan reference): `docs/plan/tasks/T24-bootstrap.md` step 2 — `scripts/bootstrap-org.mjs`
inserts the organization and its owner membership "with every NOT NULL column from F6 and
`node_modules/@agent-native/core/dist/org/migrations.js` (epoch-millisecond timestamps,
generated ids); … idempotent (`INSERT OR IGNORE`)".

Observed: those two requirements contradict each other for `organizations`. Its only unique
constraint is the primary key, so `INSERT OR IGNORE` with a freshly generated id never
conflicts and a second run creates a *second* organization with the same name — after which
the owner has two memberships and the framework's active-organization resolution picks one
arbitrarily. `org_members` is fine either way: `UNIQUE(org_id, email)` makes its
`INSERT OR IGNORE` genuinely idempotent once `org_id` is stable.

Impact: T24 step 2.

Proposed handling: the organization id is derived from its name — `org_` plus a lowercased,
non-alphanumerics-to-underscore slug, capped at 40 characters — so the primary key is the
idempotency key and a re-run inserts nothing. `--id` overrides it. This also matches the
repository's own convention: the seed scenario's organizations are `org_acme` and `org_other`
(B12), not nanoids. The member id stays generated, guarded by the unique index.

Verified against a local D1 with the two framework tables created from the F6 DDL, in an
isolated `--persist-to` directory:

```
$ wrangler d1 execute … --command "<the script's SQL>"     # first run
$ wrangler d1 execute … --command "<the script's SQL>"     # second run
$ wrangler d1 execute … --json --command "SELECT id, name, created_by FROM organizations; SELECT org_id, email, role FROM org_members"
[{"results":[{"id":"org_acme_services","name":"Acme Services","created_by":"owner@example.invalid",…}],…},
 {"results":[{"org_id":"org_acme_services","email":"owner@example.invalid","role":"owner"}],…}]
```

One organization row and one membership row after two runs. The same check proved that
`wrangler d1 execute --command` accepts the two `;`-separated statements the script sends.

Resolution: 2026-09-08 — T24 step 2 records the derived id and why; `--dry-run` added so the
SQL can be inspected, and re-verified, without a remote call.

## 2026-09-08 T24 — the framework's own `POST /_agent-native/org` also creates an organization

Expected (plan reference): `docs/plan/tasks/T24-bootstrap.md` step 2 specifies SQL through
`wrangler d1 execute --remote` as the way to create the first organization.

Observed: the framework exposes `POST /_agent-native/org` (`dist/org/plugin.js:14`,
`createOrgHandler` in `dist/org/handlers.js:203`), which calls `createOrganization(name, email)`
— and that does two things the SQL does not: it generates the per-organization `a2a_secret`,
and it writes the caller's `active-org-id` user setting (`dist/org/context.js:403-422`).

Impact: none on the delivered behaviour, but the difference is worth writing down so nobody
later "fixes" the script by adding those columns by hand.

Proposed handling: kept the SQL script the task specifies, because the state a freshly deployed
environment is actually in is "nobody has a browser session yet", and recorded in the script's
own header comment why the two omitted columns are correct to omit: `a2a_secret` is the
cross-app delegation secret and this starter configures no A2A surface (D24), and
`active-org-id` is unnecessary with one membership — the framework resolves the active
organization from the membership itself (F6). `docs/bootstrap.md` step 14 uses the script.

Resolution: 2026-09-08 — Accepted; recorded in `scripts/bootstrap-org.mjs`'s header.

## 2026-09-08 T23 — `agent-native typecheck` prints production configuration errors and exits 0

Expected (plan reference): `docs/plan/03-blueprint.md` B15 — `typecheck` is
`agent-native typecheck`, and `pnpm check` runs it — with the standing rule that `pnpm check`
passes.

Observed: on every run, in every tree, `pnpm typecheck` prints two blocks of
`[agent-native] production configuration errors: - ERROR: BETTER_AUTH_SECRET is not set for
production …` (once for phase `build`, once for phase `runtime`), each followed by a
"Copy the prompt below to an AI coding agent" paragraph — and then **exits 0**. Confirmed
pre-existing and unrelated to this task by stashing every change and running it on
`origin/main` (`d03f3b1`), which prints the same thing.

The framework is evaluating its production configuration statically and there is no
`BETTER_AUTH_SECRET` in a developer's environment, which is correct: it is a Worker secret set
per environment with `wrangler secret put` (B14) and is deliberately absent locally.

Impact: none functional. It is 20 lines of alarming output in the middle of every `pnpm check`,
including the acceptance transcript every pull request pastes, and it invites somebody to
"fix" it by putting a production secret somewhere it must not be.

Proposed handling: left alone, and recorded here so it is known to be expected. Setting
`BETTER_AUTH_SECRET` in `.env` silences it locally and is harmless (`.env` is git-ignored and
the value is not the production one), but it must never be added to `.env.example`, to
`wrangler.jsonc` `vars` or to any committed file — `scripts/check-config-hygiene.mjs` fails the
build if it is.

Resolution: 2026-09-08 — Accepted; noted for T26's report so the noise is not mistaken for a
finding.

## 2026-09-08 T23 — a timing-sensitive guard assertion became flaky once a parallel test file was added

Expected (plan reference): `docs/plan/tasks/T12-worker-smoke.md` and the entry
*2026-09-07 T16 — Playwright's teardown hangs on inherited stdio* established
`terminateProcessGroup` and its guard fixtures; `pnpm test:guards` is part of `pnpm check` and
must pass.

Observed: adding `tests/guards/bootstrap.test.mjs` — twelve cases, each spawning several stub
subprocesses — made an existing assertion in `tests/guards/worker-smoke.test.mjs` fail
intermittently. `node --test tests/guards/*.test.mjs` runs files in parallel, so the new file
loads the machine while the old one measures a deadline:

```
✖ process-group teardown kills a child after its launcher exits
  AssertionError: Missing expected exception.
  expected: { code: 'ESRCH' }
```

The assertion was `assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" })`
immediately after `await terminateProcessGroup(launcher, 100)`. `terminateProcessGroup` waits
for the process *group* to disappear; the child this test watches is reparented to init when
its launcher exits, and is reaped a moment later. The test was asserting on kernel bookkeeping
that had not finished, not on whether the child had been terminated. Ran clean in isolation
three times out of three, which is exactly the signature of a load-dependent race.

Impact: `pnpm check` and CI's `verify` job, intermittently, for reasons unrelated to whatever
is being changed.

Proposed handling: the assertion polls. `waitForNoSuchProcess(pid, 5_000)` waits for `ESRCH`
at 25 ms intervals and `assert.fail`s with the pid and the timeout when the deadline passes, so
a process that genuinely survives still fails the test — the property under test is unchanged,
only the moment it is measured. Four consecutive `pnpm test:guards` runs pass.

Resolution: 2026-09-08 — fixed in `tests/guards/worker-smoke.test.mjs`; the reason is recorded
in a comment at the assertion so it is not "simplified" back.

## 2026-09-08 T24 — a rename changes where `oxfmt` breaks a line, so the script has to reformat what it rewrote

Expected (plan reference): `docs/plan/tasks/T24-bootstrap.md` step 1 and its acceptance —
"`pnpm check` must still pass on the renamed tree before reverting".

Observed: it did not. Replacing `example-jobs` with a shorter name shortens the lines that
contain it, and `oxfmt` 0.66.0 has an opinion about where a call breaks. After
`node scripts/rename-app.mjs --name acme-ops --display "Acme Ops"`:

```
$ pnpm check
scripts/verify-worker.mjs (0ms)
Format issues found in above 1 files. Run without `--check` to fix.
```

The offending line was `mkdtempSync(path.join(tmpdir(), "example-jobs-worker-smoke-"))`, which
oxfmt had wrapped across three lines at 80 characters and which fits on one as
`"acme-ops-worker-smoke-"`. A longer display name has the same effect in the other direction.
This is the same collision `2026-09-06 T06 — a naively generated migrations-manifest.ts fails
oxfmt --check` recorded: a generator writing valid TypeScript that the repository's own
formatter then disagrees with.

Impact: T24 step 1's acceptance, for any name whose length differs from `example-jobs`'s —
which is every real name.

Proposed handling: the same resolution T06 chose, for the same reason. `scripts/rename-app.mjs`
runs the repository's own `node_modules/.bin/oxfmt --write` over the files it rewrote, rather
than duplicating oxfmt's line-breaking rule, and reports how many it reformatted. It reads
`ignorePatterns` out of `.oxfmtrc.json` instead of hard-coding it, so a file oxfmt does not own
— anything under `docs/`, for instance — is never handed to it, and it filters to the
extensions oxfmt formats (`.sh` is not one). A production-only install has no oxfmt; the
rewritten files are then left as they are and the script says it reformatted none.

Verified: `pnpm check` exits 0 on the renamed tree, and the diff touches only the 24 files that
contained one of the two strings.

Resolution: 2026-09-08 — T24 step 1 records the reformatting step and why.

## 2026-09-08 T25 — adding a framework locale is a repo-wide change upstream, not a five-file edit

Expected (plan reference): `docs/plan/02-framework-facts.md` F14 and
`docs/plan/tasks/T25-norwegian-upstream.md` steps 2–3 describe adding a locale as: extend
`SUPPORTED_LOCALES` and `LOCALE_METADATA` in `dist/localization/shared.js`, add
`core-messages/<code>.ts`, register the loader in `coreMessageLoaders`, and update the
`internationalization.mdx` locale list. Step 2 says explicitly "do not add template catalogs; the
framework's own UI catalog is enough for a first PR unless the repository's guard requires template
parity — check `pnpm guard:i18n-catalogs` output".

Observed: on `upstream/main` at `8a33f82a0` (`@agent-native/core` 0.177.0), the guard indeed does
not require template catalogs — `checkCatalogDir` in `scripts/guard-i18n-catalogs.ts` only compares
locale files that exist. `pnpm typecheck` is the real gate, and it fails much more widely:

- Inside `packages/core`, nine further maps are exhaustive over `LocaleCode` and each needs an
  `nb-NO` entry: `MCP_CONNECT_MESSAGES` and `MCP_SETTINGS_MESSAGES`
  (`src/localization/mcp-settings-messages.ts:44,556`), `AUTH_LOCALE_COPY`
  (`src/server/onboarding-html.ts:238`, ~96 keys), `NATIVE_AUTH_COPY`
  (`src/shared/auth-copy.ts:46`), `LANGUAGE_PICKER_COPY` (`src/client/i18n.tsx:161`), `errorCopy`
  (`src/client/ErrorBoundary.tsx:27`), `FEEDBACK_COPY` (`src/client/FeedbackButton.tsx:40`),
  `BLOCK_COPY` (`src/client/blocks/library/block-copy.ts:7`) and `EXTENSIONS_COPY`
  (`src/client/extensions/ExtensionsSidebarSection.tsx:123`).
- Two core unit tests demand more than the catalog: `src/server/auth-marketing-locales.spec.ts`
  requires a tagline plus a matching number of feature bullets for all sixteen built-in marketing
  surfaces in every non-English locale, and `src/shared/mcp-connect-content.spec.ts` requires all
  seven MCP connect guides to be translated with placeholders preserved.
- After rebuilding core so templates see the widened union, `pnpm typecheck` reported 65 errors in
  ten templates plus `packages/docs`. The cause is that nine templates assert their catalog
  aggregates exhaustively (`} satisfies Record<LocaleCode, Messages>;` in
  `templates/*/app/i18n-data.ts`, plus variants over `Exclude<LocaleCode, "en-US">`). Satisfying
  those assertions would mean translating every first-party template app in the same change;
  `templates/design/app/i18n-data.ts` alone is about 16 800 lines.
- `guard:i18n-catalogs` also walks `SUPPORTED_LOCALES` for localized documentation coverage, so a
  brand-new locale produces 201 coverage findings (one per English doc under
  `packages/core/docs/content`). The guard's own sanctioned mechanism for reviewed debt is
  `UPDATE_I18N_DOC_COVERAGE_BASELINE=1`; the other ten locales each already carry 65–66 such rows.

Impact: T25 steps 2–4. F14's "closed locale list" bullet understates the coupling; the upstream
branch is much larger than the plan assumed, and the "no template catalogs" instruction only holds
if the template maps stop asserting exhaustiveness.

Proposed handling: the fork branch keeps the plan's intent — real Norwegian translations for the
framework's own UI, no machine-translated template catalogs — and additionally relaxes the template
and docs-site maps to `Partial<Record<LocaleCode, …>>` (kept as `satisfies`, so every present
locale stays exactly typed) with the locale-keyed override loops reading through a `Partial` view.
That makes the existing `if (!messages) continue` fallbacks type-checked instead of resolving to
`any`, and means a supported locale a template has no catalog for falls back to its source locale
rather than blocking the framework's locale list. The 201 docs-coverage rows were added to
`scripts/i18n-localized-doc-coverage-baseline.txt` with the reason stated in the changeset and in
`docs/plan/upstream-issues/nb-NO-pr.md`; no other locale's rows changed. The review document flags
the template type change as separable so the maintainer can ask for it as its own upstream PR. No
change to this repository's product scope, security policy or deployment architecture.

Resolution: 2026-09-08 — on the fork branch `pnpm fmt:check`, `pnpm typecheck` and `pnpm guards`
(70 checks) all pass, and the twelve core locale suites (146 tests) pass. `F14` is updated to
record the full coupling for the next reader.

## 2026-09-08 T25 — upstream `main` is ahead of the pinned framework version

Expected (plan reference): `docs/plan/02-framework-facts.md` records verified facts about
Agent-Native 0.176.5, which `package.json` pins.

Observed: `upstream/main` at `8a33f82a0` builds `@agent-native/core` 0.177.0. The i18n mechanism
itself is unchanged between the two — `SUPPORTED_LOCALES`, `LOCALE_METADATA`, the
`core-messages/<code>.ts` catalogs, `coreMessageLoaders`, the `{ code, englishName, nativeName,
dir }` metadata shape and `set-localization-preference` deriving its validation from
`SUPPORTED_LOCALES` all match F14 exactly. What F14 did not record is the additional
`Record<LocaleCode, …>` maps and locale-coverage tests listed in the entry above; those exist in
0.176.5 too.

Impact: none on the starter's pin. T25 based its branch on upstream `main`, as instructed.

Proposed handling: no version change in this repository. F14 gains a note that the locale list is
coupled to more than the four places it named, so a future upgrade or a second upstream attempt
starts from the real inventory.

Resolution: 2026-09-08 — F14 updated; the pin stays at 0.176.5 until the locale ships in a release
(see `docs/plan/upstream-issues/nb-NO-pr.md`).

## 2026-09-08 T24 follow-up — a `--json` eval run wrote an unparseable artifact

Expected (plan reference): `docs/plan/03-blueprint.md` B12 and `evals/README.md` make
`agent-native eval --json` the machine-readable report, and `docs/upgrade-playbook.md` step 10
asks for the model-backed run to be recorded as release evidence. The obvious way to record it is
to redirect that report to a file.

Observed: `RUN_MODEL_EVALS=1 pnpm eval -- --json > eval-evidence.json` produces a file that no
JSON parser accepts. Two writers share the stream:

1. `scripts/run-evals.mjs` spawns the migration and seed steps with `stdio: "inherit"`, so their
   own progress lines (`applied 0001_init.sql`, `applied 0002_job_accounting.sql`) land on stdout
   ahead of the document. These run only under `RUN_MODEL_EVALS=1`, which is why a skipped run
   looks clean and the defect was invisible until the first real run.
2. pnpm writes `[ELIFECYCLE] Command failed with exit code 1.` to **stdout**, not stderr, when a
   `pnpm run` script exits non-zero — so it appends a line after the closing brace on exactly the
   runs whose evidence matters most. Its `$ node scripts/run-evals.mjs` banner goes to stderr, and
   a passing run is unaffected.

Impact: the one release criterion `FINAL-REPORT.md` §4.7 leaves open cannot be recorded by the
documented command. Nothing about the evals themselves is wrong; the report content was correct
inside the corrupted envelope.

Proposed handling: (1) route the preparation steps' stdout to fd 2 in `scripts/run-evals.mjs`, so
only `agent-native eval` writes to stdout; (2) document `node scripts/run-evals.mjs --json` rather
than `pnpm eval -- --json` for the artifact, since pnpm's epilogue cannot be suppressed from
inside the script; (3) add `tests/guards/eval-json.test.mjs`, which runs the model-backed path with
every provider credential stripped from the child environment — `resolveEngine` then refuses before
any request, so the guard exercises migration, seeding and `--json` without a paid call — and
asserts stdout parses, all five evals ran, and the `applied …` lines moved to stderr; (4) ignore
`eval-evidence*.json` and add it to the `check-config-hygiene.mjs` must-stay-ignored list, because
the report carries prompts, model output and provider request ids and this repository is public.

Resolution: 2026-09-08 — all four applied. The guard fails on the pre-fix script with `stdout is
not a single JSON document` and passes after, in ~7s with no network access.

## 2026-09-08 T24 follow-up — `agent-native eval` evaluates an agent with no system prompt

Expected (plan reference): `docs/plan/03-blueprint.md` B12 and `docs/upgrade-playbook.md` step 10
treat `pnpm eval` as the release gate on model behaviour, and D20 makes
`agent-native.config.ts` `instructions.runtime` (`agent/AGENTS.md`) the deployed agent's system
prompt.

Observed: the first funded model-backed run failed all five evals identically, with the model never
consulted:

```
400 invalid_request_error — system.0: cache_control cannot be set for empty text blocks
```

Three framework defaults compose to produce it. `dist/cli/eval.js` calls `runEvalSuite({ cwd,
pattern, thresholdOverride })` without `systemPrompt`, though `RunEvalSuiteOptions` accepts one;
`dist/eval/agent-runner.js` defaults it to `""`; and `dist/agent/engine/anthropic-engine.js` sets
`cache_control` on `systemBlocks[0]` unconditionally when caching is on, which for an empty prompt
is `cache_control` on an empty text block. The API rejects it.

Impact: worse than a failed gate. `agent-native eval` cannot evaluate any Anthropic-backed app at
0.176.5, and even with the 400 fixed it would score an agent this repository does not ship — tool
choice, the `send-job-to-accounting` approval gate and the member denial all live in the runtime
instructions. The vacuous scorers make the failure look partial: `no-mutations` and
`persisted-state` scored 1 because nothing ran, so two evals reported `avgScore: 0.333`.

Proposed handling: `scripts/eval-suite.ts` calls `runEvalSuite` directly with `systemPrompt` read
from `instructions.runtime`, refusing with a named file rather than sending an empty prompt, and
mirrors the CLI's arguments, output shape and exit codes (including `total === 0` exiting 0 so an
app without evals does not fail CI). `scripts/run-evals.mjs` invokes it instead of
`agent-native eval`. `tests/guards/eval-json.test.mjs` gains the invariant that the resolved
instructions file is non-empty, since an empty one is the sole input that reproduces the 400.
Drafted upstream as `docs/plan/upstream-issues/eval-system-prompt.md` with both fixes described:
the engine should not cache an empty block, and the CLI should pass the app's own instructions.

Resolution: 2026-09-08 — applied; `pnpm check` passes with 43 guard tests. The 400 itself is
reproduced and diagnosed from the framework source, but the fix is confirmed only as far as a
credential-free run can go: the paid run that proves the model now receives the prompt is the
maintainer's, and until it is green the release evidence stays pending.

## 2026-09-08 T24 follow-up — the first real eval results: three failures, three different causes

Expected (plan reference): B12's five evals are the release gate on model behaviour, and
`agent/AGENTS.md` (D20) is the agent's contract.

Observed: with the system prompt supplied (previous entry), the agent ran for the first time and
two evals passed outright — `complete-job` and `undo` at 1.0 on every scorer. The other three
failed for three unrelated reasons, none of which is the model behaving badly:

1. **`accounting-approval` — the instructions defeated the framework's approval gate.** Rule 4
   said "always ask before `send-job-to-accounting` … wait for a clear yes", so the agent asked in
   the conversation and never called the action. But `needsApproval: true` *is* the approval
   mechanism: `production-agent.ts` intercepts the call, performs no side effect, and returns
   "Awaiting human approval to run … a human must approve this specific call before it can run."
   The human then approves that call with its arguments. Asking in prose approves a sentence
   instead, and the export never happens — so this was a production-behaviour defect, not an eval
   artefact. Rule 4 is split: archiving still asks first; `send-job-to-accounting` is now
   "approved by calling it, not by asking first", with the pause reported and no retry.
2. **`member-denial` — the eval scored the wrong thing.** Its prompt was a bare "Archive customer
   cus_b.", which rule 4 legitimately answers with a question, so a compliant agent never reached
   the authorization check the eval exists to prove. The eval now seeds the confirmation exchange
   in `input.history`, leaving the denial as the only thing under test.
3. **`list-today` — the eval harness is not the deployed agent.** `production-agent.ts` prepends
   `buildRuntimeContextPrompt`'s `<runtime-context>` block (current date, and "use this as
   authoritative for relative dates such as today") and injects a per-turn `<current-time>` block
   into the user message. `createAgentRunner` passes the system prompt through untouched, so the
   evaluated agent had no idea what "today" was — while rule 3 forbids inventing dates. It spent
   30s and never called `list-jobs`. `scripts/eval-suite.ts` now appends that block, pinned to
   `FIXTURE_CLOCK` (exported from the scenario, previously only named in a comment) so a
   date-relative eval is reproducible rather than dependent on the day it runs; `EVAL_NOW`
   overrides it. The block is reproduced in the driver because `runtime-context` is not in the
   framework's export map — a deep import is refused with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

Two further observations from the same run. The app's own action log (`logAction`, B16) writes one
JSON line per action call to **stdout**, so it corrupted the artifact exactly as the migration
lines had — a third writer on the same stream, and one that `--out` could not have escaped either,
since it captures the child's stdout. The driver now owns stdout: `console.log` is redirected to
stderr and the report is written with `process.stdout.write`. And an `EvalResultRow` keeps only
names and numbers, so "Agent never called `list-jobs`" was the entire diagnosis available for a
paid run; the helper scorers now attach a `generateReason` trace naming the tools actually called,
the target action's result and what the agent said.

The `unknown format "date-time" ignored in schema` warnings are harmless: they are on stderr, and
`list-jobs`'s `from`/`to` already carry "ISO 8601 instant" in `.describe()`, so the model is not
relying on the dropped `format` keyword.

Impact: one production-behaviour defect fixed (the approval gate was unreachable as instructed),
one eval corrected to test its own subject, one harness fidelity gap closed, one artifact stream
cleaned.

Proposed handling: as described; `docs/plan/upstream-issues/eval-system-prompt.md` gains the
prompt-assembly half — `agent-native eval` should assemble the prompt the app deploys, runtime
context included, or export `runtime-context` so a caller can.

Resolution: 2026-09-08 — applied; `pnpm check` passes with 43 guard tests. The five evals' own
outcome after these changes needs another funded run: `complete-job` and `undo` are confirmed
green, and the other three are corrected but unproven.

## 2026-09-08 T24 follow-up — release evidence produced: 5/5

Expected (plan reference): D27 and `docs/upgrade-playbook.md` step 10 require a model-backed eval
run as release evidence; `FINAL-REPORT.md` §4.7 recorded it as the one open release criterion.

Observed: after the three fixes in the entries above, the maintainer's funded run on
`claude-sonnet-5` returned `ok: true` — 5 total, 5 passed, 0 failed, 0 skipped, every scorer 1. The
artifact came out as parseable JSON through `--out`, confirming the stream fixes on a real run
(three writers had shared stdout: the migration steps, pnpm's epilogue and the app's own action
log).

What the traces show, beyond the scores: `send-job-to-accounting` was **called** and the side
effect withheld with "Awaiting human approval … did NOT execute", which is the behaviour rule 5 of
`agent/AGENTS.md` now asks for and the opposite of what the pre-fix instructions produced;
`archive-customer` was attempted and refused with
`Role member may not customers:archive (errorCode: AUTHORIZATION)`, and the agent explained the
role requirement rather than retrying; `list-jobs` answered "no jobs are scheduled for today,
September 6, 2026" — the pinned `FIXTURE_CLOCK` date, resolved to an explicit calendar date, with
an empty array and no mutating call.

Impact: the release criterion is closed, and the definition-of-done line on agent parity loses its
caveat: the agent half is no longer structural. The tally stays 16 of 17 met with 1 pending on the
`is_template` setting, but with 7 caveats rather than 8.

One residual wrinkle, recorded rather than fixed: the evals pin the agent's `<runtime-context>`
date to `FIXTURE_CLOCK` while the application's own timestamps come from the real clock, so a
transcript can show a `completedAt` that disagrees with the agent's notion of "today". It does not
affect any assertion. Injecting the clock through the container would remove it, if determinism
there ever matters.

Resolution: 2026-09-08 — `FINAL-REPORT.md` §4.7, follow-up 15, risk 1 and the definition-of-done
table updated with the run and the five recorded behaviours. Re-run after any change to
`agent/AGENTS.md`, the action descriptions or the framework pin: a model update can change the
result with no change to this repository, so a stale eval result is no result.

## 2026-09-09 Quick start — `pnpm dev` served a blank page on a cold dependency cache

Expected (plan reference): `README.md`'s quick start ends with `pnpm dev` and
`http://localhost:8080`. B18 and the template's whole premise require that first load to work.

Observed: on a cold or invalidated Vite dependency cache the first page load is **blank** — empty
`<body>`, and eight `504 (Outdated Optimize Dep)` in the console. A manual reload fixes it, so it
survived every previous verification: T26's fresh-clone run recorded `pnpm dev` as HTTP 200, which
it is, and the browser suite reloads as a matter of course. It was reported by the maintainer
using the documented steps.

Cause, from the dev server log:

```
[vite] (client) Re-optimizing dependencies because vite config has changed
[optimizer] bundling dependencies...
✨ new dependencies optimized: @agent-native/core/client/agent-chat, … @agent-native/toolkit/utils   (40 entries)
✨ optimized dependencies changed. reloading
[agent-native] Vite optimized deps changed while loading /node_modules/.vite/deps/@agent-native_core_client_i18n.js; reloading the page.
```

React Router has no `index.html`, so Vite's dependency scanner never reaches `app/root.tsx` — and
root.tsx is where those forty framework client subpaths are statically imported. They were
therefore discovered only when the browser requested the client entry, mid-load: the optimizer
re-bundled, every in-flight request answered 504, and the framework's own recovery reload landed on
a page whose module graph had already failed. `optimizeDeps.holdUntilCrawlEnd` is on by default and
cannot help, because the crawl it waits for never saw the imports.

`optimizeDeps.ignoreOutdatedRequests` would have silenced the 504s and was rejected: it is
documented to give "a single module multiple reference", which is the exact class of breakage the
`resolve.dedupe` and `@assistant-ui/*` aliases in `vite.config.ts` exist to prevent.

Proposed handling: `server.warmup.clientFiles` for `app/entry.client.tsx`, `app/root.tsx` and
`app/routes/*.tsx`, so discovery runs at server start, before a browser request exists to
invalidate. Dev-only; the build is untouched.

Resolution: 2026-09-09 — applied and verified against a cleared `node_modules/.vite/deps`: zero
`optimized dependencies changed. reloading` lines in the server log, and a first load in a fresh
browser tab that renders the sign-in page with no 504 at all (only the expected unauthenticated
401s). `pnpm build:worker` still produces 3.87 MiB gzip with both patches matched.

Separately, and reported in the same message: `pnpm dev:worker` presented a sign-in page that
rejected every password. The cause was an unseeded database, not a wrong one — the Worker's local
D1 held 0 users while the Node database held 5, because `pnpm db:seed` seeds only the Node runtime
and `pnpm db:seed:worker` only the Worker's D1. All three `SEED_PASSWORD` values (`.env`,
`.dev.vars`, the scenario default) were verified identical, so the password was never involved. The
README documented both commands but never said they address different databases; it now states
that, and gives the one-line `wrangler d1 execute … SELECT count(*) FROM user` that distinguishes
"unseeded" from "wrong password" in a case where the UI cannot.

## 2026-09-11 `pnpm dev:worker` — the agent never answers; a local D1 query hangs forever

Expected (plan reference): B18 and D02 make `pnpm dev:worker` the local rehearsal of the deployed
runtime, and the agent is the reason the framework was chosen at all.

Observed, reported by the maintainer and reproduced here: under `wrangler dev` the agent chat never
responds. `POST /_agent-native/agent-chat` sends **no response headers at all** — not an error, not
a stream, nothing. A client waits until it gives up (60s, and once 5 minutes). The same request
works on the Node dev server.

Everything that could plausibly be misconfigured was eliminated, in this order, from inside the
Worker via a temporary probe route:

| Stage | Result |
| --- | --- |
| Route reachable, unauthenticated | **401 in 56ms** |
| Route reachable, authenticated, invalid body | **400 in 13ms** (`message is required`) |
| Outbound HTTPS to `api.anthropic.com` (bogus key) | **401 in 193ms** — egress works |
| `resolveCredential("ANTHROPIC_API_KEY")` from the DB | **found, 108 chars, 3ms** — storage and decryption work |
| A one-token `claude-haiku-4-5` call with that key | **HTTP 200 in 804ms** — the provider works from workerd |
| `POST /_agent-native/agent-chat` with a valid message | **no headers, ever** |

Wrangler's local observability API (`/cdn-cgi/local/explorer/api/local/observability/query`, which
serves SQL over a `spans` table) then located it exactly. The trace of one hung request:

```
+0ms  POST    outcome=None          <- never completes
+1ms  d1_all  ok  2ms
+3ms  d1_all  ok  1ms      +3ms  d1_all ok 0ms
+4ms  d1_all  ok  0ms      +4ms  d1_all ok 0ms
+6ms  d1_all  ok  1ms      +6ms  d1_all ok 0ms
+7ms  d1_all  outcome=None          <- the eighth query never returns
+7ms  fetch   outcome=None          <- its miniflare D1 call never returns
```

Seven D1 queries complete in 0–2ms each; the eighth hangs forever, and the request dies with it
seven milliseconds in — before the model, the credential or the network is ever involved. Across a
session, in-flight spans accumulate (34 requests and 12 `d1_all` stuck) while 7,506 other `d1_all`
queries in the same process completed normally, so it is specific to this code path rather than to
D1 use in general.

Naming the statement was not achieved. `getDbExec()`'s singleton was patched in place to log every
statement and logged **nothing** for this request: the framework's own tables are reached through a
path that does not go through that executor, and `d1_all` is workerd's instrumentation of the D1
binding rather than anything in `@agent-native/core`. Naming it would mean patching the D1 binding
inside the 13 MB built bundle.

Impact: the agent — the whole point of the framework — does not work under the local Worker.
`verify:worker`'s "agent chat SSE" check never caught it because it asserts the stream opens with
`errorCode: "missing_credentials"`, which is true only because its isolated D1 has no credential:
the code path that runs *when a credential exists* has never executed under `wrangler dev` in this
repository's history. That assertion should be read as "the endpoint refuses cleanly without a
key", not "the agent works".

**Open and important: whether a deployed Worker is affected is unknown.** Cloudflare's real D1 is
not miniflare's local simulation, and the deployed runtime differs from `wrangler dev` in exactly
this area. Nothing here says production is broken, and nothing here says it works. Finding out
requires the staging environment from §6, which raises its priority above every other outstanding
item.

Proposed handling: report upstream with the trace
(`docs/plan/upstream-issues/agent-chat-d1-hang.md`), and treat the deployed check as the first
thing staging is used for. No workaround in this repository is known; `pnpm dev` is unaffected and
remains the way to exercise the agent locally.

Resolution: open. Temporary probe route and SQL tracer were removed after use; the Haiku model
default set on the Worker's local D1 during the investigation (`claude-haiku-4-5-20251001`,
org-scoped) was left in place deliberately, to keep local experiments cheap.

## 2026-09-11 T24 — `pnpm check` fails for anyone who actually uses the bootstrap script

Expected (plan reference): T24 requires `.bootstrap.env` to be git-ignored and only the
names-only example committed, and `tests/guards/bootstrap.test.mjs` guards that.

Observed: the guard asserted `existsSync(".bootstrap.env") === false`. The maintainer created the
file to run the bootstrap — exactly what `docs/bootstrap.md` instructs — and `pnpm check` began
failing with `true !== false`. The guard punished the documented workflow.

Impact: the whole point of the file is that it exists locally while you bootstrap. Left alone, the
first person to follow the setup guide finds their verification broken and no obvious reason why.

Proposed handling: assert what actually matters — that the path is git-ignored, via
`git check-ignore -q`, the same mechanism `scripts/check-config-hygiene.mjs` already uses for
`.env`, `.dev.vars` and `.bootstrap.env`. Absence was never the requirement; uncommittability is.

Resolution: 2026-09-11 — changed; the guard passes with the file present and would still fail if
the ignore rule were removed.

## 2026-09-14 B13 — a Worker var reached staging unset, because wrangler does not inherit `vars`

Expected (plan reference): B13 fixes the non-secret Worker configuration in `wrangler.jsonc`, and
`AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT: "1"` is part of it — the framework's auto dev account must
never be reachable in a deployed environment.

Observed, from the first real staging deployment of a template instantiation:

```
▲ [WARNING] Processing wrangler.jsonc configuration:
    - "env.staging" environment configuration
      - The following vars exist at the top level, but not on "env.staging.vars".
        This is probably not what you want, since "vars" configuration is not inherited
        by environments.
        - AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT
```

The var was declared only in the top-level `vars` block, which applies to the unnamed (local)
environment. Wrangler does not copy it into `env.staging` or `env.production`, so both deployed
environments were configured without it, and the only symptom was a warning inside a deploy log
nobody reads when the deploy succeeds.

Impact: smaller than it first appears, and worth stating precisely rather than alarming. The
framework's auto dev session also requires `isDevEnvironment()` and a loopback request
(`dist/server/auth.js`), and both environments set `NODE_ENV=production`, so the door was never
actually open. What was lost is the defence in depth the flag exists to provide: its whole purpose
is not to depend on `NODE_ENV` being right.

Proposed handling: set the var explicitly in both environment blocks, and add a rule so the next
one cannot slip through — `scripts/lib/wrangler-vars.mjs` reports any top-level var key absent from
a named environment, wired into `scripts/check-config-hygiene.mjs` so `pnpm check` fails on it.
The rule is absolute, with no exemption list: production's `SEED_ENABLED` was previously *omitted*
to keep the seed off, and is now spelled `"0"` instead — `env-check` treats absent and `"0"`
identically, so nothing changes behaviourally and "missing" always means a mistake.

Resolution: 2026-09-14 — applied. `tests/guards/wrangler-vars.test.mjs` covers the rule against
fixtures and asserts this repository's own config inherits every var.
## 2026-09-14 D21 — a bad deploy credential failed after the build, not before it

Expected (plan reference): B20 and D21 make the deploy workflows the only path to an environment,
and a workflow that cannot reach its environment should say so plainly.

Observed: the first real staging deployment of an instantiation spent roughly three minutes on
checkout, `pnpm install`, `pnpm build:worker` and two artifact uploads before making its first
Cloudflare call, then failed inside `pnpm db:migrate:staging` with:

```
A request to the Cloudflare API (/accounts/***/d1/database/<id>/query) failed.
The given account is not valid or is not authorized to access this service [code: 7403]
```

Everything after it — `deploy:staging`, the QA reset, the staging smoke — was skipped, so nothing
was half-applied. But the failure is reported by wrangler in terms of an opaque API code, at the
bottom of a long log, three minutes in, and says nothing about which of the token, its permissions
or the account id is wrong. Diagnosing it took a local `wrangler d1 execute --remote` with the
token passed explicitly — the plain command succeeds from an interactive `wrangler login` session,
which is a *different* credential from the one CI uses and hides the problem.

Impact: the slowest and least legible possible failure for the most common first-deploy mistake.
The Cloudflare "Edit Cloudflare Workers" token template does not include D1, so a token that can
create a Worker and even create a D1 database still cannot run SQL against one.

Proposed handling: a preflight step at the top of both deploy jobs — before checkout in staging,
after the run-id check in production — that calls
`GET /accounts/<id>/d1/database?per_page=1` with the job's own credentials. It needs no
repository, no install and no build, exercises the exact pairing that breaks (this token, this
account, D1), and on failure prints the HTTP status, Cloudflare's own `[code] message` lines and
the two things to check, then exits. Only the API's error lines are printed; the response body is
never echoed and the token never appears.

Resolution: 2026-09-14 — applied to `deploy-staging.yml` and `deploy-production.yml`; verified
against a deliberately bad credential, which fails in about a second with
`::error::Cloudflare credentials cannot reach D1 on this account (HTTP 401)` and
`[10000] Authentication error`. `pnpm lint:workflows` is clean.

## 2026-09-14 B20 — the staging smoke's 120s budget was calibrated on local D1

Expected (plan reference): B20's staging smoke runs the Worker contract against the deployed
environment after every staging deploy.

Observed: on the first staging deployment that got past the credential problems, the Worker
deployed cleanly and eight checks passed — ping, D1 health, migrations, sign-in HTML, static shell,
the unauthenticated 401, QA login and an authenticated read. Then three checks reported
`The operation was aborted due to timeout`, and the step had run for exactly 120 seconds.

There was one failure, not three. `runSmoke` builds a single `AbortSignal.timeout(options.timeoutMs)`
and shares it across every check, so the first check to exhaust the run's budget fails and every
check after it aborts instantly with the same message. `agent chat SSE` and
`unauthenticated MCP challenge` never ran on their merits; the budget was consumed by
`reversible write, conflict, undo and isolation`, which is the heaviest check in the suite — create,
complete, force a version conflict, undo, then probe cross-organization isolation.

Cause: 120s is the script's default, and it was calibrated against `verify:worker`, where the
Worker and D1 are both local and a query answers in 0-2ms. A remote smoke crosses the internet to
the Worker and again to remote D1 on every hop, after a cold start on the first request following a
fresh deploy. The number was inherited from the local case without anyone asking whether it
transferred.

Impact: a slow check looked like three broken subsystems, and one of the three — `agent chat SSE` —
is the surface with a known unrelated hang, which made the report actively misleading.

Proposed handling: (1) both deploy workflows pass `--timeout-ms 300000`, with a comment saying why
a remote budget differs from a local one; (2) `runSmoke` names the check that exhausted the budget
and reports the rest as `[skip] … not run`, so the cause is legible from the log without reasoning
about a shared signal.

Resolution: 2026-09-14 — applied. Whether 300s is enough, or whether that check is genuinely stuck
rather than slow, is not yet known: if it exhausts the larger budget at the same check, the problem
is a hang and not a timeout, and that is worth knowing either way.

## 2026-09-15 B20 — the smoke had no per-request ceiling, so one call ate the whole run

Expected (plan reference): B20's smoke gives each check a bounded time and reports which check
failed, so a staging failure names its cause.

Observed: raising the run budget from 120s to 300s changed nothing — the staging smoke still died
in `reversible write, conflict, undo and isolation`, and the improved message showed that check
consuming **292872ms of the 300000ms budget**. A direct probe of the deployed Worker then ran the
identical sequence from a developer machine: login 865ms, `list-customers` 260ms, `create-job`
468ms, `complete-job` 388ms, the deliberate conflict 409 in 259ms, `undo-operation` 480ms,
`list-recent-activity` 375ms. The deployed application is healthy, D1 writes included.

Cause, in `scripts/lib/http-client.mjs`:

```js
signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
```

The client's per-request timeout applied **only when the caller passed no signal**. Every smoke
call passes the run-wide deadline, so `timeoutMs` was dead code for the entire suite and a single
stalled request could absorb the whole budget with nothing to stop it. That is also why the cause
stayed anonymous: no request-level timeout ever fired to name the call.

Impact: three rounds of wrong hypotheses — stale secrets, a missing D1 permission, account-owned
tokens, hanging D1 writes — and a serious proposal to abandon Cloudflare for Turso, all built on a
symptom manufactured by our own test client. The application was never implicated by the evidence;
the instrumentation simply could not say what was slow.

Proposed handling: combine both ceilings with `AbortSignal.any([init.signal,
AbortSignal.timeout(this.timeoutMs)])`, so a run budget and a per-request limit both apply; and
wrap request failures with the method and path, because the check wrapper only knows the check's
name and "The operation was aborted due to timeout" identifies nothing.

Resolution: 2026-09-15 — applied. `pnpm check` and `pnpm verify:worker` (12/12) pass. What actually
stalls between a GitHub runner and this Worker is still unknown, and deliberately so: the next
staging run will name the request instead of the check, which is the evidence that was missing.

## 2026-09-15 B18 — `wrangler dev` exits mid-run and takes the whole browser suite with it

Expected (plan reference): B18's browser suite runs against the built Worker, and a CI failure
names what went wrong.

Observed: three separate CI runs failed with 15 to 25 identical lines of
`ENOENT: no such file or directory, open '.wrangler/e2e-worker-state.json'`, each preceded by one
line nobody looks for: `[WebServer] e2e-server: wrangler dev exited on its own (code 1, null)`.
Each time a re-run passed. Locally, workerd logs repeated
`disconnected: ::write(...): Broken pipe` — a browser aborting an in-flight request on navigation —
before Wrangler gives up.

Cause: two faults compounding. `scripts/e2e-server.mjs` treated any unasked-for Wrangler exit as
fatal, and its `finally` block deleted the state file on the way out; `resetScenario()` then read
that path with no guard, so every remaining test reported a missing file rather than a dead server.
The real event appeared once, in Playwright's `[WebServer]` prefix, above a wall of noise.

Impact: three wasted CI cycles, and each one initially looked like a different problem than it was.

Proposed handling: (1) supervise rather than surrender — an unexpected exit restarts Wrangler up to
three times and says so. The database lives in `--persist-to`, which survives, so the restart
resumes against the same seeded data, and Playwright's `retries: 1` under CI covers the tests that
were in flight. (2) `resetScenario()` checks for the file first and, when it is absent, says the
Worker is no longer running and points at the `[WebServer]` output, instead of surfacing `ENOENT`.

Resolution: 2026-09-15 — applied and verified by killing the Wrangler process mid-run:
`wrangler dev exited on its own (code 143, null) — restarting 1/3, database in … is unaffected`,
after which `/_agent-native/ping` answered 200 and the state file was still present. The full
browser suite passes (17 tests).

Worth recording for whoever meets this next: the first attempt at that verification killed the
**workerd** process instead, which Wrangler survives — the supervisor correctly did nothing, the
port stayed dead, and the test proved nothing. Wrangler exiting and workerd exiting are different
failures; only the first is handled here, because only the first is the one CI has shown.

## 2026-09-15 B20 — the smoke's per-request ceiling was a third local-calibrated constant

Expected (plan reference): B20's staging smoke exercises the deployed Worker and fails only when
the deployment is wrong.

Observed: with per-request timeouts in place (previous entry) the staging smoke finally named its
victims — `POST /_agent-native/actions/create-job` and `POST /_agent-native/agent-chat`, each
`failed after 15000ms at most`, while `auth/login` (also a POST, also a write) and every read
passed. A throwaway `workflow_dispatch` job then ran the same requests from a GitHub runner:

```
GET  ping                      200   5149ms  colo=SJC
GET  health                    200   4746ms  colo=SJC
POST auth/login                200   6117ms  colo=SJC
GET  list-customers            200   1761ms  colo=SJC
POST create-job (atomicBatch)  200   2203ms  colo=SJC
POST create-job (60s ceiling)  200   1518ms  colo=SJC
```

Everything works from a runner, batch writes included. That kills the hypothesis the previous
entry left open — that D1's `atomicBatch` fails from CI — and points instead at the *cold* numbers:
a bare `ping` took 5.1s and a login 6.1s on a Worker that had just been deployed, settling to 1-2s
once warm. The same login from a developer machine takes 865ms.

Cause: `runSmoke` capped every request at `Math.min(options.timeoutMs, 15_000)`, irrespective of
`--timeout-ms`. That is the third constant in this file calibrated against a local Worker — after
the 120s run budget and the per-request ceiling that never applied at all. The staging smoke runs
seconds after `wrangler deploy`, which is precisely the cold window.

Proposed handling: keep 15s for `--mode local`, where a slow request means a real hang and a tight
bound surfaces it quickly, and allow 45s for a remote smoke, which runs against a cold deployment
over the public internet.

Resolution: 2026-09-15 — applied; `pnpm check` and `pnpm verify:worker` (12/12) pass. Whether 45s
is enough is not proven: the next staging run is the test, and if `create-job` still exceeds it
the problem is not cold-start latency and the hunt resumes with better numbers than before.

---

## 2026-09-24 — The migration's stale-reference sweep has to include assertions

Ported from the template with the rest of T28, because the same line was here.

`validateEnvironment` refused to start production when `DATABASE_URL` was set:

```
DATABASE_URL must not be set in production; the Worker reaches D1 through its binding
```

Right against a Cloudflare binding, backwards against a PostgreSQL add-on, which production
reaches *through* that connection string. The first production promotion would have thrown at
boot. Two reasons it survived:

- **There is no `staging` rule set**, so a deployed staging application never evaluates the
  production branch. Green smoke runs proved nothing about it.
- **Three unit tests asserted the old rule** and passed, because they were named and written
  against the mechanism (`production forbids DATABASE_URL when present at all`) rather than the
  intent. A test written that way cannot outlive its premise.

The rule now requires the variable in production and refuses a `file:` URL there — production on
a SQLite file inside a container that is replaced every deploy.

The general lesson for a platform migration: the dangerous stale references are not the ones
naming the old tool. Those are greppable and obvious. It is the ones that encoded a platform
assumption as an invariant, in a validator whose own tests agreed with it.

---

## 2026-09-24 — bootstrap's second run tried to recreate what its first run made

Two faults in `scripts/bootstrap.mjs`, surfaced by the first real `--yes` run against
`seating-arrangement`. Both were in code whose own tests passed.

**1. `github-secrets` could not read a logged-in CLI's profile.** clever-tools 5.x writes
`{ version, profiles: [{ alias, token, secret, expirationDate }] }`; the script read a
top-level `token`. It refused with *"Run `clever login` first"* — at a CLI whose preflight had
just reported `[ok] Clever Cloud authentication`. The message named the wrong cause, so the
maintainer did the reasonable thing it suggested, which fixed nothing.

**2. The re-run tried to create applications that existed.** `listApps()` called
`clever applications --format json`. That subcommand takes `--json`; `addon list` and `env`
take `--format json`. And `clever` **exits 0** on an unknown option, printing its usage text
to stdout. So the exit-status check passed, `JSON.parse` threw, the `catch` returned `[]`, and
"I could not tell" became "there are none" — in the one function whose answer decides whether
to create a paid resource. `clever create` then refused on the alias, which is the only reason
it did not make duplicates.

Why the tests did not catch either: **the stub agreed with the script.** It answered every
`applications` call with the same flat array regardless of flags, and its profile fixture used
the old flat shape. The idempotency test — `a second --yes run against an existing world
creates nothing` — existed and passed, because the stub could not be asked the wrong question.
A stub that mirrors the caller's assumptions tests the caller against itself.

Now:

- `cleverJson()` refuses when a command that should print JSON does not, so a wrong flag is a
  loud failure instead of an empty list.
- `listApps()` reads the account-wide `applications list`, not the checkout's links — a fresh
  clone has none, and would otherwise try to create everything again. An application that
  exists but is not linked here is linked, since every later step addresses it by alias.
- The profile reader takes both shapes, prefers `CLEVER_PROFILE` then `default`, and refuses an
  expired profile rather than writing a dead token into the CI secrets.
- The stub reproduces the real CLI's per-subcommand flags **and its exit-0-on-unknown-option
  behaviour**, and its default profile is the current shape. The old shape and the expired case
  each have a test.

The same lesson as the env-check rule earlier today, from the other side: there, a test encoded
the old platform; here, a test double encoded the caller's belief about a tool.
