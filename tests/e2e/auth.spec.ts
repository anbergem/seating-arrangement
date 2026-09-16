import { ORG_ACME_NAME, OWNER_EMAIL } from "../fixtures/scenario";
import { expect, test } from "./fixtures";

test("the owner's stored session lands on the jobs list with organization chrome", async ({
  ownerPage,
}) => {
  // `/` is a static shell whose redirect to `/jobs` runs in the browser (B19).
  await ownerPage.goto("/");
  await expect(ownerPage).toHaveURL(/\/jobs$/);
  await expect(
    ownerPage.locator("main").getByRole("heading", { name: "Jobs" }),
  ).toBeVisible();

  const header = ownerPage.getByRole("banner").first();
  await expect(header.getByText(OWNER_EMAIL)).toBeVisible();
  await expect(header.getByText(ORG_ACME_NAME)).toBeVisible();
});
