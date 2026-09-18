import {
  EVENT_GALA_ID,
  EVENT_GALA_NAME,
  TABLE_HEAD_ID,
  TABLE_HEAD_NAME,
} from "../fixtures/scenario";
import { expect, test } from "./fixtures";

test("an outsider gets not-found for another organization's event, in the UI and over HTTP", async ({
  outsiderPage,
}) => {
  await outsiderPage.goto(`/events/${EVENT_GALA_ID}`);
  const main = outsiderPage.locator("main");
  await expect(
    main.getByText("The requested record was not found."),
  ).toBeVisible();
  await expect(main.getByText(TABLE_HEAD_NAME)).toHaveCount(0);

  // NOT_FOUND, never AUTHORIZATION: a 403 would confirm the event exists.
  const direct = await outsiderPage.request.get(
    `/_agent-native/actions/get-event?eventId=${EVENT_GALA_ID}`,
  );
  expect(direct.status()).toBe(404);

  // And the same for a write against a table it cannot see.
  const write = await outsiderPage.request.post(
    "/_agent-native/actions/move-seating-table",
    { data: { tableId: TABLE_HEAD_ID, gridX: 8, gridY: 4 } },
  );
  expect(write.status()).toBe(404);
});

test("neither organization's events appear in the other's list", async ({
  memberPage,
  outsiderPage,
}) => {
  await memberPage.goto("/events");
  await expect(
    memberPage.locator("main").getByText(EVENT_GALA_NAME, { exact: true }),
  ).toBeVisible();

  await outsiderPage.goto("/events");
  await expect(
    outsiderPage.locator("main").getByText(EVENT_GALA_NAME, { exact: true }),
  ).toHaveCount(0);
});
