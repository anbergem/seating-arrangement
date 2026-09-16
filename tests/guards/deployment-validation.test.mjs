import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  validateCiRun,
  validateDeploymentManifest,
  validateRunId,
  validateStagingRun,
  verifyPromotionArtifact,
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

test("verifies build provenance and the patched Worker hash", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "promotion-artifact-"));
  try {
    mkdirSync(path.join(directory, "_worker.js"));
    const worker = "export default {};";
    const hash = createHash("sha256").update(worker).digest("hex");
    writeFileSync(
      path.join(directory, "BUILD_INFO.json"),
      JSON.stringify({ sha: SHA }),
    );
    writeFileSync(path.join(directory, "_worker.js", "index.js"), worker);
    writeFileSync(
      path.join(directory, "_worker.js", "PATCHED.json"),
      JSON.stringify({ sha256: hash }),
    );
    assert.equal(
      verifyPromotionArtifact(directory, SHA, SHA).workerSha256,
      hash,
    );
    writeFileSync(
      path.join(directory, "_worker.js", "PATCHED.json"),
      JSON.stringify({ sha256: "wrong" }),
    );
    assert.throws(() => verifyPromotionArtifact(directory, SHA, SHA));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  assert.match(production, /verify-promotion-artifact\.mjs/);
  assert.doesNotMatch(production, /pnpm build:worker/);
});
