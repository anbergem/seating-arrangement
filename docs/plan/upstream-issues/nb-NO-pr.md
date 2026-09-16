# Upstream change draft — Norwegian Bokmål (`nb-NO`) for Agent-Native

Status: **branch pushed to the fork, reviewed-before-submission. The maintainer opens the pull
request; task T25 never opens it.**

Written by task T25. Related: D19 (internationalization), F14 (framework i18n facts), upstream
feature request BuilderIO/agent-native#3985.

---

## Fork branch

<https://github.com/anbergem/agent-native/tree/feat/locale-nb-no>

- Fork: `anbergem/agent-native` (created with `gh repo fork BuilderIO/agent-native --clone=false`).
- Branch: `feat/locale-nb-no`, based on `upstream/main` at `8a33f82a0`
  (`chore: release packages (patch) [stable-release] [skip netlify] (#4469)`).
- `@agent-native/core` on that base is **0.177.0**; the starter pins 0.176.5.

## Proposed pull request title

```
feat(i18n): add Norwegian Bokmål (nb-NO) locale
```

## Proposed pull request body

> ### Motivation
>
> `SUPPORTED_LOCALES` is a closed union of eleven locales and there is no app-level way to add a
> twelfth: `LocaleCode` is a TypeScript union, `set-localization-preference` rejects anything
> outside it, `LanguagePicker` filters unknown codes out, and each locale needs framework-curated
> metadata (English name, native name, text direction). The internationalization guide says so
> explicitly: "Adding a new locale means extending the framework itself, not adding a catalog file
> to your app." That is the gap tracked in #3985.
>
> This adds Norwegian Bokmål, the first Nordic locale, so Norwegian apps can select a Norwegian
> framework UI instead of falling back to English.
>
> ### What changed
>
> **The locale itself** (`packages/core`)
>
> - `SUPPORTED_LOCALES` gains `"nb-NO"`; `LOCALE_METADATA` gains
>   `{ code: "nb-NO", englishName: "Norwegian Bokmål", nativeName: "Norsk bokmål", dir: "ltr" }`.
> - `core-messages/nb-NO.ts`: all 578 keys of the `en-US` source catalog, translated, with
>   `{{placeholder}}` tokens and product identifiers preserved. `Intl.PluralRules("nb-NO")`
>   resolves to `one` / `other`, so every plural base carries exactly those two categories.
> - `coreMessageLoaders` registers the lazy loader, so the Norwegian catalog is only downloaded
>   when Norwegian is active.
> - `set-localization-preference` needs no change: its validation is derived from
>   `SUPPORTED_LOCALES`.
>
> **The rest of the framework's Norwegian copy** — every exhaustive `Record<LocaleCode, …>` map in
> `packages/core` now has an `nb-NO` entry:
>
> - `shared/auth-copy.ts` (`NATIVE_AUTH_COPY`) and `server/onboarding-html.ts`
>   (`AUTH_LOCALE_COPY`) — the sign-in and first-run onboarding surfaces.
> - `server/auth-marketing-locales.ts` — taglines and feature bullets for all sixteen built-in
>   marketing surfaces (required by `auth-marketing-locales.spec.ts`).
> - `localization/mcp-settings-messages.ts` (`MCP_CONNECT_MESSAGES`, `MCP_SETTINGS_MESSAGES`) and
>   `shared/mcp-connect-content.ts` (all seven connect guides plus the static-token panel; required
>   by `mcp-connect-content.spec.ts`).
> - `client/i18n.tsx` (language-picker chrome), `client/ErrorBoundary.tsx`,
>   `client/FeedbackButton.tsx`, `client/blocks/library/block-copy.ts`,
>   `client/extensions/ExtensionsSidebarSection.tsx`.
>
> **Docs**
>
> - `docs/content/internationalization.mdx` lists `nb-NO` in the loader example and in the
>   supported-code list, and the "all ten" phrasing is now count-free so the next locale does not
>   need a prose edit.
> - The ten localized copies under `docs/content/locales/*/internationalization.mdx` get the same
>   two edits in their own language, per the repository rule that a source-doc meaning change and
>   its translations land together (`guard:i18n-changed-copy`).
>
> **Unblocking the locale list from template parity** — this is the only part that is a design
> choice rather than a translation, and it is the part most worth review.
>
> Nine first-party templates asserted their catalog maps exhaustively
> (`satisfies Record<LocaleCode, Messages>`, and variants over
> `Exclude<LocaleCode, "en-US">`), so adding a twelfth locale to the union made
> `pnpm typecheck` fail in 10 templates and `packages/docs` with 65 errors — a locale could not be
> added without translating every template app in the same change (`templates/design/app/i18n-data.ts`
> alone is ~16.8k lines). Those maps are now `Partial`, and the locale-keyed override loops read
> through a `Partial` view, so:
>
> - `satisfies` keeps every present locale exactly typed at its use sites — no widening, no new
>   `| undefined` at any existing call site.
> - The loops that walk translation sets already carried a `if (!messages) continue` guard; it is
>   now type-checked instead of resolving to `any`.
> - `mergeLocalizedMessages` / `mergeMessagesForLocale` in `analytics`, `assets`, `content` and
>   `design` take a `TranslatedLocale` derived from the template's own catalog key set rather than
>   the framework union, so a locale a template has not been translated into is a type error at the
>   call site, not a silent `any`.
> - `templates/mail/app/root.tsx` and `packages/docs/app/routes/skills.tsx` keep their existing
>   `?? en-US` fallbacks; only the map types changed, and `MAIL_ERROR_COPY` now *requires* `en-US`
>   rather than merely happening to have it.
>
> A supported locale a template has no catalog for therefore resolves through the framework's
> existing source-locale fallback — the documented behavior of `supportedLocales` — instead of
> blocking the framework's locale list. **Template catalogs for `nb-NO` are deliberately not part
> of this change**: the framework UI is Norwegian, template UI stays English until each template is
> translated. Say the word and I will split that type change into its own PR ahead of the locale.
>
> **Baseline**
>
> `scripts/i18n-localized-doc-coverage-baseline.txt` gains 201 `nb-NO` rows, recording that none of
> the 201 English docs has a Norwegian translation yet. This is a deliberate, reviewed baseline
> update of the same kind every other locale already carries (65–66 rows each, because their docs
> are partially translated); `nb-NO` has 201 because it has none. The diff touches no other locale's
> rows. Translating the docs corpus is out of scope for adding a locale.
>
> ### Verification
>
> Run on the branch, macOS, Node 26.6.0, pnpm 11.23.0 (see the caveat below):
>
> | Command | Result |
> | --- | --- |
> | `pnpm fmt:check` | `All matched files use the correct format.` |
> | `pnpm typecheck` | clean, all workspaces |
> | `pnpm guards` | `[guards] All 70 checks passed` (includes `guard:i18n-catalogs` and `guard:i18n-changed-copy`) |
> | core locale suites (12 files, 146 tests) | all pass |
> | `packages/core` suite, `run-code.spec.ts` excluded | 976/980 files, 14 211/14 221 tests pass |
>
> The ten remaining failures are environmental, not regressions. Eight are in
> `src/coding-tools/*` and fail identically on a detached checkout of `upstream/main` at
> `8a33f82a0` (21 failures there, a superset, because `run-code.spec.ts` is included) — the
> sandboxed subprocess cannot open sockets on this machine. Two are in `src/server/auth.spec.ts`
> and are a parallel-run resource conflict, not an assertion failure:
> `PGlite database directory "./data/pglite" is already owned by process <pid>`. Run on its own,
> `src/server/auth.spec.ts` passes 239/239 on the branch. This change touches no auth logic — only
> the `NATIVE_AUTH_COPY` and `AUTH_LOCALE_COPY` string tables.
>
> Catalog parity was checked directly as well: `nb-NO` has 578 keys, `en-US` has 578, no missing and
> no extra keys, and the ten values that are byte-identical to English are legitimately identical in
> Bokmål (`Design`, `Agent`, `UI`, `Plan`, `Minimal`, `Min`, `m`, `s`, `Segment`,
> `{{count}} system`).
>
> ### Translation provenance
>
> The Norwegian copy is **machine-assisted and reviewed by a native Norwegian speaker** (me, the
> submitter). Terminology choices worth flagging, because they are consistent across the catalog
> and are the kind of thing a second Norwegian reviewer may want to argue with:
>
> - `chat` (noun) → **samtale**, not the loanword *chat*.
> - `AI` → **KI** (kunstig intelligens), the standard Norwegian abbreviation.
> - `Skill` → **ferdighet**; `Extension` → **utvidelse**; `Action` → **handling**;
>   `Automation` → **automasjon**.
> - `Revoke` → **trekke tilbake**; `Evict` (context segments) → **kaste ut**.
> - Norwegian typography: a space before an ellipsis (`Laster ...`) and before `%`
>   (`Kontekst 42 %`), and `«»` for quotation marks.
> - Product names, protocol names and identifiers (`Agent-Native`, `Builder.io`, `MCP`, `A2A`,
>   `OAuth`, `SQL`, `CLI`, `SKILL.md`, `/clear`, `/mcp`) are left untranslated, as the
>   internationalization guide requires.

