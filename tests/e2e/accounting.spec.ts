import { JOB_COMPLETED_ID } from "../fixtures/scenario";
import { recentActivity } from "./api";
import { expect, test } from "./fixtures";

test("an admin exports a completed job after confirming, a member is not offered it", async ({
  memberPage,
  adminPage,
}) => {
  // The UI hides the irreversible export from a member; `jobs:export` is
  // admin-only and the server refuses it regardless (T14 step 4, B22).
  await memberPage.goto(`/jobs/${JOB_COMPLETED_ID}`);
  await expect(memberPage.getByTestId("job-status")).toHaveText("Completed");
  await expect(memberPage.getByTestId("send-accounting")).toHaveCount(0);

  await adminPage.goto(`/jobs/${JOB_COMPLETED_ID}`);
  await adminPage.getByTestId("send-accounting").click();
  const dialog = adminPage.getByRole("alertdialog");
  await expect(dialog).toContainText("Send to accounting?");
  // Nothing is sent until the dialog has said the change cannot be undone.
  await expect(dialog).toContainText("irreversible");
  await adminPage.getByTestId("confirm-accounting").click();
  await expect(adminPage.getByText("Sent to accounting")).toBeVisible();
  await expect(
    adminPage
      .locator("main")
      .getByText(`Accounting reference: ACC-${JOB_COMPLETED_ID}`),
  ).toBeVisible();

  // Irreversible: the export operation is recorded and offers no undo, so the
  // activity page renders no Undo button for it (D27).
  const activity = await recentActivity(adminPage.request);
  const exported = activity.find(
    (item) => item.action === "send-job-to-accounting",
  );
  expect(exported, JSON.stringify(activity)).toMatchObject({
    kind: "forward",
    resourceType: "job",
    resourceId: JOB_COMPLETED_ID,
    undoable: false,
    redoable: false,
  });
  await adminPage.goto("/activity");
  await expect(
    adminPage.locator("main").getByText("Sent job to accounting"),
  ).toBeVisible();
  await expect(
    adminPage.getByTestId(`activity-undo-${exported?.id}`),
  ).toHaveCount(0);
});
