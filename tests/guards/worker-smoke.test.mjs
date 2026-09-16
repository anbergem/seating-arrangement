import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";

import {
  assertPortAvailable,
  terminateProcessGroup,
} from "../../scripts/verify-worker.mjs";
import {
  parseOptions,
  readSseEvidence,
  runSmoke,
} from "../../scripts/worker-smoke.mjs";

/**
 * Waits until `process.kill(pid, 0)` reports `ESRCH`, then asserts it. Fails with the same
 * message an immediate assertion would once the deadline passes, so a process that genuinely
 * survives still fails the test.
 * @param {number} pid
 * @param {number} [timeoutMs]
 */
async function waitForNoSuchProcess(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal(
        /** @type {NodeJS.ErrnoException} */ (error).code,
        "ESRCH",
        `process ${pid} is not ours`,
      );
      return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`process ${pid} was still alive after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("production accepts no QA credentials", () => {
  const parsed = parseOptions([
    "--base-url",
    "https://app.example.invalid",
    "--mode",
    "production",
  ]);
  assert.equal(parsed.mode, "production");
  assert.equal(parsed.qaEmail, undefined);
});

test("local requires every QA identity argument", () => {
  assert.throws(
    () =>
      parseOptions(["--base-url", "http://127.0.0.1:8787", "--mode", "local"]),
    /--qa-email is required/,
  );
});

test("production smoke performs no authenticated or application writes", async () => {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ path: url.pathname, method: init.method ?? "GET" });
    if (url.pathname.endsWith("/ping"))
      return Response.json({ message: "pong" });
    if (url.pathname.endsWith("/health"))
      return Response.json({ db: true, database: { dialect: "d1" } });
    if (url.pathname === "/api/ready")
      return Response.json({ migrations: { applied: 1, expected: 1 } });
    if (url.pathname === "/sign-in" || url.pathname === "/")
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    if (url.pathname.endsWith("/list-jobs"))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (url.pathname === "/mcp")
      return Response.json(
        {},
        { status: 401, headers: { "www-authenticate": "Bearer" } },
      );
    throw new Error(`unexpected request ${url}`);
  };
  const status = await runSmoke(
    {
      baseUrl: "https://app.example.invalid",
      mode: "production",
      runId: "test",
      timeoutMs: 2_000,
    },
    { fetchImpl, log: () => {} },
  );
  assert.equal(status, 0);
  assert.deepEqual(
    requests.filter((request) => request.method === "POST"),
    [{ path: "/mcp", method: "POST" }],
  );
  assert.equal(
    requests.some(
      (request) =>
        request.path.includes("/auth/login") ||
        request.path.includes("agent-chat"),
    ),
    false,
  );
});

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("SSE reader skips metadata and detects a later error", async () => {
  const result = await readSseEvidence(
    sseResponse([
      'data: {"type":"start"}\n\n',
      'data: {"type":"metadata","id":"x"}\n\n',
      'data: {"type":"error","errorCode":"missing_credentials"}\n\n',
    ]),
  );
  assert.equal(result.evidence.type, "error");
  assert.equal(result.events.length, 3);
});

test("SSE reader accepts meaningful content after metadata", async () => {
  const result = await readSseEvidence(
    sseResponse([
      'data: {"type":"start"}\n\n',
      'data: {"type":"text-delta","text":"A job"}\n\n',
    ]),
  );
  assert.equal(result.evidence.type, "text-delta");
});

test("port preflight refuses an occupied loopback port", async (context) => {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      context.skip("sandbox does not permit loopback listeners");
      return;
    }
    throw error;
  }
  const { port } = server.address();
  await assert.rejects(assertPortAvailable(port), /already in use/);
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test(
  "process-group teardown waits for the detached launcher",
  { skip: process.platform === "win32" },
  async (context) => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    await new Promise((resolve) => child.once("spawn", resolve));
    try {
      await terminateProcessGroup(child, 1_000);
    } catch (error) {
      if (error?.code === "EPERM") {
        context.skip("sandbox does not permit process-group signals");
        return;
      }
      throw error;
    }
    assert.notEqual(child.exitCode ?? child.signalCode, null);
  },
);

test(
  "process-group teardown kills a child after its launcher exits",
  { skip: process.platform === "win32" },
  async () => {
    const launcher = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(child.pid);
child.unref();`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const launcherExited = new Promise((resolve, reject) => {
      launcher.once("error", reject);
      launcher.once("exit", resolve);
    });
    const childPid = await new Promise((resolve, reject) => {
      let output = "";
      launcher.stdout.on("data", (chunk) => {
        output += chunk;
        const pid = Number(output.trim());
        if (Number.isInteger(pid) && pid > 0) resolve(pid);
      });
      launcher.once("exit", () => {
        if (!output.trim()) reject(new Error("launcher printed no child pid"));
      });
    });
    await launcherExited;
    await terminateProcessGroup(launcher, 100);
    // `terminateProcessGroup` waits for the process *group* to disappear, and the child this
    // test watches is reparented to init when its launcher exits, so it is reaped a moment
    // later. Poll rather than assert instantly: the property under test is that the child is
    // terminated, not that the kernel has already finished the bookkeeping. Asserting
    // immediately made this test fail under load once the parallel bootstrap guard was added.
    await waitForNoSuchProcess(childPid);
  },
);
