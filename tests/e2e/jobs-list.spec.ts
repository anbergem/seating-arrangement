import {
  JOB_ARCHIVED_TITLE,
  JOB_COMPLETED_TITLE,
  JOB_IN_PROGRESS_TITLE,
  JOB_OTHER_TITLE,
  JOB_SCHEDULED_TITLE,
} from "../fixtures/scenario";
import { expect, test } from "./fixtures";

test("a member sees the organization's three unarchived jobs", async ({
  memberPage,
}) => {
  await memberPage.goto("/jobs");
  const main = memberPage.locator("main");
  await expect(main.locator('a[href^="/jobs/"]')).toHaveCount(3);
  for (const title of [
    JOB_SCHEDULED_TITLE,
    JOB_IN_PROGRESS_TITLE,
    JOB_COMPLETED_TITLE,
  ]) {
    await expect(main.getByText(title, { exact: true })).toBeVisible();
  }
  // Archived work is filtered out, and another organization's job is invisible.
  await expect(main.getByText(JOB_ARCHIVED_TITLE, { exact: true })).toHaveCount(
    0,
  );
  await expect(main.getByText(JOB_OTHER_TITLE, { exact: true })).toHaveCount(0);
});

test("the status filter narrows the list to scheduled jobs", async ({
  memberPage,
}) => {
  await memberPage.goto("/jobs");
  const main = memberPage.locator("main");
  await main.getByLabel("Status").selectOption("scheduled");
  await expect(main.locator('a[href^="/jobs/"]')).toHaveCount(1);
  await expect(
    main.getByText(JOB_SCHEDULED_TITLE, { exact: true }),
  ).toBeVisible();
});
