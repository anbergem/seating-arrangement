import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  validateCiRun,
  validateDeploymentManifest,
  validateRunId,
  validateStagingRun,
  verifyPromotedCommit,
} from "../../scripts/lib/deployment-validation.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const validRun = {
  path: ".github/workflows/deploy-staging.yml",
  repository: { full_name: "example/repository" },
  head_branch: "main",
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
};

test("accepts only positive numeric run ids", () => {
  assert.equal(validateRunId("123"), "123");
  for (const invalid of ["", "0", "-1", "1x", "1; echo unsafe"])
    assert.throws(() => validateRunId(invalid));
});

test("accepts the trusted successful staging workflow", () => {
  assert.equal(validateStagingRun(validRun, "example/repository"), SHA);
});

test("rejects unrelated, untrusted, incomplete, or failed runs", () => {
  const changes = [
    { path: ".github/workflows/ci.yml" },
    { repository: { full_name: "fork/repository" } },
    { head_branch: "feature" },
    { status: "in_progress" },
    { conclusion: "failure" },
  ];
  for (const change of changes)
    assert.throws(() =>
      validateStagingRun({ ...validRun, ...change }, "example/repository"),
    );
});

test("requires a successful trusted CI run for the exact deployed SHA", () => {
  const ci = { ...validRun, id: 42, path: ".github/workflows/ci.yml" };
  assert.deepEqual(validateCiRun(ci, "example/repository", SHA), {
    id: "42",
    sha: SHA,
  });
  assert.throws(() => validateCiRun(ci, "example/repository", "f".repeat(40)));
  assert.throws(() =>
    validateCiRun({ ...ci, conclusion: "failure" }, "example/repository", SHA),
  );
});

test("ties the immutable deployment manifest to repository, SHA, and CI run", () => {
  assert.deepEqual(
    validateDeploymentManifest(
      { repository: "example/repository", sha: SHA, sourceCiRunId: "42" },
      "example/repository",
    ),
    { sha: SHA, sourceCiRunId: "42" },
  );
  assert.throws(() =>
    validateDeploymentManifest(
      { repository: "fork/repository", sha: SHA, sourceCiRunId: "42" },
      "example/repository",
    ),
  );
});

// What is promoted is a commit, not a file: Clever Cloud builds from the git history it is
// pushed, so there is no uploaded bundle to hash. The chain that proves *which* commit
// staging proved is the manifest and the run ids, asserted above; this proves the checkout
// is that commit and nothing else (T28).
test("verifies the promoted commit is the one staging proved", () => {
  assert.equal(verifyPromotedCommit(SHA, SHA).sha, SHA);
  assert.throws(
    () => verifyPromotedCommit(SHA, "b".repeat(40)),
    /does not match the staging run SHA/,
  );
  assert.throws(
    () => verifyPromotedCommit("not-a-sha", "not-a-sha"),
    /not a full git commit id/,
  );
});

test("deployment workflows keep provenance gates and non-cancelling serialization", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const staging = readFileSync(
    path.join(root, ".github/workflows/deploy-staging.yml"),
    "utf8",
  );
  const production = readFileSync(
    path.join(root, ".github/workflows/deploy-production.yml"),
    "utf8",
  );
  for (const workflow of [staging, production]) {
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /refs\/heads\/main/);
  }
  assert.match(staging, /validate-ci-run\.mjs/);
  assert.match(staging, /deployment-manifest/);
  assert.match(production, /validate-staging-run\.mjs/);
  assert.match(production, /verify-promoted-commit\.mjs/);
  assert.doesNotMatch(production, /pnpm build:worker/);
});
