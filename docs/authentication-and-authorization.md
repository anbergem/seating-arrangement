# Authentication and authorization

Three different questions, answered in three different places. Confusing them is the most
common way an application like this gets a security hole.

| Question | Name | Answered by | Where |
| --- | --- | --- | --- |
| Who is this? | **Identity** | The framework (Better Auth) | Session cookie, Google or password |
| Are they in this organization, and as what? | **Membership** | `org_members`, read fresh per call | `resolveActor` in `src/application/actor.ts` |
| May this role do this? | **Capability** | Our policy module | `requireCapability` in `src/application/authorization.ts` |

All three are checked on the server, in that order, inside every action. None of them is
checked in the browser.

- [Identity](#identity)
- [Environment policies](#environment-policies)
- [Google sign-in setup](#google-sign-in-setup)
- [Adding another provider](#adding-another-provider)
- [Membership and roles](#membership-and-roles)
- [Capabilities](#capabilities)
- [History authorization](#history-authorization)
- [Require Google per organization](#require-google-per-organization)
- [QA accounts](#qa-accounts)
- [What the UI does, and why it is not security](#what-the-ui-does-and-why-it-is-not-security)

## Identity

The framework owns authentication. It issues an `an_session` cookie (HttpOnly, SameSite=Lax,
with a companion `an_session_hint`) and exposes:

| Endpoint | Purpose |
| --- | --- |
| `POST /_agent-native/auth/register` | `{ email, password }` → `{ ok: true }` |
| `POST /_agent-native/auth/login` | `{ email, password }` → `{ ok: true }` plus cookies |
| `POST /_agent-native/auth/logout` | Sign out |
| `GET /_agent-native/auth/session` | The current session |
| `GET /_agent-native/org/me` | `{ email, orgId, orgName, role, orgs, … }` |
| `GET /_agent-native/google/auth-url` | Builds the Google authorization URL |
| `GET /_agent-native/google/callback` | The OAuth redirect target |

The application never reads a cookie, never validates a token and never implements a login
form. It receives `ctx.userEmail` and `ctx.orgId` on every action call, and that is its entire
relationship with authentication.

`createAuthPlugin` in `server/plugins/auth.ts` carries one non-obvious setting:
`rootAuth: false`. Providing `marketing` at all turns `rootAuth` on by default, which serves
the sign-in document at `/` for **every** visitor, signed in or not, and never reaches the
index route. `/` is an ordinary authenticated page here, so it has to be off; the framework's
client session gate still sends an anonymous visitor to `/sign-in`.

## Environment policies

| | local | CI / local worker | staging | production |
| --- | --- | --- | --- | --- |
| Password sign-up | allowed | allowed | allowed (QA) | **refused** |
| Password sign-in | seeded accounts | seeded accounts | seeded QA accounts | refused for members of a Google-required organization |
| Google sign-in | optional | — | configured | **the only way in** |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | `0` | `0` | `0` | `1` |
| Email provider configured | no | no | no | **no** |
| `AUTO_CREATE_DEFAULT_ORG` | `0` | `0` | `0` | `0` |
| `AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT` | `1` | `1` | — | — |

Two of those rows are load-bearing.

**`AUTH_REQUIRE_EMAIL_VERIFICATION=1` with no email provider is what closes production
sign-up.** The framework treats the variable as the declared policy: with `1` and no way to
send a verification email, password sign-up is disabled outright. That is a deliberate use of
the framework's own rule rather than a custom guard, and it means production has no
self-service door at all. The startup check (`server/plugins/00-env-check.ts`) refuses to boot
production without the Google credentials, so the door it closes is never the only one.

**`AUTO_CREATE_DEFAULT_ORG=0` prevents implicit personal organizations; it does not itself make
an authenticated stranger harmless.** The framework separately exposes an authenticated
organization-creation route, and its prefix fallback also reaches that handler. The app's global
request policy denies every self-admission POST before the framework route runs, except invitation
creation and acceptance and the framework's authenticated A2A exchange routes. An uninvited user
therefore has no organization or membership and every action returns `AUTHORIZATION: No active
organization`. Membership is invite-only in every environment: an existing member with `owner`
or `admin` invites people from the Team page.

Domain-based joining exists in the framework (`allowed_domain` on the organization, and
`POST /_agent-native/org/join-by-domain`). It is incompatible with this app's invite-only policy
and is closed from both ends. The request policy denies the manual join route, and it also
denies `PUT /_agent-native/org/domain` — the write that sets `allowed_domain` in the first
place. That second denial is the load-bearing one: a non-empty `allowed_domain` makes the
framework's Better Auth `user.create.after` hook admit every new signup at that domain, which
is self-admission through a path no org route ever sees. Refusing the write means the automatic
path has nothing to match on.

The framework's Team page renders an "Email domain auto-join" control for owners and admins.
This app hides it (`.invite-only-team #email-domain` in `app/global.css`) because the route
behind it is refused — the server denial is the control, and hiding is only there to avoid a
button that always fails. If a deployment somehow has a non-empty `allowed_domain`, clear it
against the database; the route that would clear it from the UI is closed too. Do not use the
domain setting to provision people; send an invitation instead.

The guard (`server/plugins/organization-self-admission.ts`) matches on the path *relative to the
organization mount point*, not on an absolute URL, so it holds unchanged if the application is
later served below an `APP_BASE_PATH`. An unrecognised path shape is denied rather than allowed:
the allow-list names the routes that stay open, and everything else POSTing under the prefix is
refused.

`AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT=1` disables the localhost "Continue as local dev"
button so local development uses the seeded users and therefore exercises real roles. The
button's markup and its translated label are still in the served HTML, hidden by React state —
so check the behaviour, not the page source:

```bash
curl -s http://localhost:8080/_agent-native/auth/local-dev
# {"available":false,"reason":"not-allowed"}
```

## Google sign-in setup

Google Cloud console → **APIs & Services**:

1. **OAuth consent screen** → User type **Internal**. That restricts sign-in to accounts in the
   company's Google Workspace and avoids Google's verification review. Add no scopes beyond
   the defaults: the app asks for identity only (`openid`, `userinfo.email`,
   `userinfo.profile`).
2. **Credentials** → **Create credentials** → **OAuth client ID** → **Web application**.
3. **Authorized redirect URIs** — one per environment:

   ```
   https://<staging host>/_agent-native/google/callback
   https://<production host>/_agent-native/google/callback
   http://localhost:8080/_agent-native/google/callback     (only if you want local Google)
   ```

That path is the framework's own Google callback route, not Better Auth's social callback. The
sign-in page's Google button calls `GET /_agent-native/google/auth-url`, which builds the
authorization URL with `redirect_uri = <origin>/_agent-native/google/callback` — the default in
`resolveOAuthRedirectUri` (`node_modules/@agent-native/core/dist/server/google-oauth.js`). You
can confirm it against your own build rather than trusting this document: set the client id
locally, start the app, and read the URL the framework generates.

```bash
curl -s http://localhost:8080/_agent-native/google/auth-url
# {"url":"https://accounts.google.com/o/oauth2/v2/auth?client_id=…
#   &redirect_uri=http%3A%2F%2Flocalhost%3A8080%2F_agent-native%2Fgoogle%2Fcallback&…"}
```

A mismatch is rejected by Google with `redirect_uri_mismatch` and no other symptom, so it is
worth the thirty seconds.

Then set the credentials as Worker secrets per environment — `scripts/bootstrap.mjs` does this,
or by hand:

```bash
pnpm exec wrangler secret put GOOGLE_SIGN_IN_CLIENT_ID --env production
pnpm exec wrangler secret put GOOGLE_SIGN_IN_CLIENT_SECRET --env production
pnpm exec wrangler secret put OAUTH_STATE_SECRET --env production   # 32+ chars, its own value
```

`OAUTH_STATE_SECRET` signs the OAuth state envelope. It is deliberately separate from the
OAuth client secret: reusing a value that is shared with Google as our own HMAC key would mean
rotating the client secret invalidates every in-flight sign-in, and a client-secret leak
becomes a state-forgery capability. The framework falls back to `BETTER_AUTH_SECRET` if it is
unset, and throws in production if neither exists — set it explicitly.

The redirect URI's origin comes from the request, and `APP_URL` is the canonical public origin
for everything else the framework builds. Set it per environment in `wrangler.jsonc`; a wrong
value shows up as a sign-in loop.

## Adding another provider

The framework supports 35+ social providers through Better Auth, GitHub included, and reads
`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` from the environment when they are present
(`node_modules/@agent-native/core/dist/server/better-auth-instance.js`). Adding one is
configuration, not code:

1. Create the OAuth client with that provider. Its redirect URI is Better Auth's own callback
   path under the mounted base path, `<APP_URL>/_agent-native/auth/ba/callback/<provider>` —
   verify it the same way you verified Google's, against the installed source, before you
   register it.
2. Set the two credentials as Worker secrets for the environment.
3. Decide the membership rule. A new provider changes *how* somebody proves who they are; it
   does not give them a membership row. `AUTO_CREATE_DEFAULT_ORG=0` still means they get
   nothing until an owner or admin invites them, which is the property you want to keep.
4. If the organization has "require Google sign-in" on, members of it cannot use the new
   provider at all. Requiring an identity provider is per organization and single-valued.

Do not add a provider to production without deciding what happens to somebody who has both a
Google and a provider identity for the same address; the framework links accounts by email, so
they become the same user.

## Membership and roles

The framework owns `organizations` and `org_members`. Roles are exactly three.

| Role | Who | Framework powers |
| --- | --- | --- |
| `owner` | The person who set the organization up | Everything, including deleting the organization |
| `admin` | Trusted staff | Invite, remove members, change roles, organization settings |
| `member` | Everybody else | No organization administration |

Organization administration — invitations, role changes, the domain setting, requiring Google —
is the framework's and is already restricted to owner and admin. The application does not
reimplement it; `app/routes/team.tsx` renders the framework's `TeamPage`.

The active organization is the user's `active-org-id` setting, or the first membership if there
is none. With one membership per user — the expected shape for a single-company application —
the membership *is* the active organization.

Role lookup inside an action is a query, not a claim: there is no role on `ctx`.
`src/infrastructure/d1/membership-reader.ts` runs
`SELECT role FROM org_members WHERE org_id = ? AND LOWER(email) = LOWER(?) LIMIT 1` on every
call. So demoting somebody takes effect on their next action, not on their next sign-in.

## Capabilities

`src/application/authorization.ts` maps roles to capabilities. It is the only file that decides
who may do what, and `requireCapability(actor, cap)` is the first statement of every use case.

| Capability | member | admin | owner | Used by |
| --- | :-: | :-: | :-: | --- |
| `events:read` | ✓ | ✓ | ✓ | `list-events`, `get-event` |
| `events:create` | ✓ | ✓ | ✓ | `create-event` |
| `events:archive` | — | ✓ | ✓ | `archive-event` |
| `seating:read` | ✓ | ✓ | ✓ | `get-event` |
| `seating:write` | ✓ | ✓ | ✓ | `create-seating-table`, `move-seating-table`, `rotate-seating-table`, `reshape-seating-table`, `label-seat`, `bootstrap-event-layout`, `resize-room`, `archive-seating-table` |
| `history:read` | ✓ | ✓ | ✓ | `list-recent-activity` |
| `history:undo` | ✓ | ✓ | ✓ | `undo-operation`, `redo-operation` |

`owner` currently grants the same set as `admin`; it is a separate entry because splitting them
later should be a change to this table and nothing else.

A denial is `AppError("AUTHORIZATION", "Role member may not events:archive")` → HTTP 403.
The message names the role and the capability, which is useful in a log and harmless to show:
it tells the caller nothing they could not learn by trying.

The framework offers an `authorize` hook on `defineAction`. It is deliberately not used. Doing
the check inside the use case means it is unit-testable against plain in-memory doubles with no
framework at all, and that there is exactly one call site per use case — so "is this action
authorized on the MCP surface too" is not a question anyone has to ask.

Adding a capability: add it to the union and to `MEMBER_CAPABILITIES` or
`ADMIN_CAPABILITIES`, and update `tests/unit/application/authorization.test.ts`, which asserts
the whole table and will fail until you do.

## History authorization

Undo must not become a way around a capability. Reversing an operation requires `history:undo`
**and** the capability for the effect the reversal actually has
(`src/application/history-policy.ts`):

| Inverse | Requires |
| --- | --- |
| `archive-event` (undoing a create) | `events:archive`, **or** `events:create` if the caller created it themselves |
| `restore-event` (undoing an archive) | `events:archive` |
| every seating inverse | `seating:write` |

So a member may compensate their own `create-event` — archiving an event they just made,
which is the mistake-correction case that matters — but may not undo an admin's archive, and
may not compensate somebody else's create. Seating changes may be reversed by any coworker who
could have made them, because a floor plan is shared work.

`redo-operation` additionally requires the original command's own capability.

Permission is evaluated against the caller's **current** role, not the role they had when the
operation happened. The `undoable` and `redoable` flags in `list-recent-activity` run the same
policy, so the buttons a user sees match what the server will allow.

## Require Google per organization

Once the organization exists and Google sign-in has worked at least once, close the password
door for that organization: **Team** → **Organization** → **Organization sign-in** → turn on
**Require Google sign-in**, and confirm.

That sets `required_auth_provider = 'google'` on the organization row
(`setRequiredAuthProvider` from `@agent-native/core/org`, `PUT /_agent-native/org/auth-provider`,
owner or admin only). Afterwards, password sign-in by a member of that organization is refused
with HTTP 403.

Two things to know before clicking: **it revokes every current session** in the organization,
and it is per organization, not per deployment. Production's Worker var closes sign-*up*; this
setting closes sign-*in*. Both, together, are what "Google only" means.

## QA accounts

Local, CI and staging use five deterministic accounts, created by `scripts/seed.mjs` over HTTP
(never by SQL — the framework hashes passwords):

| Email | Role | Organization |
| --- | --- | --- |
| `owner@example.invalid` | owner | `org_acme` "Acme Services" |
| `admin@example.invalid` | admin | `org_acme` |
| `member1@example.invalid` | member | `org_acme` |
| `member2@example.invalid` | member | `org_acme` |
| `outsider@example.invalid` | owner | `org_other` "Other Company" |

The password is `SEED_PASSWORD`, default `Example-Seed-Password-2026`. It is 16+ characters
because the framework enforces a minimum and returns HTTP 400 below it.

`outsider@example.invalid` exists for one purpose: to prove that organization isolation holds.
It is used by `tests/e2e/isolation.spec.ts`, the integration suite and the Worker smoke.

On staging these accounts are real accounts with a real password, so `SEED_PASSWORD` is a
staging **secret** and the staging deployment resets the QA scenario on every run. Production
is never seeded: `SEED_ENABLED` and `SEED_PASSWORD` are forbidden there and the startup check
refuses to boot if either is set.

## What the UI does, and why it is not security

`app/routes/events_.$id.tsx` hides the archive button from a member using the framework's
`useOrgRole()`. That is a courtesy — an affordance the user cannot act on is noise — and it is
not a control. `tests/e2e/authorization.spec.ts` calls `archive-event` over HTTP as a member
and asserts HTTP 403, which is the actual guarantee.

The same applies to the activity feed's Undo and Redo buttons: they are rendered from the
`undoable` / `redoable` flags, and `undo-operation` re-evaluates everything anyway.

If you find yourself about to write a permission check in `app/`, that is the signal that the
capability is missing from `src/application/authorization.ts`.
