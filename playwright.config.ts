import { defineConfig } from "@playwright/test";

import { SERVER_STATE_FILE } from "./tests/e2e/server-state";

// guard:allow-env-credential — E2E_PORT selects a local test listener, never a credential.
const e2ePort = Number(process.env.E2E_PORT ?? "8787");
if (!Number.isInteger(e2ePort) || e2ePort < 1 || e2ePort > 65535) {
  throw new Error("E2E_PORT must be an integer from 1 to 65535");
}
const baseURL = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL, trace: "on-first-retry" },
  globalSetup: "tests/e2e/global-setup.ts",
  webServer: {
    // The server creates and owns a private SQLite file and records it in this
    // file; the path travels as an explicit argument, never through the
    // environment.
    command: `node scripts/e2e-server.mjs --state-file "${SERVER_STATE_FILE}"`,
    url: `${baseURL}/_agent-native/ping`,
    timeout: 180_000,
    reuseExistingServer: false,
    // Without this Playwright ends the run with SIGKILL, which no handler can
    // catch, and the detached server process group survives holding the
    // selected E2E_PORT. SIGTERM reaches the script's handler, which stops
    // that group.
    gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
