# T14 — User interface

Goal: the minimal, usable UI from B17 on top of the scaffold's shell, calling only actions.

Depends on: T10, T27. Read: F4 (client imports), F5 (client hooks); B2 (ui rules), B17, B22; D08, D26.

## Steps

1. Routes (`app/routes/`): `jobs.tsx` (list + status filter + "New job" dialog),
   `jobs_.$id.tsx` (detail with Start, Complete, Reschedule, Archive and the job's operation
   list from `list-recent-activity` with `resourceType: "job", resourceId`), `customers.tsx`
   (list + "New customer" dialog + archive button), `customers_.$id.tsx`, `activity.tsx`
   (recent operations with Undo/Redo buttons using the `undoable`/`redoable` flags). The
   trailing underscore on the two detail files is required: `flatRoutes()` makes
   `jobs.$id.tsx` a **child** of `jobs.tsx`, which renders no `<Outlet />`, so `/jobs/:id`
   serves the list page. Keep `team.tsx`, `settings*.tsx`, `observability.tsx`, `agent.tsx`,
   `home.tsx` and `chat.$threadId.tsx` (`home.tsx` is the agent chat page and
   `chat.$threadId.tsx` re-exports it); nobody lands there by default because `_index.tsx`
   navigates to `/jobs` and the framework's `app.homePath` is set to `/jobs` (it is `/home` in
   `server/plugins/agent-native-email-branding.ts` or `server/plugins/config.ts`; find it with
   `grep -rn homePath server/`). Sidebar entries: Jobs, Customers, Activity, Team, Settings.
2. Components under `app/components/jobs/`, `app/components/customers/`,
   `app/components/activity/`: forms use `react-hook-form` (present in the scaffold) with Zod
   for shape only; business rules stay server-side. Every form control carries an `aria-label`
   (a placeholder is not a label). Status badges; every date-time rendered through
   `useFormatters()`. Route components render sections, not a `<main>`: the scaffold `Layout`
   already provides the document's only `main` landmark.
3. Mutations: `useActionMutation("<name>")`; on success invalidate the affected `list-*` and
   `get-*` queries and call `toast(<message>, { action: { label: t("common.undo"), onClick: () =>
   undo(operationId) } })`; offer Undo/Redo only when the history policy says the resulting operation permits it; creates have no Redo and irreversible exports have no Undo. On error show
   `t("errors." + errorCode)` when `errorCode` is present, else `actionErrorMessage(err)`.
4. Role-aware UI: `useOrgRole()` hides the archive-customer button and the "Send to accounting"
   button (job detail, visible only when the job is completed and not yet sent; opens a
   confirmation dialog stating the action is irreversible; shows the returned reference
   afterwards) for members; the server still enforces (T09, T27).
5. Header shows `session.email` and the framework `OrgSwitcher` (keep the scaffold header if it
   already does).
6. Every user-visible string goes through `useT()`; add keys to `app/i18n/en-US.ts` (T15 adds
   `nb-NO`). No hard-coded English in components.
7. Verify manually with `pnpm db:reset && pnpm dev && pnpm db:seed`: create a customer, create a
   job for it, start, reschedule, complete, undo from the toast, redo from the toast, archive;
   the activity page lists every operation including undo/redo with kind labels; the member
   account does not see the archive-customer button; with an `ANTHROPIC_API_KEY` in `.env` the
   agent sidebar answers "list my jobs" using `list-jobs` (optional).

## Deliverables

`app/routes/*`, `app/components/{jobs,customers,activity}/*`, `app/components/layout/Sidebar.tsx`,
`app/i18n/en-US.ts`.

## Acceptance

```bash
pnpm check
pnpm build:worker
```
plus screenshots or a short transcript of step 7 in the PR.
