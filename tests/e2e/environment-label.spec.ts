import { expect, test } from "./fixtures";

// The e2e server runs with APP_ENV=local, so both screens must name the
// environment. Production carrying no label is `environmentLabel`'s unit test;
// no browser run here is production.

test("the sign-in page names the environment", async ({ page }) => {
  await page.goto("/events");
  await expect(page).toHaveTitle(/Seating Arrangement \(Development\)/);
  await expect(
    page.getByText("Development environment. Sign in to continue."),
  ).toBeVisible();
});

test("the sign-in page carries none of the framework's own badges or sign-up wording", async ({
  page,
}) => {
  await page.goto("/events");
  // Proves the page has rendered before asserting on what is absent.
  await expect(
    page.getByText("Development environment. Sign in to continue."),
  ).toBeVisible();
  // The elements still exist — the framework draws them — so these check visibility. A
  // framework upgrade that renames a class makes one of them visible again
  // (`server/sign-in-chrome.ts`).
  for (const text of [
    /^alpha$/i,
    /free & open source/i,
    /create your account/i,
  ]) {
    for (const element of await page.getByText(text).all()) {
      await expect(element).toBeHidden();
    }
  }
});

test("every signed-in page carries the environment strip", async ({
  ownerPage,
}) => {
  await ownerPage.goto("/events");
  const banner = ownerPage.getByTestId("environment-banner");
  await expect(banner).toHaveText("Development environment");
  await expect(banner).toHaveAttribute("data-environment", "local");

  // The strip sits above the shell without pushing it past the viewport: the
  // page itself must not scroll.
  const overflow = await ownerPage.evaluate(
    () =>
      document.documentElement.scrollHeight -
      document.documentElement.clientHeight,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await ownerPage.goto("/activity");
  await expect(banner).toBeVisible();
});