## Maintainer checklist before opening the PR

1. **Spot-check 30 strings** — the list is below. These are the highest-visibility strings plus the
   ones where a terminology choice, a placeholder or Norwegian typography could be wrong.
2. **Re-run the checks on your own machine** (Node 22, matching CI):

   ```
   pnpm install
   pnpm fmt:check
   pnpm typecheck
   pnpm guards
   pnpm --filter @agent-native/core exec vitest run src/localization src/client/LanguagePicker.spec.tsx \
     src/server/auth-marketing-locales.spec.ts src/server/auth-marketing-layout.spec.ts \
     src/server/onboarding-html.spec.ts src/shared/mcp-connect-content.spec.ts
   pnpm test:fast
   ```

   Two suites (`src/client/LanguagePicker.spec.tsx`, `src/localization/server.spec.ts`) need
   `window.localStorage`, which Node 26 only provides with `--localstorage-file`. On Node 22 they
   run unmodified; on Node 26 export
   `NODE_OPTIONS=--localstorage-file=$(mktemp -t an-ls)` first. This is unrelated to the change —
   the same suites fail the same way on unmodified `upstream/main` under Node 26.

   `src/coding-tools/*` needs a sandboxed subprocess that can open sockets; those suites fail on
   unmodified `upstream/main` in a network-restricted environment. `src/server/auth.spec.ts` can
   lose a race for `./data/pglite` in a fully parallel run of the whole package; it passes 239/239
   on its own.

