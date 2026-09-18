import { EVENT_GALA_ID, TABLE_HEAD_ID } from "../fixtures/scenario";
import { expect, test } from "./fixtures";

test("undo refuses to overwrite a newer change made by another user", async ({
  memberPage,
  adminPage,
}) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  const main = memberPage.locator("main");
  const head = main.getByTestId(`seating-table-${TABLE_HEAD_ID}`);

  await head.getByRole("button", { name: /^Seat 4, / }).click();
  const field = main.getByRole("textbox", {
    name: /^Seat 4, Head table$/,
  });
  await field.fill("Katherine Johnson");
  await field.press("Enter");
  await expect(memberPage.getByText("Seat updated")).toBeVisible();
  const undo = memberPage.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();

  // A coworker changes the same table before the undo is clicked, so the
  // version the operation left behind is no longer the current one.
  const coworker = await adminPage.request.post(
    "/_agent-native/actions/label-seat",
    {
      data: {
        tableId: TABLE_HEAD_ID,
        seat: 2,
        label: "Mary Jackson",
      },
    },
  );
  expect(coworker.status(), await coworker.text()).toBe(200);

  await undo.click();
  await expect(
    memberPage.getByText("This record changed. Refresh and try again."),
  ).toBeVisible();

  // Neither change was lost: undo refused rather than discarding the coworker's.
  await memberPage.reload();
  await expect(head.getByText("Katherine Johnson")).toBeVisible();
  await expect(head.getByText("Mary Jackson")).toBeVisible();
});

test("a move is refused when another table has taken the space in between", async ({
  memberPage,
  adminPage,
}) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  const main = memberPage.locator("main");

  // A coworker fills the cell the member is about to aim at.
  const planted = await adminPage.request.post(
    "/_agent-native/actions/create-seating-table",
    {
      data: {
        eventId: EVENT_GALA_ID,
        name: "Blocking table",
        size: 2,
        gridX: 8,
        gridY: 4,
      },
    },
  );
  expect(planted.status(), await planted.text()).toBe(200);

  // The member's browser still has the old plan, so its client-side check
  // passes and the server is what refuses.
  const refused = await memberPage.request.post(
    "/_agent-native/actions/move-seating-table",
    { data: { tableId: TABLE_HEAD_ID, gridX: 8, gridY: 4 } },
  );
  expect(refused.status()).toBeGreaterThanOrEqual(400);

  await memberPage.reload();
  await expect(
    main.getByTestId(`seating-table-${TABLE_HEAD_ID}`),
  ).toHaveAttribute("data-grid-x", "0");
});
