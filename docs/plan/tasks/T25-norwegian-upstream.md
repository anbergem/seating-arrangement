# T25 — Norwegian Bokmål upstream change (prepared for maintainer review)

Goal: a reviewed-before-submission branch on a fork of `BuilderIO/agent-native` that adds
`nb-NO` to the framework, following the existing pattern for the eleven locales. The maintainer
opens the pull request; this task never opens it.

Depends on: T15. Read: F14; D19.

## Steps

1. Fork `BuilderIO/agent-native` under the maintainer's GitHub account (`gh repo fork
   BuilderIO/agent-native --clone=false`), clone the fork, create branch `feat/locale-nb-no`.
   Read the repository's `DEVELOPMENT.md` and `AGENTS.md` and follow their setup commands.
2. Locate the locale list and metadata source (search `packages/core/src` for
   `SUPPORTED_LOCALES` and `LOCALE_METADATA`), the core message catalogs (search for the
   directory containing `core-messages/en-US`), the loader map (`coreMessageLoaders`), any
   locale-code validation in `set-localization-preference`, the docs page
   `docs/content/internationalization.mdx` locale list, and every first-party template's
   `app/i18n/index.ts` loader map (do **not** add template catalogs; the framework's own UI
   catalog is enough for a first PR unless the repository's guard requires template parity —
   check `pnpm guard:i18n-catalogs` output and follow what it requires).
3. Add `nb-NO` with metadata `{ code: "nb-NO", englishName: "Norwegian Bokmål", nativeName:
   "Norsk bokmål", dir: "ltr" }`; add `core-messages/nb-NO.ts` translating `en-US.ts` key for key
   (Bokmål; keep placeholders and formatting tokens intact; do not translate identifiers listed
   in the internationalization doc); register the loader; update the docs list.
4. Run the repository's checks: the i18n guard, typecheck for `packages/core`, and the unit
   tests that reference locales. Fix until clean.
5. Push the branch to the fork. Write `docs/plan/upstream-issues/nb-NO-pr.md` with: the fork
   branch URL, a proposed PR title (`feat(i18n): add Norwegian Bokmål (nb-NO) locale`), a
   proposed PR body (motivation, what changed, how it was verified, that translations were
   machine-assisted and reviewed by a native speaker — the maintainer), and a checklist for the
   maintainer's review (spot-check 30 strings, run the guard, open the PR).

## Deliverables

`docs/plan/upstream-issues/nb-NO-pr.md` in this repository; the branch on the fork.

## Acceptance

The fork branch exists, its checks pass locally (paste the commands and results), and the
review document is complete. No pull request is opened.
