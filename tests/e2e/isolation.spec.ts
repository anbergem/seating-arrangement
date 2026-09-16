import { JOB_SCHEDULED_ID } from "../fixtures/scenario";
import { expect, test } from "./fixtures";

test("an outsider gets not-found for another organization's job, in the UI and over HTTP", async ({
  outsiderPage,
}) => {
  await outsiderPage.goto(`/jobs/${JOB_SCHEDULED_ID}`);
  await expect(
    outsiderPage.getByText("The requested record was not found."),
  ).toBeVisible();

  // Never AUTHORIZATION and never a leak: the resource does not exist for them.
  const response = await outsiderPage.request.get(
    `/_agent-native/actions/get-job?jobId=${JOB_SCHEDULED_ID}`,
  );
  expect(response.status()).toBe(404);
  const body = (await response.json()) as { errorCode?: string };
  expect(body.errorCode).toBe("NOT_FOUND");
});
