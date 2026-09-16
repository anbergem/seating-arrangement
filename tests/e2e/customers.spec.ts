import { CUSTOMER_A_NAME } from "../fixtures/scenario";
import { expect, test } from "./fixtures";

const NEW_CUSTOMER_NAME = "Playwright Customer";

test("a member creates a customer from the dialog and opens its detail page", async ({
  memberPage,
}) => {
  const main = memberPage.locator("main");
  await memberPage.goto("/customers");
  await expect(main.getByText(CUSTOMER_A_NAME, { exact: true })).toBeVisible();

  await memberPage.getByTestId("new-customer").click();
  const dialog = memberPage.getByRole("dialog");
  await dialog.getByLabel("Customer name").fill(NEW_CUSTOMER_NAME);
  await dialog.getByLabel("Email").fill("playwright@example.invalid");
  await dialog.getByLabel("Phone").fill("+47 22 00 00 00");
  await memberPage.getByTestId("create-customer").click();
  await expect(memberPage.getByText("Customer created")).toBeVisible();

  await main.getByRole("link", { name: new RegExp(NEW_CUSTOMER_NAME) }).click();
  await expect(
    main.getByRole("heading", { name: NEW_CUSTOMER_NAME }),
  ).toBeVisible();
  await expect(main.getByTestId("customer-status")).toHaveText("Active");
  // A brand new customer has no work yet, which is also the detail route's
  // empty state.
  await expect(main.getByText("No jobs found.")).toBeVisible();
});