3. **Decide on the template type change.** Either keep it in this PR (it is what makes the locale
   addable at all) or ask for it as a separate preparatory PR titled something like
   `refactor(i18n): stop gating the locale list on template catalog parity`. It is mechanically
   separable: it is confined to `templates/*/app/i18n-data.ts`,
   `templates/design/app/i18n-keyboard-shortcuts.ts`, `templates/calendar/app/i18n/index.ts`,
   `templates/mail/app/root.tsx` and `packages/docs/app/routes/skills.tsx`.
4. **Confirm the 201-row baseline addition is acceptable** as an explicit record of untranslated
   Norwegian docs, rather than a blocker. If upstream would rather not carry it, the alternative is
   translating all 201 docs, which does not belong in a locale PR.
5. **Check the changeset**: `.changeset/add-nb-no-locale.md` declares
   `"@agent-native/core": minor`. Confirm `minor` is right for a new public locale (it widens
   `LocaleCode`, so it is not a patch, and it removes nothing, so it is not a major).
6. **Open the PR** from `anbergem:feat/locale-nb-no` into `BuilderIO/agent-native:main`, ready for
   review (not a draft), with the title and body above. Reference #3985 in the body — this change
   does not close it, since it adds one locale rather than app-registered locales.

## 30 strings to spot-check first

All in `packages/core/src/localization/core-messages/nb-NO.ts` unless noted. Ordered so the
terminology decisions come first.

