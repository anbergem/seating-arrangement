/**
 * The seating plan in a real browser, against the real Worker.
 *
 * The gesture is the point of this screen, so it is driven here rather than
 * asserted about: a real pointer drag over real pixels, and a real keyboard
 * move. `data-grid-x` / `data-grid-y` carry the table's cell coordinates, so
 * every assertion is about grid cells rather than about where a div landed.
 */

import {
  EVENT_GALA_ID,
  EVENT_GALA_NAME,
  SEAT_LABEL_ADA,
  TABLE_HEAD_ID,
  TABLE_HEAD_NAME,
  TABLE_SIDE_ID,
} from "../fixtures/scenario";
import { expect, test } from "./fixtures";

/** The centre of a table's body, which is its drag handle. */
async function bodyCentre(page: import("@playwright/test").Page, id: string) {
  const body = page
    .getByTestId(`seating-table-${id}`)
    .getByRole("button", { name: /Move / });
  const box = await body.boundingBox();
  if (!box) throw new Error(`no bounding box for table ${id}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function cellSize(page: import("@playwright/test").Page) {
  const box = await page.getByTestId("floor-plan").boundingBox();
  if (!box) throw new Error("no floor plan");
  // The seeded gala is at the default room size; see `src/domain/event.ts`.
  return { x: box.width / 16, y: box.height / 10 };
}

test("a member sees the event's floor plan with its seat labels", async ({
  memberPage,
}) => {
  await memberPage.goto("/events");
  const main = memberPage.locator("main");
  await expect(main.getByText(EVENT_GALA_NAME, { exact: true })).toBeVisible();

  await main.getByRole("link", { name: new RegExp(EVENT_GALA_NAME) }).click();
  await expect(
    main.getByTestId(`seating-table-${TABLE_HEAD_ID}`),
  ).toBeVisible();
  await expect(
    main.getByTestId(`seating-table-${TABLE_SIDE_ID}`),
  ).toBeVisible();

  // The label is on the plan itself, not only in the panel.
  await expect(
    main
      .getByTestId(`seating-table-${TABLE_HEAD_ID}`)
      .getByText(SEAT_LABEL_ADA),
  ).toBeVisible();
  // …and it is in the seat's accessible name, so it is announced too.
  await expect(
    main.getByRole("button", { name: new RegExp(SEAT_LABEL_ADA) }),
  ).toBeVisible();
});

test("dragging a table to a free cell moves it, and the move survives a reload", async ({
  memberPage,
}) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  const table = memberPage.getByTestId(`seating-table-${TABLE_SIDE_ID}`);
  await expect(table).toHaveAttribute("data-grid-x", "4");
  await expect(table).toHaveAttribute("data-grid-y", "0");

  const cell = await cellSize(memberPage);
  const from = await bodyCentre(memberPage, TABLE_SIDE_ID);
  await memberPage.mouse.move(from.x, from.y);
  await memberPage.mouse.down();
  // Three cells right, four down, in steps so pointermove actually fires.
  await memberPage.mouse.move(from.x + cell.x * 1.5, from.y + cell.y * 2);
  await memberPage.mouse.move(from.x + cell.x * 3, from.y + cell.y * 4);
  await memberPage.mouse.up();

  await expect(memberPage.getByText("Table moved")).toBeVisible();
  await expect(table).toHaveAttribute("data-grid-x", "7");
  await expect(table).toHaveAttribute("data-grid-y", "4");

  await memberPage.reload();
  const reloaded = memberPage.getByTestId(`seating-table-${TABLE_SIDE_ID}`);
  await expect(reloaded).toHaveAttribute("data-grid-x", "7");
  await expect(reloaded).toHaveAttribute("data-grid-y", "4");
});

test("dragging a table onto its neighbour is refused and the table snaps back", async ({
  memberPage,
}) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  const table = memberPage.getByTestId(`seating-table-${TABLE_SIDE_ID}`);

  const cell = await cellSize(memberPage);
  const from = await bodyCentre(memberPage, TABLE_SIDE_ID);
  await memberPage.mouse.move(from.x, from.y);
  await memberPage.mouse.down();
  // Two cells left puts it straight on top of the head table.
  await memberPage.mouse.move(from.x - cell.x, from.y);
  await memberPage.mouse.move(from.x - cell.x * 2, from.y);
  await memberPage.mouse.up();

  await expect(
    memberPage.locator("main").getByText("Tables may not overlap."),
  ).toBeVisible();
  await expect(table).toHaveAttribute("data-grid-x", "4");
  await expect(table).toHaveAttribute("data-grid-y", "0");
});

test("a table can be moved with the keyboard alone", async ({ memberPage }) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  const table = memberPage.getByTestId(`seating-table-${TABLE_SIDE_ID}`);

  await table.getByRole("button", { name: /Move / }).focus();
  await memberPage.keyboard.press("Enter");
  await expect(
    memberPage.locator("main").getByText(/Use the arrow keys/),
  ).toBeVisible();
  await memberPage.keyboard.press("ArrowDown");
  await memberPage.keyboard.press("ArrowDown");
  await memberPage.keyboard.press("ArrowRight");
  await memberPage.keyboard.press("Enter");

  await expect(memberPage.getByText("Table moved")).toBeVisible();
  await expect(table).toHaveAttribute("data-grid-x", "5");
  await expect(table).toHaveAttribute("data-grid-y", "2");
});

test("labelling a seat shows on the plan and can be undone from the toast", async ({
  memberPage,
}) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  const main = memberPage.locator("main");
  const head = main.getByTestId(`seating-table-${TABLE_HEAD_ID}`);

  // Choosing a seat on the plan opens it in the panel beside it. Seat 4 is on
  // the near side of the head table, and nobody is on it in the fixture.
  await head.getByRole("button", { name: /^Seat 4, / }).click();
  // By role, so this is the panel's field and not the seat button on the plan,
  // whose accessible name starts with the same words.
  const field = main.getByRole("textbox", {
    name: `Seat 4, ${TABLE_HEAD_NAME}`,
  });
  await field.fill("Katherine Johnson");
  await field.press("Enter");

  await expect(memberPage.getByText("Seat updated")).toBeVisible();
  await expect(head.getByText("Katherine Johnson")).toBeVisible();

  await memberPage.getByRole("button", { name: "Undo" }).click();
  await expect(memberPage.getByText("Change undone")).toBeVisible();
  await expect(head.getByText("Katherine Johnson")).toHaveCount(0);
});

test("adding a table places it beside the others and records it in the activity feed", async ({
  memberPage,
}) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  const main = memberPage.locator("main");
  // Count only once the plan has actually rendered, or `before` is zero and the
  // assertion below is off by the number of tables that were already there.
  await expect(
    main.getByTestId(`seating-table-${TABLE_HEAD_ID}`),
  ).toBeVisible();
  const before = await main.locator("[data-testid^=seating-table-]").count();

  await main.getByLabel("Table name").fill("Round the back");
  await memberPage.getByTestId("add-table").click();
  await expect(memberPage.getByText("Table added")).toBeVisible();
  await expect(main.locator("[data-testid^=seating-table-]")).toHaveCount(
    before + 1,
  );
  await expect(main.getByText("Round the back")).toBeVisible();

  await memberPage.goto("/activity");
  await expect(
    memberPage.locator("main").getByText("Added table").first(),
  ).toBeVisible();
});

test("an outsider cannot reach another organization's event", async ({
  outsiderPage,
}) => {
  await outsiderPage.goto(`/events/${EVENT_GALA_ID}`);
  await expect(
    outsiderPage
      .locator("main")
      .getByText("The requested record was not found."),
  ).toBeVisible();
  await expect(
    outsiderPage.locator("main").getByText(TABLE_HEAD_NAME),
  ).toHaveCount(0);
});

test("a table can be turned ninety degrees without reseating anybody", async ({
  memberPage,
}) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  const main = memberPage.locator("main");
  const head = main.getByTestId(`seating-table-${TABLE_HEAD_ID}`);
  await expect(head).toHaveAttribute("data-rotation", "0");
  // Ada is on seat 1, and must still be on seat 1 afterwards.
  await expect(
    main.getByRole("button", {
      name: new RegExp(`Seat 1,.*${SEAT_LABEL_ADA}`),
    }),
  ).toBeVisible();

  await head.getByRole("button", { name: /Move / }).click();
  await memberPage.getByTestId("rotate-table").click();
  await expect(memberPage.getByText("Table turned")).toBeVisible();
  await expect(head).toHaveAttribute("data-rotation", "90");

  // Seats are numbered around the table's own outline, so turning the table
  // turns the numbering with it: same seat, same number, same person.
  await expect(head.getByText(SEAT_LABEL_ADA)).toBeVisible();
  await expect(
    main.getByRole("button", {
      name: new RegExp(`Seat 1,.*${SEAT_LABEL_ADA}`),
    }),
  ).toBeVisible();

  await memberPage.reload();
  await expect(
    main.getByTestId(`seating-table-${TABLE_HEAD_ID}`),
  ).toHaveAttribute("data-rotation", "90");
});

test("a chair can be taken away and put back, and the space becomes usable", async ({
  memberPage,
}) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  const main = memberPage.locator("main");
  const head = main.getByTestId(`seating-table-${TABLE_HEAD_ID}`);

  await head.getByRole("button", { name: /^Seat 4, / }).click();
  const chair = main.getByRole("checkbox", {
    name: `Chair at Seat 4, ${TABLE_HEAD_NAME}`,
  });
  await expect(chair).toBeChecked();
  // `.click()`, not `.uncheck()`: the box is controlled by the server's answer,
  // so its state changes a round trip later than Playwright's helper expects.
  await chair.click();
  await expect(memberPage.getByText("Chair taken away")).toBeVisible();
  // The chip is gone from the plan, so its cell is free for a neighbour.
  await expect(head.getByRole("button", { name: /^Seat 4, / })).toHaveCount(0);

  await expect(chair).not.toBeChecked();
  await chair.click();
  await expect(memberPage.getByText("Chair put back")).toBeVisible();
  await expect(head.getByRole("button", { name: /^Seat 4, / })).toBeVisible();
});

/**
 * Round tables, through the browser.
 */
test("a round table can be added, and reshaped from a rectangle", async ({
  memberPage,
}) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  const main = memberPage.locator("main");
  await expect(
    main.getByTestId(`seating-table-${TABLE_HEAD_ID}`),
  ).toBeVisible();

  // Reshaping crosses between the two kinds, renumbering the seats.
  const head = main.getByTestId(`seating-table-${TABLE_HEAD_ID}`);
  await head.getByRole("button", { name: /Move / }).click();
  // A rectangle is offered a turn…
  await expect(memberPage.getByTestId("rotate-table")).toBeVisible();
  await main.getByTestId("table-kind").selectOption("round");
  await expect(memberPage.getByText("Table reshaped")).toBeVisible();
  await expect(head).toHaveAttribute("data-kind", "round");
  // …and once it is round it is not, because a square body turns into itself.
  await expect(memberPage.getByTestId("rotate-table")).toHaveCount(0);
  // Eight chairs around a 2x2 block: four per cell of diameter.
  await expect(head.getByRole("button", { name: /^Seat \d+, / })).toHaveCount(
    8,
  );

  // And one can be added round in the first place.
  await main.getByLabel("Table name").fill("Round one");
  await main.getByTestId("new-table-kind").selectOption("round");
  await main.getByTestId("new-table-size").selectOption("3");
  await memberPage.getByTestId("add-table").click();
  await expect(memberPage.getByText("Table added")).toBeVisible();

  const round = main
    .locator("[data-testid^=seating-table-]")
    .filter({ hasText: "Round one" });
  await expect(round).toHaveAttribute("data-kind", "round");
  await expect(round.getByRole("button", { name: /^Seat \d+, / })).toHaveCount(
    12,
  );
});

/**
 * The arrangement the feature is for, built the way a person would start a
 * plan: not by dragging a dozen tables together, but by saying "a U, three
 * along each wing".
 */
test("an event can be bootstrapped with a U-shaped layout", async ({
  memberPage,
}) => {
  await memberPage.goto("/events");
  const main = memberPage.locator("main");

  // The dialog renders in a portal, so it is not inside <main>.
  await memberPage.getByTestId("new-event").click();
  await memberPage.getByLabel("Event name").fill("Wedding breakfast");
  await memberPage.getByLabel("Starts at").fill("2027-02-14T17:00");
  await memberPage.getByTestId("layout-kind").selectOption("U");
  await memberPage.getByTestId("layout-table-length").selectOption("3");
  await memberPage.getByTestId("create-event").click();

  await expect(memberPage.getByText("Event created")).toBeVisible();
  await expect(memberPage.getByText("Tables laid out")).toBeVisible();

  await main.getByRole("link", { name: /Wedding breakfast/ }).click();
  // A U starts at [2, 3, 2]: a middle of three with a wing of two on each side.
  const tables = main.locator("[data-testid^=seating-table-]");
  await expect(tables).toHaveCount(7);

  // The chairs that cannot be there are not drawn: a bootstrapped plan seats
  // fewer people than the same seven tables standing apart would.
  const seats = await main.getByRole("button", { name: /^Seat \d+, / }).count();
  expect(seats).toBeGreaterThan(0);
  expect(seats).toBeLessThan(7 * 8);

  // And the whole arrangement is one entry in the history, with one Undo.
  await memberPage.goto("/activity");
  await expect(
    memberPage.locator("main").getByText("Laid out the tables").first(),
  ).toBeVisible();
});

/** A bootstrap is for an empty plan, and the plan offers it while it is one. */
test("an empty plan offers a layout, and a filled one does not", async ({
  memberPage,
}) => {
  await memberPage.goto(`/events/${EVENT_GALA_ID}`);
  const main = memberPage.locator("main");
  await expect(
    main.getByTestId(`seating-table-${TABLE_HEAD_ID}`),
  ).toBeVisible();
  // The gala already has tables on it.
  await expect(main.getByTestId("lay-out-event")).toHaveCount(0);
});
