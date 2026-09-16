import {
  CUSTOMER_A_ID,
  CUSTOMER_A_NAME,
  JOB_IN_PROGRESS_ID,
} from "../fixtures/scenario";
import { expect, test } from "./fixtures";

test("a member undoes and redoes a completion from the activity page, then archives the job", async ({
  memberPage,
}) => {
  const main = memberPage.locator("main");
  await memberPage.goto(`/jobs/${JOB_IN_PROGRESS_ID}`);
  await memberPage.getByTestId("complete-job").click();
  await expect(main.getByTestId("job-status")).toHaveText("Completed");

  await memberPage.goto("/activity");
  const undo = memberPage.locator('[data-testid^="activity-undo-"]').first();
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(memberPage.getByText("Change undone")).toBeVisible();

  const redo = memberPage.locator('[data-testid^="activity-redo-"]').first();
  await expect(redo).toBeVisible();
  await redo.click();
  await expect(memberPage.getByText("Change redone")).toBeVisible();

  await memberPage.goto(`/jobs/${JOB_IN_PROGRESS_ID}`);
  await expect(main.getByTestId("job-status")).toHaveText("Completed");
  await memberPage.getByTestId("archive-job").click();
  await expect(main.getByTestId("job-status")).toHaveText("Archived");
});

test("a member creates a job for a customer, starts it and reschedules it", async ({
  memberPage,
}) => {
  const main = memberPage.locator("main");
  await memberPage.goto("/jobs");
  await memberPage.getByTestId("new-job").click();
  // Scoped to the dialog: the sidebar's "Customers" link carries an aria-label
  // that a page-wide `getByLabel("Customer")` also matches.
  const dialog = memberPage.getByRole("dialog");
  await dialog.getByLabel("Customer").selectOption(CUSTOMER_A_ID);
  await dialog.getByLabel("Job title").fill("Playwright lifecycle job");
  await dialog.getByLabel("Scheduled time").fill("2026-10-03T09:30");
  await memberPage.getByTestId("create-job").click();
  await expect(memberPage.getByText("Job created")).toBeVisible();

  await memberPage
    .getByRole("link", { name: /Playwright lifecycle job/ })
    .click();
  // Exact: on the list the customer name shares a paragraph with the date, so
  // only the detail page renders it on its own. The assertion therefore also
  // waits for the navigation to land.
  await expect(main.getByText(CUSTOMER_A_NAME, { exact: true })).toBeVisible();
  await memberPage.getByTestId("start-job").click();
  await expect(main.getByTestId("job-status")).toHaveText("In progress");

  await main.getByTestId("reschedule-at").fill("2026-10-04T10:30");
  await memberPage.getByTestId("reschedule-job").click();
  await expect(memberPage.getByText("Job updated")).toBeVisible();
});
