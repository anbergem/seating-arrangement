# Internationalization

Every user-facing string goes through the framework's i18n catalogs from day one. Not because
the sample application needs two languages, but because retrofitting i18n into a working
application means touching every component, and doing it from the start costs nothing.

- [How it works](#how-it-works)
- [The catalogs](#the-catalogs)
- [Placeholders](#placeholders)
- [The guard](#the-guard)
- [Norwegian: current status](#norwegian-current-status)
- [Adding a locale](#adding-a-locale)
- [Dates, numbers and the language picker](#dates-numbers-and-the-language-picker)
- [What is not translated](#what-is-not-translated)

## How it works

The framework ships its own UI catalogs for eleven locales — its sign-in page, settings, agent
chat, team page — and lets an application register its own on top. `app/i18n/index.ts` is the
whole wiring:

```ts
import { createAgentNativeI18nCatalog } from "@agent-native/core/client/i18n";
import enUS from "./en-US";

export const i18nCatalog = createAgentNativeI18nCatalog({
  messages: enUS,
  localeLoaders: {
    "nb-NO": () => import("./nb-NO"),
  },
  supportedLocales: ["en-US"],
});
```

`app/root.tsx` passes that catalog to the framework's providers, and components read strings
through a hook:

```tsx
const t = useT();
// …
<h1>{t("jobs.title")}</h1>
<p>{t("jobs.scheduledFor", { date: formatted })}</p>
```

`messages` is the fallback catalog — the one used when a key is missing from the active locale,
and the one the guard treats as the key inventory. `localeLoaders` are dynamic imports, so a
locale's catalog is only downloaded when somebody selects it.

## The catalogs

`app/i18n/en-US.ts` and `app/i18n/nb-NO.ts`, one nested object each, grouped by area:

| Group | Covers |
| --- | --- |
| `common` | `save`, `cancel`, `confirm`, `archive`, `undo`, `redo`, `loading` |
| `navigation` | The sidebar and its accessible labels |
| `pages` | Page titles and their `<title>` tags |
| `jobs`, `customers`, `activity` | The three feature areas, including dialog labels and status names |
| `errors` | **One key per `AppErrorCode`**, plus an `UNKNOWN` fallback |

The `errors` group is the one to get right, because it is what a user sees when something
refuses:

```ts
errors: {
  AUTHENTICATION: "Please sign in to continue.",
  AUTHORIZATION: "You do not have permission to do that.",
  CONFLICT: "This record changed. Refresh and try again.",
  EXTERNAL: "The external system did not confirm the request. Try again; a retry reconciles it.",
  INTERNAL: "Something went wrong.",
  INVARIANT: "That change is not valid for the current state.",
  NOT_FOUND: "The requested record was not found.",
  UNKNOWN: "The request failed. Try again.",
  VALIDATION: "Check the entered values and try again.",
}
```

`app/components/activity/action-ui.ts` maps an action's `errorCode` to `errors.<CODE>` and falls
back to the server's own message. So a new `AppErrorCode` needs a key in **both** catalogs and
in the guard's family list, or the raw code reaches the screen. That has happened once:
`EXTERNAL` was missing, and the one error a user is most likely to have to act on rendered as
`errors.EXTERNAL`.

Every string a user can see belongs here, including accessible names: `aria-label`s, dialog
titles, button labels on icon-only controls. A hard-coded `aria-label` is invisible in English
and stays English in every other locale.

## Placeholders

**`{{name}}`, double braces, always.** The framework interpolates exactly one form:

```js
// node_modules/@agent-native/core/dist/client/i18n.js
return template.replace(/\{\{(\w+)\}\}/g, (_, name) => { … });
```

A single-brace `{name}` is never substituted and reaches the screen verbatim. That is not a
theoretical risk — `jobs.scheduledFor: "Scheduled for {date}"` shipped once and the job detail
page displayed the literal text *Scheduled for {date}*. Both catalogs agreed, so a parity check
could not catch it, which is why the guard now checks the *form* as well as the parity.

```ts
// right
jobs.scheduledFor: "Scheduled for {{date}}"
// wrong, silently
jobs.scheduledFor: "Scheduled for {date}"
```

Pluralization is not part of the framework's interpolation. When a count changes the sentence
shape, use two keys and choose in the component; do not try to build the sentence from
fragments, which does not survive translation.

## The guard

```bash
pnpm guard:i18n        # node scripts/check-i18n-catalogs.mjs
```

It runs inside `pnpm check`, so it gates every pull request. It parses both catalogs with
`@babel/parser` — not a regex — and reports:

- a key present in one catalog and missing from the other, by locale and key;
- a **placeholder mismatch** between the two catalogs for the same key;
- any **single-brace placeholder**, in either catalog;
- a `t("…")` call in `app/` whose key does not exist in `en-US`;
- a missing member of a required family, such as an `AppErrorCode` with no `errors.<CODE>` key.

`tests/guards/i18n-catalogs.test.mjs` proves the third rule with a regression fixture: two
catalogs that *agree* on a broken placeholder still fail. That test exists because the earlier
version of the guard compared the two catalogs to each other and nothing else, so two equally
broken catalogs passed.

## Norwegian: current status

**`nb-NO` is prepared but not selectable at runtime.** The framework's locale list is closed —
eleven locales (`en-US`, `es-ES`, `fr-FR`, `de-DE`, `pt-BR`, `zh-CN`, `zh-TW`, `ja-JP`,
`ko-KR`, `hi-IN`, `ar-SA`) in `SUPPORTED_LOCALES`, and Norwegian is not among them. So
`nb-NO` is rejected by `set-localization-preference`, filtered out of the language picker, and
has no framework UI catalog of its own.

The app catalog exists anyway, wired behind a deliberate compile-time marker:

```ts
localeLoaders: {
  // Norwegian is not in the framework's locale list yet (BuilderIO/agent-native#3985).
  // @ts-expect-error — remove when the framework accepts nb-NO
  "nb-NO": () => import("./nb-NO"),
},
```

`@ts-expect-error` **fails** when the error it expects goes away. So the moment the framework
adds `nb-NO` to its locale type, `pnpm typecheck` breaks with *unused @ts-expect-error* and
whoever runs it discovers that Norwegian is now supported. That is the point: a `@ts-ignore`
would have hidden it forever.

`app/i18n/nb-NO.ts` carries a marker of its own on line one:

```ts
// REVIEW: translated by Codex, needs native review
```

Leave it until a native speaker has read the file. It is the honest state of that translation
and it costs nothing.

The upstream request is [BuilderIO/agent-native#3985](https://github.com/BuilderIO/agent-native/issues/3985)
(2026-08-30), asking for app-registered locales. Until it merges:

- Norwegian is not selectable in a deployed app.
- An application that needs it now can carry the framework change as a **package patch**,
  tracked in `docs/upgrade-playbook.md` so an upgrade does not silently drop it. That is a real
  cost — a patch has to be re-derived on every framework release — so weigh it against waiting.
- The guard still enforces full parity between `en-US` and `nb-NO`, which keeps the catalog
  from rotting while it waits.

## Adding a locale

For a locale the framework already supports — `de-DE`, say:

1. **Copy the catalog and translate it.**
   ```bash
   cp app/i18n/en-US.ts app/i18n/de-DE.ts
   ```
   Keep every key. Keep every `{{placeholder}}` exactly as it is.
2. **Register it** in `app/i18n/index.ts`:
   ```ts
   localeLoaders: {
     "de-DE": () => import("./de-DE"),
     "nb-NO": () => import("./nb-NO"),
   },
   supportedLocales: ["en-US", "de-DE"],
   ```
   `supportedLocales` is what the language picker offers. Omit it and the picker shows all
   eleven of the framework's, most of which your app catalog does not cover.
3. **Teach the guard about it.** `scripts/check-i18n-catalogs.mjs` currently compares `en-US`
   against `nb-NO`; add the new file to its list so parity is enforced for it too. A locale the
   guard does not know about will drift.
4. **Check it.**
   ```bash
   pnpm guard:i18n
   pnpm check
   ```
5. **Look at it in a browser.** Switch the language in **Settings** and walk the three feature
   areas. German is about 30% longer than English and will find every layout that assumed a
   short label — which is the actual reason to do this step rather than trust the guard.

For a locale the framework does *not* support, the `nb-NO` treatment above is the pattern:
catalog plus `@ts-expect-error`, plus an upstream request.

Right-to-left locales (`ar-SA`) carry `dir: "rtl"` in the framework's locale metadata and the
framework handles the document direction. The application's own layouts are flexbox and grid
and should follow, but nobody has checked — if you enable it, look at every page.

## Dates, numbers and the language picker

Never format a date by hand. `useFormatters()` returns locale-aware formatters, so a date is
rendered in the user's locale rather than the developer's:

```tsx
const { formatDateTime } = useFormatters();
<span>{t("jobs.scheduledFor", { date: formatDateTime(job.scheduledAt) })}</span>
```

Timestamps are stored as ISO 8601 UTC strings with milliseconds
(`new Date().toISOString()`) and compared lexicographically, which is why they sort correctly
in SQL. Formatting is a presentation concern and happens once, in the browser, at the last
moment.

The picker is the framework's `<LanguagePicker />`, rendered on `/settings`. It writes the
user's preference through `set-localization-preference`, so the choice follows the user across
devices rather than living in one browser's storage.

## What is not translated

Deliberately:

- **`agent/AGENTS.md`**, the runtime agent's system prompt, is English. The agent is instructed
  to *answer* in the language the interface is set to, which is the behaviour that matters; the
  prompt itself is developer-facing.
- **Action `description` fields.** Also a prompt, also read by the model, also English.
- **Server error messages.** `AppError` messages are English and safe; the browser translates
  them by `errorCode` and only falls back to the raw message for a code it does not have a key
  for. An agent or an HTTP client sees the English message, which is correct — it is a protocol
  string, not a UI string.
- **Log lines and audit summaries.** Records, not user interface.
- **This documentation.**

If a customer needs error messages in their language on a non-browser surface, the translation
belongs at that surface, keyed on `errorCode` — not in `src/application`, which must stay free
of presentation concerns.
