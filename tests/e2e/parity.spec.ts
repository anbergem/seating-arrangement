import { JOB_IN_PROGRESS_ID } from "../fixtures/scenario";
import { auditEventsForJob, auditShape, recentActivity } from "./api";
import { expect, test } from "./fixtures";

test("the UI and a direct HTTP call run the same action and differ only in caller", async ({
  memberPage,
}) => {
  const main = memberPage.locator("main");
  await memberPage.goto(`/jobs/${JOB_IN_PROGRESS_ID}`);
  await memberPage.getByTestId("complete-job").click();
  await expect(main.getByTestId("job-status")).toHaveText("Completed");

  // Undo the browser's completion so the same action can run again, this time
  // as an ordinary HTTP client (no frontend header, so `caller: "http"`).
  const activity = await recentActivity(memberPage.request);
  const completion = activity.find(
    (item) => item.action === "complete-job" && item.kind === "forward",
  );
  expect(completion, JSON.stringify(activity)).toBeDefined();
  const undone = await memberPage.request.post(
    "/_agent-native/actions/undo-operation",
    { data: { operationId: completion?.id } },
  );
  expect(undone.status(), await undone.text()).toBe(200);

  const overHttp = await memberPage.request.post(
    "/_agent-native/actions/complete-job",
    { data: { jobId: JOB_IN_PROGRESS_ID } },
  );
  expect(overHttp.status(), await overHttp.text()).toBe(200);

  const events = await auditEventsForJob(
    memberPage.request,
    JOB_IN_PROGRESS_ID,
  );
  const completions = events.filter((event) => event.action === "complete-job");
  expect(completions).toHaveLength(2);
  expect(completions.map((event) => event.caller).sort()).toEqual([
    "frontend",
    "http",
  ]);
  const [first, second] = completions;
  expect(auditShape(first!)).toEqual(auditShape(second!));

  // The browser reflects the change the HTTP client made.
  await memberPage.goto(`/jobs/${JOB_IN_PROGRESS_ID}`);
  await expect(main.getByTestId("job-status")).toHaveText("Completed");
});
