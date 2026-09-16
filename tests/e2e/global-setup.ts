import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { request, type FullConfig } from "@playwright/test";

import {
  ADMIN_EMAIL,
  DEFAULT_SEED_PASSWORD,
  MEMBER1_EMAIL,
  MEMBER2_EMAIL,
  ORG_ACME_ID,
  OUTSIDER_EMAIL,
  OWNER_EMAIL,
} from "../fixtures/scenario";
import { WORKER_STATE_FILE } from "./worker-state";

const authDirectory = path.resolve("tests/e2e/.auth");
const users = [
  ["owner", OWNER_EMAIL],
  ["admin", ADMIN_EMAIL],
  ["member", MEMBER1_EMAIL],
  ["member2", MEMBER2_EMAIL],
  ["outsider", OUTSIDER_EMAIL],
] as const;

/** Playwright's own readiness probe is `ping`, which the Worker answers before
 * `scripts/e2e-server.mjs` has applied the scenario SQL. Registering users
 * against an unseeded database would produce accounts with no membership, so
 * wait for the server's state file — it is written after the seed — and for the
 * action surface to reject an unauthenticated call. */
async function waitForSeededServer(baseURL: string): Promise<void> {
  let lastStatus = "unreachable";
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (existsSync(WORKER_STATE_FILE)) {
      try {
        const response = await fetch(
          `${baseURL}/_agent-native/actions/list-jobs`,
        );
        if (response.status === 401) return;
        lastStatus = `HTTP ${response.status}`;
      } catch (error) {
        lastStatus = error instanceof Error ? error.message : String(error);
      }
    } else {
      lastStatus = "scenario not seeded yet";
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`e2e setup: Worker did not become ready (${lastStatus})`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (typeof baseURL !== "string")
    throw new Error("e2e setup: baseURL missing");
  await waitForSeededServer(baseURL);
  mkdirSync(authDirectory, { recursive: true });

  for (const [name, email] of users) {
    const context = await request.newContext({
      baseURL,
      extraHTTPHeaders: { origin: baseURL },
    });
    try {
      const registered = await context.post("/_agent-native/auth/register", {
        data: { email, password: DEFAULT_SEED_PASSWORD },
      });
      if (registered.status() !== 200 && registered.status() !== 409) {
        throw new Error(`register ${email}: HTTP ${registered.status()}`);
      }
      const login = await context.post("/_agent-native/auth/login", {
        data: { email, password: DEFAULT_SEED_PASSWORD },
      });
      if (!login.ok())
        throw new Error(`login ${email}: HTTP ${login.status()}`);
      if (name === "owner") {
        const me = await context.get("/_agent-native/org/me");
        const body = await me.json();
        if (!me.ok() || body?.orgId !== ORG_ACME_ID) {
          throw new Error(`owner organization: ${JSON.stringify(body)}`);
        }
      }
      await context.storageState({
        path: path.join(authDirectory, `${name}.json`),
      });
    } finally {
      await context.dispose();
    }
  }

  // Run the Worker contract against the exact process Playwright will use;
  // reset fixtures restore the deterministic scenario before every browser
  // test, so its disposable smoke rows cannot leak into assertions.
  execFileSync(
    process.execPath,
    [
      "scripts/worker-smoke.mjs",
      "--base-url",
      baseURL,
      "--mode",
      "local",
      "--qa-email",
      OWNER_EMAIL,
      "--qa-password",
      DEFAULT_SEED_PASSWORD,
      "--expect-org-id",
      ORG_ACME_ID,
      "--run-id",
      "playwright-setup",
    ],
    { stdio: "inherit" },
  );
}
