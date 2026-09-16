#!/usr/bin/env node
// Proves that the commit `deploy-staging.yml` is about to deploy has a successful CI run of its
// own, in this repository, on `main` (T19, D21, D27). It reads the GitHub API response the
// workflow already fetched instead of calling the API itself, so the decision is unit-testable
// (`tests/guards/deployment-validation.test.mjs`).
//
// Every `process.env` read below is GitHub Actions run metadata or a runner-chosen file path,
// never a credential, so each carries the doctor's documented opt-out marker (DISCREPANCIES,
// 2026-09-06 T11).
import { appendFileSync, readFileSync } from "node:fs";

import { validateCiRun } from "./lib/deployment-validation.mjs";

// guard:allow-env-credential — runner file path written by the workflow, never a credential
const runJsonPath = process.env.CI_RUN_JSON ?? "";
// guard:allow-env-credential — GitHub run metadata, never a credential
const repository = process.env.GITHUB_REPOSITORY ?? "";
// guard:allow-env-credential — the git commit being deployed, never a credential
const deploySha = process.env.DEPLOY_SHA ?? "";
// guard:allow-env-credential — runner file path for step outputs, never a credential
const outputPath = process.env.GITHUB_OUTPUT ?? "";

const metadata = JSON.parse(readFileSync(runJsonPath, "utf8"));
const result = validateCiRun(metadata, repository, deploySha);
if (outputPath)
  appendFileSync(outputPath, `run_id=${result.id}\nsha=${result.sha}\n`);
console.log(`validated CI run ${result.id} at ${result.sha}`);
