import { expect, test } from "./fixtures";

// The framework's Settings has a page for every feature the framework has; this app shows
// the ones it uses (app/components/settings-pages.tsx). The navigation is the contract.
const SHOWN = [
  "Profile",
  "Preferences",
  "Security",
  "Model",
  "Instructions",
  "Members",
  "Audit log",
];
const HIDDEN = [
  "Automations",
  "Channels",
  "Labs",
  "Integrations",
  "API keys",
  "Sub-agents",
  "Skills",
  "Infrastructure",
];

test("Settings offers the pages this app uses and none of the others", async ({
  ownerPage,
}) => {
  await ownerPage.goto("/settings");
  for (const name of SHOWN) {
    await expect(
      ownerPage.getByRole("link", { name, exact: true }),
      `${name} should be offered`,
    ).toBeVisible();
  }
  for (const name of HIDDEN) {
    await expect(
      ownerPage.getByRole("link", { name, exact: true }),
      `${name} should not be offered`,
    ).toHaveCount(0);
  }
});
