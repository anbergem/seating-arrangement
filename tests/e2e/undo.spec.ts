import { JOB_IN_PROGRESS_ID } from "../fixtures/scenario";
import { recentActivity } from "./api";
import { expect, test } from "./fixtures";

test("undo from the toast restores the status and is recorded as its own operation", async ({
  memberPage,
}) => {
  await memberPage.goto(`/jobs/${JOB_IN_PROGRESS_ID}`);
  const main = memberPage.locator("main");
  await memberPage.getByTestId("complete-job").click();
  await expect(main.getByTestId("job-status")).toHaveText("Completed");

  // The toast offers Undo because the history policy permits it (D27).
  await memberPage.getByRole("button", { name: "Undo" }).click();
  await expect(memberPage.getByText("Change undone")).toBeVisible();
  await expect(main.getByTestId("job-status")).toHaveText("In progress");

  await memberPage.goto("/activity");
  await expect(
    memberPage.locator("main").getByText("Undid change").first(),
  ).toBeVisible();

  const activity = await recentActivity(memberPage.request);
  const undo = activity.find((item) => item.kind === "undo");
  expect(undo, JSON.stringify(activity)).toMatchObject({
    action: "undo-operation",
    resourceType: "job",
    resourceId: JOB_IN_PROGRESS_ID,
  });
});
