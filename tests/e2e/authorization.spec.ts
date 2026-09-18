import { EVENT_GALA_ID } from "../fixtures/scenario";
import { expect, test } from "./fixtures";

test("archiving an event is refused for a member and allowed for an admin", async ({
  memberPage,
  adminPage,
}) => {
  // The server is the constraint, so the member's attempt goes straight at the
  // action rather than through whatever the UI chooses to show.
  const refused = await memberPage.request.post(
    "/_agent-native/actions/archive-event",
    { data: { eventId: EVENT_GALA_ID } },
  );
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toContain("events:archive");

  const allowed = await adminPage.request.post(
    "/_agent-native/actions/archive-event",
    { data: { eventId: EVENT_GALA_ID } },
  );
  expect(allowed.status(), await allowed.text()).toBe(200);
});

test("the archive control is hidden from a member and shown to an admin", async ({
  memberPage,
  adminPage,
}) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  await expect(memberPage.getByTestId("archive-event")).toHaveCount(0);

  await adminPage.goto(`/events/${EVENT_GALA_ID}`);
  await expect(adminPage.getByTestId("archive-event")).toBeVisible();
});

test("a member may still change the seating on an event they cannot archive", async ({
  memberPage,
}) => {
  const moved = await memberPage.request.post(
    "/_agent-native/actions/create-seating-table",
    {
      data: { eventId: EVENT_GALA_ID, name: "Member's table", size: 2 },
    },
  );
  expect(moved.status(), await moved.text()).toBe(200);
});
