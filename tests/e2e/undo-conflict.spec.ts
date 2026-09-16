import { JOB_SCHEDULED_ID } from "../fixtures/scenario";
import { expect, test } from "./fixtures";

test("undo refuses to overwrite a newer change made by another user", async ({
  memberPage,
  adminPage,
}) => {
  // The order the domain allows (B9, corrected in T10): reschedule first, then
  // the coworker's completion.
  await memberPage.goto(`/jobs/${JOB_SCHEDULED_ID}`);
  const main = memberPage.locator("main");
  await main.getByTestId("reschedule-at").fill("2026-10-05T09:00");
  await memberPage.getByTestId("reschedule-job").click();
  await expect(memberPage.getByText("Job updated")).toBeVisible();
  const undo = memberPage.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();

  const completion = await adminPage.request.post(
    "/_agent-native/actions/complete-job",
    { data: { jobId: JOB_SCHEDULED_ID } },
  );
  expect(completion.status(), await completion.text()).toBe(200);

  await undo.click();
  await expect(
    memberPage.getByText("This record changed. Refresh and try again."),
  ).toBeVisible();

  await memberPage.goto(`/jobs/${JOB_SCHEDULED_ID}`);
  await expect(main.getByTestId("job-status")).toHaveText("Completed");
});
