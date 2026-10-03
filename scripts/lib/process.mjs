#!/usr/bin/env node
// Process and port helpers shared by the e2e launcher (T28).
//
// They were part of `scripts/verify-worker.mjs`, which existed to prove a built Worker
// bundle booted on workerd. The bundle is gone; these two are not Worker-specific and the
// e2e launcher still needs them: one refuses to start on an occupied port, the other kills
// a detached process group without leaving orphans.

import { createServer } from "node:net";

export async function assertPortAvailable(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  }).catch((error) => {
    throw new Error(
      `127.0.0.1:${port} is already in use; refusing to test an unrelated service (${error instanceof Error ? error.message : error})`,
    );
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/** The server launcher spawns descendants of its own. The child is spawned detached so its
 * process group is separate from this launcher's group; signalling -pid cannot hit the parent. */
export async function terminateProcessGroup(child, graceMs = 3_000) {
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    return;
  }

  // `child.exitCode` only describes the launcher `pnpm start` runs. A server
  // process can still be alive in the detached process group after that
  // launcher exits, so the process group is the lifecycle authority. The group id is the direct
  // child's pid, assigned when `spawn({ detached: true })` created it.
  const launcherGone = () =>
    child.exitCode !== null || child.signalCode !== null;
  const groupExists = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      // EPERM means a group with that id exists but is not signallable by us.
      // Once our launcher has exited its pid can be recycled, so the group is
      // someone else's and there is nothing of ours left to terminate. While
      // the launcher is alive, EPERM is a real failure and must surface.
      if (error?.code === "EPERM" && launcherGone()) return false;
      throw error;
    }
  };
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const waitForGroupExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (groupExists()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };

  if (!groupExists()) return;
  signalGroup("SIGTERM");
  if (await waitForGroupExit(graceMs)) return;
  signalGroup("SIGKILL");
  if (!(await waitForGroupExit(graceMs))) {
    throw new Error(`owned Worker process group ${child.pid} did not exit`);
  }
}
