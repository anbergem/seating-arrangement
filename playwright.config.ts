import { defineConfig } from "@playwright/test";

import {
  APP_MEMBERSHIP_MODE,
  otherMembershipMode,
} from "./src/domain/membership";
import { SERVER_STATE_FILE } from "./tests/e2e/server-state";

// guard:allow-env-credential — E2E_PORT selects a local test listener, never a credential.
const e2ePort = Number(process.env.E2E_PORT ?? "8787");
if (!Number.isInteger(e2ePort) || e2ePort < 1 || e2ePort > 65535) {
  throw new Error("E2E_PORT must be an integer from 1 to 65535");
}
const baseURL = `http://127.0.0.1:${e2ePort}`;

// Two runs, one build (D32). The first is the whole suite in the application's own
// membership mode, minus the tests that belong to the other mode. The second —
// `E2E_MEMBERSHIP_MODE=other` — starts the same build in the mode the application does not
// ship and runs only that mode's tests, so the switch itself stays proven either way.
// guard:allow-env-credential — selects a test run, never a credential.
const otherModeRun = process.env.E2E_MEMBERSHIP_MODE === "other";
const membershipMode = otherModeRun
  ? otherMembershipMode(APP_MEMBERSHIP_MODE)
  : APP_MEMBERSHIP_MODE;
const modeTag = (mode: string) => new RegExp(`@${mode}\\b`);

export default defineConfig({
  testDir: "tests/e2e",
  grep: otherModeRun ? modeTag(membershipMode) : undefined,
  grepInvert: otherModeRun
    ? undefined
    : modeTag(otherMembershipMode(membershipMode)),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: otherModeRun
          ? "playwright-report/other-membership-mode"
          : "playwright-report/app",
      },
    ],
  ],
  use: { baseURL, trace: "on-first-retry" },
  globalSetup: "tests/e2e/global-setup.ts",
  webServer: {
    // The server creates and owns a private SQLite file and records it in this
    // file; the path travels as an explicit argument, never through the
    // environment.
    command: `node scripts/e2e-server.mjs --state-file "${SERVER_STATE_FILE}" --membership-mode ${membershipMode}`,
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
