import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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

export function verifyPromotionArtifact(directory, expectedSha, checkoutSha) {
  if (expectedSha !== checkoutSha)
    throw new Error("checked-out commit does not match the staging run SHA");
  const build = JSON.parse(
    readFileSync(`${directory}/BUILD_INFO.json`, "utf8"),
  );
  if (build.sha !== expectedSha)
    throw new Error("BUILD_INFO.json does not match the staging run SHA");
  const marker = JSON.parse(
    readFileSync(`${directory}/_worker.js/PATCHED.json`, "utf8"),
  );
  const worker = readFileSync(`${directory}/_worker.js/index.js`);
  const actual = createHash("sha256").update(worker).digest("hex");
  if (marker.sha256 !== actual)
    throw new Error("PATCHED.json does not match the promoted Worker bundle");
  return { sha: expectedSha, workerSha256: actual };
}
