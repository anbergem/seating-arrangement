# Upstream issue draft — BuilderIO/agent-native

Status: draft. **The maintainer opens this issue; do not open it from a task.**
Written on 2026-09-08; the workaround it describes lives in `scripts/eval-suite.ts`.

---

**Title**

`agent-native eval` sends an empty system prompt, so every eval fails on Anthropic with
`cache_control cannot be set for empty text blocks`

---

**Framework version**

- `@agent-native/core` 0.176.5
- Engine: `anthropic`, default model `claude-sonnet-5`
- Node 22, pnpm 11, macOS

**What happens**

`agent-native eval` fails 100% of its evals against the Anthropic engine, with the model never
consulted. Each eval's `error` is:

```
400 {"type":"error","error":{"type":"invalid_request_error",
     "message":"system.0: cache_control cannot be set for empty text blocks"},
     "request_id":"req_…"}
```

The scores are not merely zero but misleading: any scorer asserting an *absence* passes
vacuously (`no-mutations` scores 1 because the agent never ran), so a suite can report a
non-zero average while nothing was evaluated.

**Why**

Three defaults compose:

1. `dist/cli/eval.js` `runEval()` calls `runEvalSuite({ cwd, pattern, thresholdOverride })` and
   never passes `systemPrompt`, although `RunEvalSuiteOptions` accepts one.
2. `dist/eval/agent-runner.js` `createAgentRunner()` defaults it: `config.systemPrompt ?? ""`.
3. `dist/agent/engine/anthropic-engine.js` builds `systemBlocks = [{ type: "text", text: stable }]`
   and, because prompt caching is on by default, sets `systemBlocks[0].cache_control`
   unconditionally. With `stable === ""` that is `cache_control` on an empty text block, which the
   API rejects.

**Expected**

Two independent fixes; either alone stops the 400, and both look right:

1. The engine should not attach `cache_control` to an empty text block — and arguably should emit
   no system block at all for an empty prompt.
2. `agent-native eval` should run the agent the app actually deploys. The app already declares its
   runtime instructions as `instructions.runtime` in `agent-native.config.ts`, and the CLI resolves
   the app's actions through `discoverActions(cwd)` for the same reason. Evaluating an agent with
   the real tools but no system prompt scores something the app never runs: tool choice, refusal
   behaviour and approval gates all live in those instructions.
3. The same applies to the rest of the prompt assembly. `production-agent.ts` prepends
   `buildRuntimeContextPrompt`'s `<runtime-context>` block and injects `buildCurrentTimeUserContext`
   per turn; the eval path does neither, so an evaluated agent cannot answer "show me today's jobs"
   — it does not know what today is, and a well-instructed agent will not guess. In this repository
   that cost one eval and thirty seconds of a paid run to diagnose. Either assemble the deployed
   prompt in `runEvalSuite`, or export `agent/runtime-context` so a caller can: it is not in the
   package export map today, and a deep import is refused with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

**Reproduction**

Any app whose `agent-native.config.ts` sets `instructions.runtime`, with one eval and a funded
`ANTHROPIC_API_KEY`:

```bash
ANTHROPIC_API_KEY=… pnpm exec agent-native eval
```

**Workaround**

`scripts/eval-suite.ts` in this repository calls `runEvalSuite` directly with `systemPrompt` read
from `instructions.runtime`, and mirrors the CLI's arguments, output shape and exit codes.
`scripts/run-evals.mjs` invokes it instead of `agent-native eval`.
