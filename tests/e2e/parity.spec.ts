import { SEAT_LABEL_ADA, TABLE_HEAD_ID } from "../fixtures/scenario";
import { auditEventsForTarget, auditShape, recentActivity } from "./api";
import { expect, test } from "./fixtures";

test("the UI and a direct HTTP call run the same action and differ only in caller", async ({
  memberPage,
}) => {
  const main = memberPage.locator("main");
  const head = main.getByTestId(`seating-table-${TABLE_HEAD_ID}`);
  await memberPage.goto("/events");
  await main.getByRole("link").first().click();
  await expect(head).toBeVisible();

  // The same seat, written from the browser…
  await head.getByRole("button", { name: /^Seat 1, / }).click();
  const field = main.getByRole("textbox", { name: /^Seat 1, Head table$/ });
  await field.fill("Katherine Johnson");
  await field.press("Enter");
  await expect(memberPage.getByText("Seat updated")).toBeVisible();

  // …undone, so the identical call can be made again as an ordinary HTTP
  // client (no frontend header, so `caller: "http"`).
  const activity = await recentActivity(memberPage.request);
  const written = activity.find(
    (item) => item.action === "label-seat" && item.kind === "forward",
  );
  expect(written, JSON.stringify(activity)).toBeDefined();
  const undone = await memberPage.request.post(
    "/_agent-native/actions/undo-operation",
    { data: { operationId: written?.id } },
  );
  expect(undone.status(), await undone.text()).toBe(200);

  const overHttp = await memberPage.request.post(
    "/_agent-native/actions/label-seat",
    {
      data: {
        tableId: TABLE_HEAD_ID,
        seat: 0,
        label: "Katherine Johnson",
      },
    },
  );
  expect(overHttp.status(), await overHttp.text()).toBe(200);

  const events = await auditEventsForTarget(
    memberPage.request,
    "seating_table",
    TABLE_HEAD_ID,
  );
  const writes = events.filter(
    (event) =>
      event.action === "label-seat" &&
      event.summary === "Seated Katherine Johnson at seat 1",
  );
  expect(writes).toHaveLength(2);
  expect(writes.map((event) => event.caller).sort()).toEqual([
    "frontend",
    "http",
  ]);
  const [first, second] = writes;
  expect(auditShape(first!)).toEqual(auditShape(second!));

  // The browser reflects the change the HTTP client made.
  await memberPage.reload();
  await expect(head.getByText("Katherine Johnson")).toBeVisible();
  await expect(head.getByText(SEAT_LABEL_ADA)).toHaveCount(0);
});
