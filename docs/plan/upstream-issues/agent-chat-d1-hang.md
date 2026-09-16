# Upstream issue draft — BuilderIO/agent-native

Status: draft. **The maintainer opens this issue; do not open it from a task.**
Written 2026-09-11.

---

**Title**

`POST /_agent-native/agent-chat` never responds under `wrangler dev`: a local D1 query hangs
7ms into the request, before the model is reached

---

**Framework version**

- `@agent-native/core` 0.176.5, `@agent-native/toolkit` 0.19.3
- `wrangler` 4.129.0, `workerd` 1.20260903.1, local (miniflare) D1
- Build: the `cloudflare_pages` single-file bundle deployed as a Worker
- Node 22, pnpm 11, macOS

**What happens**

With a provider credential configured, `POST /_agent-native/agent-chat` sends **no response
headers at all** — not an SSE stream, not an error. The client waits indefinitely (observed to 5
minutes). The same request against the Node dev server works normally and the agent answers.

**What it is not**

Each of these was checked from inside the Worker, via a temporary route in the same app:

| Check | Result |
| --- | --- |
| Route reachable, unauthenticated | 401 in 56ms |
| Route reachable, authenticated, `{}` body | 400 in 13ms (`message is required`) |
| `fetch("https://api.anthropic.com/v1/models")` with a bogus key | 401 in 193ms |
| `resolveCredential("ANTHROPIC_API_KEY", { userEmail, orgId })` | resolved, 3ms |
| One-token `claude-haiku-4-5` call with that resolved key | HTTP 200 in 804ms |

So routing, auth, egress, credential storage and decryption, and the provider API all work from
inside the Worker.

**Where it hangs**

Wrangler's local observability API (`/cdn-cgi/local/explorer/api/local/observability/query`) over
the `spans` table, for one hung request:

```
+0ms  POST    outcome=NULL        <- never completes
+1ms  d1_all  ok  2ms
+3ms  d1_all  ok  1ms     +3ms  d1_all ok 0ms
+4ms  d1_all  ok  0ms     +4ms  d1_all ok 0ms
+6ms  d1_all  ok  1ms     +6ms  d1_all ok 0ms
+7ms  d1_all  outcome=NULL        <- eighth query never returns
+7ms  fetch   outcome=NULL        <- its miniflare D1 call never returns
```

Seven D1 queries complete in 0–2ms; the eighth never does. In one session, 34 requests and 12
`d1_all` spans were stuck while 7,506 other `d1_all` queries in the same process completed
normally.

We could not name the statement. Patching the `getDbExec()` singleton's methods in place logged
nothing for this request, so the framework's own tables are reached through a different path, and
`d1_all` is workerd's own instrumentation of the D1 binding.

**Questions**

1. Does the agent-chat request path issue a D1 query from a context that can deadlock under
   miniflare's local D1 — for example a query issued from inside another D1 call's continuation, or
   while a Durable Object input gate is held?
2. Is this local-only? Does the same request work against a deployed Worker with real D1? If it is
   local-only it is still worth fixing, because `wrangler dev` is the documented local rehearsal.
3. Would you accept a smoke check in the template that exercises the *credentialled* path? Ours
   asserts the stream opens with `missing_credentials`, which passes precisely because the
   credentialled path never runs.

**Reproduction**

Any app on the Workers/D1 path with a provider credential stored for the signed-in user (settings
UI, or `saveCredential`), then `pnpm dev:worker` and a POST to `/_agent-native/agent-chat` with
`{"message":"..."}`.
