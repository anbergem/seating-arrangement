# Upstream issue draft — BuilderIO/agent-native

Status: draft. **The maintainer opens this issue; do not open it from a task.**
Written by task T02; the workaround it describes lives in `scripts/patch-worker-bundle.mjs`.

---

**Title**

`cloudflare_pages` worker bundle: default-import `fs`/`os` stubs throw (agent-chat init fails)

---

**Framework version**

- `@agent-native/core` 0.176.5 (also reproduced against nightly 0.177.0)
- `wrangler` 4.129.0, `workerd` 1.20260903.1
- Node 22 LTS, pnpm 11, macOS and Linux

**What happens**

Building the `chat` template for Cloudflare and running the output as a Worker boots, but the
agent-chat plugin fails to initialise and several routes are dead:

```
[agent-chat] Plugin init failed — registering error fallback: fs.existsSync is unavailable in Cloudflare Pages workers
```

and, on the agent chat route:

```
os.homedir is unavailable in Cloudflare Pages workers
```

Consequences in the running Worker: `POST /_agent-native/agent-chat` returns 503, the audit
actions (for example `list-audit-events`) 404, and `POST /mcp` 404 instead of the expected 401
challenge. `GET /_agent-native/ping` and `GET /_agent-native/health` are unaffected, so the
Worker looks healthy from a naive smoke test.

**Reproduction**

```bash
npx @agent-native/core@0.176.5 create chat-repro --standalone --template chat --yes
cd chat-repro
NITRO_PRESET=cloudflare_pages NODE_ENV=production pnpm exec agent-native build
```

Deploy `dist/` as a Worker (not a Pages project) with a D1 binding:

```jsonc
{
  "name": "chat-repro",
  "main": "dist/_worker.js/index.js",
  "compatibility_date": "2026-09-05",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "dist", "binding": "ASSETS" },
  "d1_databases": [{ "binding": "DB", "database_name": "chat-repro-local", "database_id": "00000000-0000-0000-0000-000000000000" }],
  "vars": { "NODE_ENV": "production" }
}
```

```bash
wrangler dev --port 8787 --ip 127.0.0.1 --local
```

The `fs.existsSync` line appears in the boot log; the `os.homedir` line appears on the first
agent-chat request.

**Root cause**

`packages/core/src/deploy/build.ts`, `cloudflareNodeBuiltinStubSource`, replaces the Node
built-ins with stub modules. The safe implementations (`existsSync`, `homedir`, …) are provided
as **named** exports only. The module's **default** export is a `Proxy` whose `get` trap
unconditionally calls the "unavailable" thrower:

```js
get(target, property) { return unavailable("fs." + String(property)); }
```

so any code written as `import fs from "node:fs"` / `import os from "node:os"` throws on first
property access, even for properties the stub deliberately makes safe. Two callers in the
framework's own code do exactly that:

- `loadHostedHarnessConfig` → the workspace-core lookup, which uses `fs.existsSync`
- the mcp-client config reader, which uses `os.homedir`

Both run during agent-chat plugin init, which is why the failure takes the whole plugin (and
with it the audit and MCP routes) down rather than just one call.

**Proposed fix**

Make the default-export proxy consult the same override table the named exports come from, and
only fall through to `unavailable(...)` when the property has no safe implementation. That is a
change local to `cloudflareNodeBuiltinStubSource` and keeps the loud failure for the genuinely
unsupported surface.

**Workaround we apply**

Until the fix lands we patch the built bundle (`dist/_worker.js/index.js`) after every build,
rewriting the two proxy getters so a small safe table wins before the thrower:

```js
// fs default-export proxy getter
/get\((\w+),(\w+)\)\{return (\w+)\("fs\."\+String\((\w+)\)\)\}/
// becomes:
get(A,P){const __safe={existsSync:()=>false,readdirSync:()=>[],realpathSync:(v)=>v,mkdirSync:()=>undefined,rmSync:()=>undefined,constants:{},promises:{}};if(Object.prototype.hasOwnProperty.call(__safe,P))return __safe[P];return U("fs."+String(P2))}

// os default-export proxy getter
/get\((\w+),(\w+)\)\{return (\w+)\("os\."\+String\((\w+)\)\)\}/
// becomes the same shape with:
__safe={homedir:()=>"/",tmpdir:()=>"/tmp",platform:()=>"linux",hostname:()=>"worker",EOL:"\n",cpus:()=>[],totalmem:()=>0,freemem:()=>0,release:()=>"",type:()=>"Linux",arch:()=>"x64",userInfo:()=>({username:"worker"})}
```

Each pattern matches exactly once in a 0.176.5 build; our script fails the build otherwise. With
the patch applied, ping, health, register, login, org/me, app actions, `list-audit-events`,
agent chat (SSE) and `POST /mcp` (401 with a `WWW-Authenticate` challenge) all behave.
