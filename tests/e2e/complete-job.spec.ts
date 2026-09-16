import {
  JOB_IN_PROGRESS_ID,
  JOB_IN_PROGRESS_TITLE,
  MEMBER1_EMAIL,
  ORG_ACME_ID,
} from "../fixtures/scenario";
import { auditEventsForJob } from "./api";
import { expect, test } from "./fixtures";

test("a member completes a job in the UI and the change is audited as a frontend call", async ({
  memberPage,
}) => {
  await memberPage.goto(`/jobs/${JOB_IN_PROGRESS_ID}`);
  const main = memberPage.locator("main");
  await expect(
    main.getByRole("heading", { name: JOB_IN_PROGRESS_TITLE }),
  ).toBeVisible();
  await expect(main.getByTestId("job-status")).toHaveText("In progress");

  await memberPage.getByTestId("complete-job").click();
  await expect(main.getByTestId("job-status")).toHaveText("Completed");
  // The job's own history section lists the operation.
  await expect(main.getByText("Completed job").first()).toBeVisible();

  await memberPage.goto("/activity");
  await expect(
    memberPage.locator("main").getByText("Completed job").first(),
  ).toBeVisible();

  const events = await auditEventsForJob(
    memberPage.request,
    JOB_IN_PROGRESS_ID,
  );
  const completion = events.find((event) => event.action === "complete-job");
  expect(completion, JSON.stringify(events)).toBeDefined();
  expect(completion).toMatchObject({
    caller: "frontend",
    actorKind: "human",
    actorEmail: MEMBER1_EMAIL,
    orgId: ORG_ACME_ID,
    targetType: "job",
    targetId: JOB_IN_PROGRESS_ID,
    status: "success",
  });
});
