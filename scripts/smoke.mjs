#!/usr/bin/env node
import { parseArgs } from "node:util";

import { CookieClient, detail } from "./lib/http-client.mjs";

const USAGE = `usage: node scripts/smoke.mjs --base-url <url> --mode local|staging|production
       [--qa-email <email> --qa-password <password> --expect-org-id <id>]
       [--run-id <id>] [--timeout-ms <milliseconds>]

Production mode performs public, read-only checks only.`;

export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      "base-url": { type: "string" },
      mode: { type: "string" },
      "qa-email": { type: "string" },
      "qa-password": { type: "string" },
      "expect-org-id": { type: "string" },
      "run-id": { type: "string" },
      "timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return { help: true };
  if (!values["base-url"]) throw new Error(`--base-url is required\n${USAGE}`);
  if (
    !values.mode ||
    !["local", "staging", "production"].includes(values.mode)
  ) {
    throw new Error(`--mode must be local, staging or production\n${USAGE}`);
  }
  const timeoutMs = Number(values["timeout-ms"] ?? 120_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("--timeout-ms must be a positive integer");
  if (values.mode !== "production") {
    for (const key of ["qa-email", "qa-password", "expect-org-id"]) {
      if (!values[key])
        throw new Error(`--${key} is required in ${values.mode} mode`);
    }
  }
  return {
    help: false,
    baseUrl: new URL(values["base-url"]).origin,
    mode: values.mode,
    qaEmail: values["qa-email"],
    qaPassword: values["qa-password"],
    expectOrgId: values["expect-org-id"],
    runId: values["run-id"] ?? `${Date.now()}`,
    timeoutMs,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

// Both spellings on purpose. The hyphenated names are the AI SDK's; the underscored
// ones are what this framework's agent-chat route actually emits, and a real run reaches
// `tool_input_start` — the model choosing a tool — long before it reaches any text.
// Without them a working agent looks like silence: the first two kilobytes of a healthy
// stream are a keepalive, two `activity` lines, `model_stream`, empty `thinking`, and
// then tool-input deltas (T28).
const MEANINGFUL_SSE_TYPES = new Set([
  "text",
  "text-delta",
  "tool-call",
  "tool-result",
  "finish",
  "message",
  "tool_input_start",
  "tool_call",
  "tool_result",
]);

export async function readSseEvidence(response, maxBytes = 8192) {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", events: [], evidence: undefined };
  const decoder = new TextDecoder();
  let text = "";
  let parsedThrough = 0;
  const events = [];
  try {
    while (text.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const completeThrough = text.lastIndexOf("\n\n");
      if (completeThrough < parsedThrough) continue;
      const blocks = text.slice(parsedThrough, completeThrough).split(/\n\n+/);
      parsedThrough = completeThrough + 2;
      for (const block of blocks) {
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const event = JSON.parse(line.slice(5).trim());
            events.push(event);
            if (
              event?.type === "error" ||
              MEANINGFUL_SSE_TYPES.has(event?.type) ||
              event?.toolCall ||
              event?.content
            ) {
              return { text: text.slice(0, maxBytes), events, evidence: event };
            }
          } catch {}
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text: text.slice(0, maxBytes), events, evidence: undefined };
}

export async function runSmoke(
  options,
  { fetchImpl = fetch, log = console.log } = {},
) {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  // 15s is generous against a local Worker, where every request answers in
  // milliseconds, and tight against one that was deployed seconds ago: a runner
  // measured 5.1s for a bare `ping` and 6.1s for a login on a cold Worker,
  // settling to 1-2s once warm (DISCREPANCIES.md, 2026-09-15). A remote smoke
  // runs in exactly that cold window, so it gets a ceiling to match while the
  // local one keeps the tight bound that makes a genuine hang obvious fast.
  const requestTimeoutMs = options.mode === "local" ? 15_000 : 45_000;
  const client = new CookieClient(options.baseUrl, {
    fetchImpl,
    timeoutMs: Math.min(options.timeoutMs, requestTimeoutMs),
  });
  let failures = 0;
  // One deadline covers the whole run, so the first check to exhaust it fails
  // and every check after it aborts instantly with the same message. Reporting
  // all of them as plain failures made one slow check look like three broken
  // ones on the first real staging smoke (DISCREPANCIES.md, 2026-09-14). Name
  // the check that ran out of budget, and mark the rest as not run.
  let budgetExhaustedBy;
  const check = async (name, fn) => {
    if (budgetExhaustedBy !== undefined) {
      failures += 1;
      log(
        `[skip] ${name}: not run — the ${options.timeoutMs}ms run budget was already exhausted by "${budgetExhaustedBy}"`,
      );
      return;
    }
    const started = Date.now();
    try {
      await fn();
      log(`[ok] ${name}`);
    } catch (error) {
      failures += 1;
      if (deadline.aborted) {
        budgetExhaustedBy = name;
        log(
          `[fail] ${name}: exhausted the ${options.timeoutMs}ms run budget for the whole smoke (this check had ${Date.now() - started}ms of it). Raise --timeout-ms, or find why this check is slow.`,
        );
        return;
      }
      log(
        `[fail] ${name}: ${detail(error instanceof Error ? error.message : error)}`,
      );
    }
  };
  const action = async (name, body, expected = 200, activeClient = client) => {
    const result = await activeClient.json(`/_agent-native/actions/${name}`, {
      method: "POST",
      body,
      signal: deadline,
    });
    assert(
      result.response.status === expected,
      `HTTP ${result.response.status}: ${detail(result.body)}`,
    );
    return result.body;
  };

  await check("ping", async () => {
    let last = "unreachable";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (deadline.aborted) throw deadline.reason;
      try {
        const { response, body } = await client.json("/_agent-native/ping", {
          signal: deadline,
        });
        if (response.status === 200 && body?.message === "pong") return;
        last = `HTTP ${response.status}: ${detail(body)}`;
      } catch (error) {
        last = error instanceof Error ? error.message : `${error}`;
      }
      await sleep(2_000);
    }
    throw new Error(last);
  });
  // Local runs a SQLite file and deployments run PostgreSQL, and the point of the check is
  // that the app reached a real database rather than a default it invented — so it asserts
  // the dialect the mode actually implies rather than one spelling everywhere (T28).
  const expectedDialect = options.mode === "local" ? "sqlite" : "postgres";
  await check(`health uses ${expectedDialect}`, async () => {
    const { response, body } = await client.json("/_agent-native/health", {
      signal: deadline,
    });
    assert(
      response.status === 200 &&
        body?.db === true &&
        body?.database?.dialect === expectedDialect,
      `HTTP ${response.status}: ${detail(body)}`,
    );
  });
  await check("migrations ready", async () => {
    const { response, body } = await client.json("/api/ready", {
      signal: deadline,
    });
    assert(
      response.status === 200 &&
        body?.migrations?.applied === body?.migrations?.expected,
      `HTTP ${response.status}: ${detail(body)}`,
    );
  });
  for (const [name, path] of [
    ["sign-in HTML", "/sign-in"],
    ["root static shell", "/"],
  ]) {
    await check(name, async () => {
      const response = await client.request(path, { signal: deadline });
      const body = await response.text();
      assert(
        response.status === 200 &&
          /text\/html/i.test(response.headers.get("content-type") ?? "") &&
          /<html/i.test(body),
        `HTTP ${response.status}`,
      );
    });
  }
  await check("unauthenticated list-events is 401", async () => {
    const anonymous = new CookieClient(options.baseUrl, { fetchImpl });
    const response = await anonymous.request(
      "/_agent-native/actions/list-events",
      { signal: deadline },
    );
    assert(response.status === 401, `HTTP ${response.status}`);
  });

  if (options.mode !== "production") {
    await check("QA login and organization", async () => {
      const login = await client.json("/_agent-native/auth/login", {
        method: "POST",
        body: { email: options.qaEmail, password: options.qaPassword },
        signal: deadline,
      });
      assert(
        login.response.status === 200,
        `login HTTP ${login.response.status}: ${detail(login.body)}`,
      );
      const me = await client.json("/_agent-native/org/me", {
        signal: deadline,
      });
      assert(
        me.response.status === 200 && me.body?.orgId === options.expectOrgId,
        `org/me: ${detail(me.body)}`,
      );
    });
    await check("authenticated list-events", async () => {
      const { response, body } = await client.json(
        "/_agent-native/actions/list-events",
        { signal: deadline },
      );
      assert(
        response.status === 200 && Array.isArray(body),
        `HTTP ${response.status}: ${detail(body)}`,
      );
    });

    let created;
    await check("reversible write, conflict, undo and isolation", async () => {
      const events = await client.json("/_agent-native/actions/list-events", {
        signal: deadline,
      });
      const event = events.body?.find?.(
        (candidate) => candidate.status === "active",
      );
      assert(
        events.response.status === 200 && event?.id,
        `events: ${detail(events.body)}`,
      );
      created = await action("create-seating-table", {
        eventId: event.id,
        name: `Worker smoke ${options.runId}`,
        size: 2,
        idempotencyKey: `smoke-${options.runId}`,
      });
      assert(
        created?.resource?.version === 1 && created?.operationId,
        `create: ${detail(created)}`,
      );
      const labelled = await action("label-seat", {
        tableId: created.resource.id,
        seat: 0,
        label: "Smoke test",
        expectedVersion: 1,
      });
      assert(
        labelled?.resource?.seats?.[0]?.label === "Smoke test",
        `label: ${detail(labelled)}`,
      );
      // The version guard: the caller's `expectedVersion` is now stale.
      await action(
        "archive-seating-table",
        { tableId: created.resource.id, expectedVersion: 1 },
        409,
      );
      const undone = await action("undo-operation", {
        operationId: labelled.operationId,
      });
      assert(
        undone?.resource?.seats?.[0]?.label === "",
        `undo: ${detail(undone)}`,
      );

      if (options.mode === "local") {
        const outsider = new CookieClient(options.baseUrl, { fetchImpl });
        const login = await outsider.json("/_agent-native/auth/login", {
          method: "POST",
          body: {
            email: "outsider@example.invalid",
            password: options.qaPassword,
          },
          signal: deadline,
        });
        assert(
          login.response.status === 200,
          `outsider login HTTP ${login.response.status}`,
        );
        const isolated = await outsider.json(
          `/_agent-native/actions/get-event?eventId=${encodeURIComponent(event.id)}`,
          { signal: deadline },
        );
        assert(
          isolated.response.status === 404,
          `cross-org read HTTP ${isolated.response.status}: ${detail(isolated.body)}`,
        );
      }
      const archived = await action("archive-seating-table", {
        tableId: created.resource.id,
        expectedVersion: undone.resource.version,
      });
      assert(
        archived?.resource?.status === "archived",
        `cleanup: ${detail(archived)}`,
      );
    });

    await check("agent chat SSE", async () => {
      const response = await client.request("/_agent-native/agent-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "List our events." }),
        signal: deadline,
      });
      assert(
        response.status === 200 &&
          /text\/event-stream/i.test(
            response.headers.get("content-type") ?? "",
          ),
        `HTTP ${response.status}`,
      );
      const { text, events, evidence } = await readSseEvidence(response);
      assert(events.length > 0, `no SSE event in first ${text.length} bytes`);
      assert(
        evidence,
        `no error or meaningful event in first ${text.length} bytes`,
      );
      const firstError = events.find((event) => event.type === "error");
      if (options.mode === "local")
        assert(
          firstError?.errorCode === "missing_credentials",
          `expected missing_credentials: ${detail(events)}`,
        );
      else
        assert(!firstError, `stream began with error: ${detail(firstError)}`);
    });
  }

  await check("unauthenticated MCP challenge", async () => {
    const anonymous = new CookieClient(options.baseUrl, { fetchImpl });
    const response = await anonymous.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: deadline,
    });
    assert(
      response.status === 401 && response.headers.has("www-authenticate"),
      `HTTP ${response.status}, WWW-Authenticate=${response.headers.get("www-authenticate")}`,
    );
  });
  return failures === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      process.exit(0);
    }
    process.exitCode = await runSmoke(options);
  } catch (error) {
    console.error(`smoke: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
