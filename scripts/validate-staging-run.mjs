#!/usr/bin/env node
// The production promotion gate (T20, D21, D27). Given the `staging_run_id` a human typed into
// `deploy-production.yml`, it refuses anything but a completed, successful `deploy-staging.yml`
// run of this repository on `main`, and then refuses a run whose deployment manifest does not
// name the CI run that actually verified the commit. The SHA it prints is the only thing the
// rest of the workflow checks out and deploys.
//
// Every `process.env` read below is GitHub Actions run metadata or a runner-chosen file path,
// never a credential, so each carries the doctor's documented opt-out marker (DISCREPANCIES,
// 2026-09-06 T11).
import { appendFileSync, readFileSync } from "node:fs";

import {
  validateCiRun,
  validateDeploymentManifest,
  validateRunId,
  validateStagingRun,
} from "./lib/deployment-validation.mjs";

// guard:allow-env-credential — the workflow input, validated as digits below, never a credential
const rawRunId = process.env.STAGING_RUN_ID ?? "";
// guard:allow-env-credential — GitHub run metadata, never a credential
const repository = process.env.GITHUB_REPOSITORY ?? "";
// guard:allow-env-credential — runner file path written by the workflow, never a credential
const stagingRunPath = process.env.STAGING_RUN_JSON ?? "";
// guard:allow-env-credential — runner file path of the downloaded manifest, never a credential
const manifestPath = process.env.DEPLOYMENT_MANIFEST ?? "";
// guard:allow-env-credential — runner file path written by the workflow, never a credential
const ciRunPath = process.env.CI_RUN_JSON ?? "";
// guard:allow-env-credential — runner file path for step outputs, never a credential
const outputPath = process.env.GITHUB_OUTPUT ?? "";

const runId = validateRunId(rawRunId);
if (!repository || !stagingRunPath)
  throw new Error("GITHUB_REPOSITORY and STAGING_RUN_JSON are required");
if (!manifestPath || !ciRunPath)
  throw new Error("DEPLOYMENT_MANIFEST and CI_RUN_JSON are required");

const run = JSON.parse(readFileSync(stagingRunPath, "utf8"));
validateStagingRun(run, repository);
const manifest = validateDeploymentManifest(
  JSON.parse(readFileSync(manifestPath, "utf8")),
  repository,
);
const ci = validateCiRun(
  JSON.parse(readFileSync(ciRunPath, "utf8")),
  repository,
  manifest.sha,
);
if (ci.id !== manifest.sourceCiRunId)
  throw new Error("deployment manifest names a different CI run");
const sha = manifest.sha;
if (outputPath) appendFileSync(outputPath, `sha=${sha}\nrun_id=${runId}\n`);
console.log(`validated staging run ${runId} at ${sha}`);