| # | Key | Why it is on the list |
| --- | --- | --- |
| 1 | `shell.chat` | The *samtale* vs *chat* decision, in its shortest form |
| 2 | `tabs.newChat` | Same decision, in the most-clicked place |
| 3 | `history.untitledChat` | Same decision, as a default title |
| 4 | `setup.connectAi` | The `AI` → **KI** decision |
| 5 | `setup.freeCredits` | KI decision plus a long marketing sentence |
| 6 | `composer.createSkill` | The `Skill` → **ferdighet** decision |
| 7 | `composer.menu.createSkillDescription` | Whether "lær agenten en ny ferdighet" reads naturally |
| 8 | `composer.createExtension` | The `Extension` → **utvidelse** decision |
| 9 | `composer.actMode` | The `Act` → **handling** decision |
| 10 | `composer.actDescription` | Same decision in a sentence |
| 11 | `empty.prompt` | The single most-seen string in the product |
| 12 | `composer.messageAgent` | The composer placeholder |
| 13 | `approval.question` | Placeholder `{{tool}}` inside a question; imperative mood |
| 14 | `approval.alwaysAllowHint` | Long imperative; risk of a stilted calque |
| 15 | `commands.clear` | Parenthetical clause; slash-command help text |
| 16 | `commands.plan` | *skrivebeskyttet* for "read-only" |
| 17 | `plan.ready` | Two-word status; whether the definite form is right |
| 18 | `status.stillWorking` | Progress copy shown for minutes at a time |
| 19 | `tool.interrupted` | Longest warning in the catalog; must not soften the uncertainty |
| 20 | `tool.longRunning` | Idiomatic "a minute or two" |
| 21 | `limit.descriptionAll` | `{{scope}}` placeholder inside a genitive construction |
| 22 | `limit.ownerOnly` | Role nouns (*eiere*, *administratorer*) |
| 23 | `errorMessages.noProviderConnected` | Menu path (`Innstillinger > Agent > KI-leverandører`) — must match the real Norwegian menu labels |
| 24 | `errorMessages.providerAuthentication` | Second menu path, with `→` separators |
| 25 | `recovery.newChatHint` | Conditional sentence; easy to get the mood wrong |
| 26 | `contextXray.panelTitle` | The coined compound **Kontekstrøntgen** — is this the right word? |
| 27 | `contextXray.evict` | The `Evict` → **kaste ut** decision |
| 28 | `contextMeter.summary` | Space before `%` and the `·` separator |
| 29 | `share.titleWithResource` | `«{{title}}»` quotation marks |
| 30 | `share.viewerDescription` | Terse permission description (*Kan se*) |

Two more worth a glance even though they are not in the core catalog:

- `NATIVE_AUTH_COPY["nb-NO"].googleNeverFinished` in
  `packages/core/src/shared/auth-copy.ts` — the only string carrying a bracketed log tag
  (`[agent-native][google-oauth]`), which must survive untranslated.
- `AUTH_MARKETING_LOCALE_COPY["nb-NO"].tasks` in
  `packages/core/src/server/auth-marketing-locales.ts` — the longest marketing bullets, including
  a quoted user phrase («fullfør disse»).

## What changes in this starter once the locale ships

`app/i18n/index.ts` currently carries the D19 workaround:

```ts
export const i18nCatalog = createAgentNativeI18nCatalog({
  messages: enUS,
  localeLoaders: {
    // Norwegian is not in the framework's locale list yet (BuilderIO/agent-native#3985).
    // @ts-expect-error — remove when the framework accepts nb-NO
    "nb-NO": () => import("./nb-NO"),
  },
  supportedLocales: ["en-US"],
});
```

When a released `@agent-native/core` includes `nb-NO`:

1. `pnpm typecheck` **fails first**, and that is the intended signal: `@ts-expect-error` becomes
   "Unused '@ts-expect-error' directive". Delete the directive and the comment above it.
2. Change `supportedLocales: ["en-US"]` to `supportedLocales: ["en-US", "nb-NO"]`. Until this
   changes, `LanguagePicker` still lists English only, so the app catalog is unreachable even with a
   valid locale code.
3. Delete nothing else: `app/i18n/nb-NO.ts` is the *app* catalog and is still needed. The upstream
   change only supplies the framework's own UI strings.
4. Update `docs/plan/02-framework-facts.md` F14 — the "closed locale list" bullet and the
   "`nb-NO` is rejected by `set-localization-preference`" claim both stop being true — and mark D19
   as delivered in `docs/plan/01-decisions.md`.
5. Bump the pin in `package.json` to that release, and record the upgrade in the upgrade playbook
   (`docs/upgrade-playbook.md`), which is where the temporary package-patch route for the customer app is
   tracked.

The Playwright locale test and `pnpm guard:i18n` (`scripts/check-i18n-catalogs.mjs`) need no change:
the guard checks
catalog shape and the single-brace placeholder rule, neither of which depends on whether the
framework knows the locale code.
