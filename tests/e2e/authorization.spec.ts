import { CUSTOMER_B_ID } from "../fixtures/scenario";
import { expect, test } from "./fixtures";

test("archiving a customer is refused for a member and allowed for an admin", async ({
  memberPage,
  adminPage,
}) => {
  const refused = await memberPage.request.post(
    "/_agent-native/actions/archive-customer",
    { data: { customerId: CUSTOMER_B_ID, expectedVersion: 1 } },
  );
  expect(refused.status()).toBe(403);
  const body = (await refused.json()) as { errorCode?: string };
  expect(body.errorCode).toBe("AUTHORIZATION");

  const allowed = await adminPage.request.post(
    "/_agent-native/actions/archive-customer",
    { data: { customerId: CUSTOMER_B_ID, expectedVersion: 1 } },
  );
  expect(allowed.status(), await allowed.text()).toBe(200);
});

test("the archive button is hidden from a member and shown to an admin", async ({
  memberPage,
  adminPage,
}) => {
  // The UI hides what the caller cannot do; the server refuses it regardless
  // (T14 step 4).
  await memberPage.goto("/customers");
  await expect(memberPage.getByText("Example Customer B")).toBeVisible();
  await expect(
    memberPage.getByTestId(`archive-customer-${CUSTOMER_B_ID}`),
  ).toHaveCount(0);

  await adminPage.goto("/customers");
  const archive = adminPage.getByTestId(`archive-customer-${CUSTOMER_B_ID}`);
  await expect(archive).toBeVisible();
  await archive.click();
  await expect(adminPage.getByText("Customer updated")).toBeVisible();
  await expect(
    adminPage.getByTestId(`archive-customer-${CUSTOMER_B_ID}`),
  ).toHaveCount(0);
});
