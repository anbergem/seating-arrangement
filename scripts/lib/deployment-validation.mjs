export function validateRunId(value) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("staging_run_id must be a positive numeric GitHub run id");
  }
  return value;
}

export function validateStagingRun(run, repository) {
  const workflowPath = run.path?.replace(/^\.github\/workflows\//, "");
  if (run.repository?.full_name !== repository)
    throw new Error("staging run belongs to a different repository");
  if (workflowPath !== "deploy-staging.yml")
    throw new Error("run is not from deploy-staging.yml");
  if (run.head_branch !== "main")
    throw new Error("staging run did not target the trusted main branch");
  if (run.status !== "completed" || run.conclusion !== "success")
    throw new Error("staging run is not completed successfully");
  if (!/^[0-9a-f]{40}$/.test(run.head_sha ?? ""))
    throw new Error("staging run has an invalid head SHA");
  return run.head_sha;
}

export function validateCiRun(value, repository, expectedSha) {
  const runs = Array.isArray(value.workflow_runs)
    ? value.workflow_runs
    : [value];
  const run = runs.find(
    (candidate) =>
      candidate.head_sha === expectedSha &&
      candidate.head_branch === "main" &&
      candidate.repository?.full_name === repository &&
      candidate.status === "completed" &&
      candidate.conclusion === "success" &&
      candidate.path?.replace(/^\.github\/workflows\//, "") === "ci.yml",
  );
  if (!run)
    throw new Error(
      "no successful trusted CI run exists for the deployment SHA",
    );
  return { id: String(run.id), sha: run.head_sha };
}

export function validateDeploymentManifest(manifest, repository) {
  if (manifest.repository !== repository)
    throw new Error("deployment manifest belongs to a different repository");
  validateRunId(String(manifest.sourceCiRunId ?? ""));
  if (!/^[0-9a-f]{40}$/.test(manifest.sha ?? ""))
    throw new Error("deployment manifest has an invalid SHA");
  return { sha: manifest.sha, sourceCiRunId: String(manifest.sourceCiRunId) };
}

/**
 * Proves the commit checked out for a promotion is the commit staging proved (T20 step 2,
 * D21: production never rebuilds a different tree).
 *
 * What is promoted changed with the platform. Cloudflare took a file — a Worker bundle
 * built once and uploaded — so this used to compare its hash against the patch marker
 * beside it. Clever Cloud takes a git push and builds from it, so what has to be proven is
 * narrower and stronger: that the checkout is the commit the staging run deployed and
 * smoked. The artifact chain (deployment manifest → source CI run → staging run)
 * establishes which commit that is; this establishes that it is the one in hand.
 *
 * @param {string} expectedSha the commit the validated staging run deployed
 * @param {string} checkoutSha the commit this job checked out
 */
export function verifyPromotedCommit(expectedSha, checkoutSha) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha))
    throw new Error("the staging run SHA is not a full git commit id");
  if (expectedSha !== checkoutSha)
    throw new Error("checked-out commit does not match the staging run SHA");
  return { sha: expectedSha };
}
