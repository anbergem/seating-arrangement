import path from "node:path";

import {
  expect,
  test as base,
  type Browser,
  type Page,
} from "@playwright/test";

import { resetScenario } from "./reset";

const authDirectory = path.resolve("tests/e2e/.auth");
// guard:allow-env-credential — E2E_PORT selects a local test listener, never a credential.
const fallbackBaseUrl = `http://127.0.0.1:${process.env.E2E_PORT ?? "8787"}`;

/** Registers a page with the same-origin assertion (D17: nothing this app
 * serves may phone home). */
interface OriginWatcher {
  watch(page: Page): void;
  readonly expectedOrigin: string;
}

type Fixtures = {
  reset: void;
  assertSameOrigin: OriginWatcher;
  ownerPage: Page;
  adminPage: Page;
  memberPage: Page;
  outsiderPage: Page;
};

function authState(name: string): string {
  return path.join(authDirectory, `${name}.json`);
}

async function authenticatedPage(
  browser: Browser,
  state: string,
  baseURL: string | undefined,
  watcher: OriginWatcher,
  use: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    baseURL,
    storageState: authState(state),
    serviceWorkers: "block",
  });
  // Belt as well as braces: the assertion reports an off-origin request, this
  // stops it from actually leaving the machine.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.protocol !== "data:" &&
      url.protocol !== "blob:" &&
      url.origin !== watcher.expectedOrigin
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  watcher.watch(page);
  try {
    await use(page);
  } finally {
    await context.close();
  }
}

export const test = base.extend<Fixtures>({
  assertSameOrigin: [
    async ({ baseURL }, use) => {
      const expectedOrigin = new URL(baseURL ?? fallbackBaseUrl).origin;
      const offOrigin: string[] = [];
      await use({
        expectedOrigin,
        watch(page) {
          page.on("request", (request) => {
            const url = new URL(request.url());
            if (
              url.protocol !== "data:" &&
              url.protocol !== "blob:" &&
              url.origin !== expectedOrigin
            ) {
              offOrigin.push(url.href);
            }
          });
        },
      });
      expect(
        offOrigin,
        `off-origin browser requests: ${offOrigin.join(", ")}`,
      ).toEqual([]);
    },
    { auto: true },
  ],
  reset: [
    // Playwright derives fixture dependencies from this destructuring pattern and
    // rejects any other parameter shape, so an empty pattern is the only way to
    // declare a fixture that depends on no other fixture.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      resetScenario();
      await use();
    },
    { auto: true },
  ],
  // A test that uses Playwright's own page fixture is watched as well.
  page: async ({ page, assertSameOrigin }, use) => {
    assertSameOrigin.watch(page);
    await use(page);
  },
  ownerPage: async ({ browser, reset, baseURL, assertSameOrigin }, use) => {
    void reset;
    await authenticatedPage(browser, "owner", baseURL, assertSameOrigin, use);
  },
  adminPage: async ({ browser, reset, baseURL, assertSameOrigin }, use) => {
    void reset;
    await authenticatedPage(browser, "admin", baseURL, assertSameOrigin, use);
  },
  memberPage: async ({ browser, reset, baseURL, assertSameOrigin }, use) => {
    void reset;
    await authenticatedPage(browser, "member", baseURL, assertSameOrigin, use);
  },
  outsiderPage: async ({ browser, reset, baseURL, assertSameOrigin }, use) => {
    void reset;
    await authenticatedPage(
      browser,
      "outsider",
      baseURL,
      assertSameOrigin,
      use,
    );
  },
});

export { expect };
