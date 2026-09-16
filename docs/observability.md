# Observability

Three different records, deliberately kept apart, because they answer different questions and
have different privacy properties.

| Record | Owner | Contains | Answers |
| --- | --- | --- | --- |
| **The audit trail** (`agent_audit_log`) | The framework | who, when, which surface, which target, redacted input, status | "Who completed that job, and from where?" |
| **The operation ledger** (`operations`) | This application | versions, classification, the inverse, the payload | "Can this still be undone, and how?" |
| **Structured logs** (Workers Logs) | Cloudflare | action name, outcome, error code, caller, `orgId`, duration | "Is the system healthy, and what is failing?" |

The rule that keeps them apart: **a log line never contains a value.** Not an email, not an
argument, not a result, not a row. If you want to know what the data was, that is the audit
trail's job, and reading it requires being signed in as an owner or admin of that organization.

- [The action log line](#the-action-log-line)
- [Workers Logs](#workers-logs)
- [The audit trail](#the-audit-trail)
- [The observability page](#the-observability-page)
- [Health and readiness](#health-and-readiness)
- [What to alert on](#what-to-alert-on)
- [Sentry, if you want it](#sentry-if-you-want-it)
- [Telemetry stance](#telemetry-stance)

## The action log line

`src/infrastructure/logging.ts` writes exactly one JSON object per action call, success or
failure, from `runAppAction`:

```json
{"level":"info","event":"action","action":"complete-job","outcome":"success",
 "caller":"frontend","orgId":"org_acme","durationMs":14}
```

```json
{"level":"error","event":"action","action":"archive-customer","outcome":"error",
 "errorCode":"AUTHORIZATION","caller":"http","orgId":"org_acme","durationMs":3}
```

| Field | Values |
| --- | --- |
| `level` | `info` on success, `error` on failure |
| `event` | always `action` |
| `action` | the action name, e.g. `complete-job` |
| `outcome` | `success` or `error` |
| `errorCode` | present only on `error`: one of the eight `AppErrorCode` values |
| `caller` | `frontend`, `tool`, `mcp`, `http`, `cli`, `automation`, or `unknown` |
| `orgId` | the organization, or `null` |
| `durationMs` | wall clock for the whole action, including the database |
| `requestId` | when the framework supplies one |

That is the complete list, and `logAction` takes a fixed record rather than `unknown` precisely
so it cannot grow accidentally. What it deliberately does not carry: **no email**, no
arguments, no result, no row contents, no SQL.

Two other line shapes exist:

```json
{"level":"error","event":"unexpected-error","action":"complete-job","orgId":"org_acme",
 "message":"…","stack":"…"}
```

Written only for a failure that was *not* already an `AppError` and did not map to one — a
genuine bug. It is the only line that may carry an original message and a stack, because it is
the only record of what actually broke; the caller sees `INTERNAL` and the constant
`"Unexpected error"`.

```json
{"level":"warn","event":"invalid-json-column","message":"…","orgId":"org_acme",
 "details":{"table":"operations","column":"inverse","id":"op_x"}}
```

A recoverable inconsistency the process carried on past with a degraded value. `details` is
identifiers only — the row and column somebody should look at, never the stored value.

## Workers Logs

Enabled by `observability: { "enabled": true, "head_sampling_rate": 1 }` in `wrangler.jsonc`,
inherited by every environment. Sampling is 1 because the request volume this starter is built
for is small enough that sampling would only lose the one interesting request.

```bash
# live
pnpm exec wrangler tail --env production --format pretty

# failures only
pnpm exec wrangler tail --env production --status error

# our action lines, as JSON
pnpm exec wrangler tail --env production --format json --search '"event":"action"'

# one action
pnpm exec wrangler tail --env production --search '"action":"send-job-to-accounting"'
```

The dashboard equivalent — **Workers & Pages** → the Worker → **Logs** — is where retained logs
are queryable. `wrangler tail` is live only: it shows what happens while you are watching, so
it is the tool for reproducing something, not for investigating something that happened an hour
ago.

Retention and volume limits are Cloudflare's and depend on the plan:
<https://developers.cloudflare.com/workers/observability/logs/workers-logs/>.

## The audit trail

`agent_audit_log` is framework-owned and written automatically for every non-GET action —
including the ones that **failed** and the ones that were **denied**, which is what makes it
useful for a security question rather than only an operational one.

| Column | What it holds |
| --- | --- |
| `created_at`, `action` | when, and which action |
| `caller` | `tool`, `frontend`, `http`, `cli`, `mcp`, `a2a` |
| `actor_kind` | `agent`, `human`, `system` |
| `actor_email`, `org_id` | who, and in which organization |
| `thread_id`, `turn_id` | which agent conversation, when the caller was the agent |
| `target_type`, `target_id` | from the action's `audit.target` |
| `status` | `success`, `error`, `denied` |
| `summary` | from the action's `audit.summary` — one human-readable line |
| `input` | the arguments, redacted by the framework |
| `error_code` | our `AppErrorCode` on a failure |
| `owner_email`, `visibility` | who may read the row |

Read it through the framework's own actions, which enforce the same organization scoping as
everything else:

```bash
# everything about one job
curl -s -b cookies.txt \
  'https://<host>/_agent-native/actions/list-audit-events?targetType=job&targetId=job_x&limit=50'

# only what the agent did
curl -s -b cookies.txt \
  'https://<host>/_agent-native/actions/list-audit-events?actorKind=agent&limit=100'

# only denials — a run of these is somebody probing
curl -s -b cookies.txt \
  'https://<host>/_agent-native/actions/list-audit-events?status=denied&limit=100'
```

Filters: `targetType`, `targetId`, `actorKind`, `status`, `action`, `sinceMs`, `limit`. There is
also `get-audit-event` for one row and `export-audit-events` for a bulk pull.

Retention is `AGENT_NATIVE_AUDIT_RETENTION_DAYS`: 365 on staging, `0` — forever — on
production. Production keeps it forever because the whole point of an audit trail for a
business's own records is that it outlives the question somebody is going to ask.

GET actions are **not** audited. A read leaves a log line and nothing else, which is a
deliberate trade: auditing every list request would bury the mutations that matter in noise.
If you need read auditing for a compliance reason, `audit: { onRead: true }` on the specific
action is the mechanism.

## The observability page

`/observability` renders the framework's `ObservabilityDashboard`
(`@agent-native/core/client/observability`): the framework's own view of recent activity, agent
runs and errors, scoped to the signed-in user's organization. It is the non-technical answer to
"what has been happening", and it needs no Cloudflare access.

`/activity` is the application's own view — the operation ledger with Undo and Redo — and is
the one a user actually works in. `docs/undo-and-history.md` covers it.

## Health and readiness

Two endpoints, two questions. Both are public, because a probe that needs a session cannot tell
"not deployed" from "not signed in".

```bash
curl -s https://<host>/_agent-native/ping
# {"message":"pong"}                     — the Worker is running

curl -s https://<host>/_agent-native/health
# {"ok":true,"ready":true,"db":true,"database":{"dialect":"d1"},…}
#                                        — the framework is up and can reach the database

curl -s https://<host>/api/ready
# {"ready":true,"migrations":{"applied":2,"expected":2,"missing":[]}}
#                                        — the schema is what this build expects; 503 if not
```

Point an uptime check at `/api/ready`, not at `/`. `/` is a static asset served by the
`ASSETS` binding before the Worker runs, so it returns 200 even when the Worker is broken.
`/api/ready` returns 503 when the database is behind, which is exactly the state you want to be
paged about after a partial deploy.

Under `wrangler dev` the health endpoint reports `auth.hostMismatch: true` (`localhost` versus
`127.0.0.1`). Harmless locally.

## What to alert on

For an application of this size, four things are worth waking somebody for, and the rest is
noise:

1. **`/api/ready` returning 503** for more than a minute or two. The schema and the code
   disagree — usually a partial deploy.
2. **`/_agent-native/health` failing or `db: false`.** The database is unreachable.
3. **A missing nightly backup run.** `gh run list --workflow=backup-d1.yml` should have one run
   per day. The gap between "backups stopped" and "somebody noticed" is the window you cannot
   recover.
4. **A burst of `level: "error"` action lines**, especially `errorCode: "INTERNAL"` (a bug) or a
   run of `AUTHORIZATION` (somebody probing).

Not worth alerting on: individual `CONFLICT` errors (two people editing the same record is
normal), `VALIDATION` errors (a user typed something wrong), or `EXTERNAL` errors unless they
persist — a retry reconciles a pending export, so one timeout is not an incident.

## Sentry, if you want it

The framework wires Sentry when `SENTRY_DSN` is set, and it is **deliberately never set** in
this starter (D17): `scripts/check-config-hygiene.mjs` lists `SENTRY_DSN` among the forbidden
keys and fails the build if it appears anywhere, and the Playwright suite asserts that no
browser request leaves the app's origin.

The reasoning is not that Sentry is bad. It is that an error tracker receives whatever an
exception happened to be carrying — argument values, row contents, an email in a stack frame —
and this application's whole logging design is built on the rule that a value never leaves the
database. Turning it on means deciding, deliberently and in writing, what a customer's data
crossing into a third party means for that customer.

If you decide you want it:

1. Remove `SENTRY_DSN` from `FORBIDDEN_KEYS` in `scripts/check-config-hygiene.mjs`, and add the
   Sentry ingest origin to the Playwright no-phone-home allowance. Both will fail otherwise,
   which is the design working.
2. Set `SENTRY_DSN` as a Worker secret per environment.
3. Configure Sentry's own scrubbing before you send anything: deny-list the fields, turn off
   request-body capture, and check what a real exception actually contains.
4. Write down, in this file, what you decided and why. The next person needs to know it was a
   decision.

## Telemetry stance

Nothing phones home. Concretely:

| Would send | Only when | Configured here |
| --- | --- | --- |
| Browser analytics to `analytics.agent-native.com` | `VITE_AGENT_NATIVE_ANALYTICS_PUBLIC_KEY` is set | **Never** |
| Builder.io APIs (`api.builder.io/agent-native/…`) | `BUILDER_PRIVATE_KEY` or a Builder connection exists | **Never** — `onboarding.firstRun: "off"` |
| Sentry | `SENTRY_DSN` is set | **Never** |
| Anthropic | The agent is used | Yes, by design: `ANTHROPIC_API_KEY`, deployment-level, owned by the customer |

Two independent checks keep it that way, and they check different things:

- **Configuration**: `scripts/check-config-hygiene.mjs` (in `pnpm check` and in CI) fails if any
  of those key names appears in `.env.example`, `.dev.vars.example`, `.bootstrap.env.example`,
  `agent-native.config.ts` or any `wrangler.jsonc` `vars` block.
- **Behaviour**: every Playwright page fixture fails the test on any request whose origin
  differs from `baseURL`. So a dependency that starts calling an analytics endpoint fails the
  browser suite even if no configuration changed — which is the only place that could catch it.

The Anthropic key is the one deliberate outbound dependency: the embedded agent sends the
conversation and the tool schemas to Anthropic. That is the product working as designed, it is
billed to whoever owns the deployment, and it is worth saying out loud to the customer whose
data it is. There is no Builder.io connection and no per-user provider key.
