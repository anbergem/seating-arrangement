#!/usr/bin/env node
// Writes the immutable promotion provenance for one staging deployment (T19/T20, D27): the
// commit that was actually deployed and the CI run that verified it. `deploy-staging.yml`
// uploads the result as its own artifact, and `deploy-production.yml` promotes from it rather
// than from the staging workflow-run's `head_sha`, which can describe the workflow's
// default-branch context instead of the triggering commit.
//
// Every `process.env` read below is GitHub Actions run metadata or a runner-chosen file path,
// never a credential, so each carries the doctor's documented opt-out marker (DISCREPANCIES,
// 2026-09-06 T11).
import { writeFileSync } from "node:fs";

import { validateRunId } from "./lib/deployment-validation.mjs";

// guard:allow-env-credential — the git commit being deployed, never a credential
const sha = process.env.DEPLOY_SHA ?? "";
// guard:allow-env-credential — GitHub run id, validated as digits below, never a credential
const rawCiRunId = process.env.SOURCE_CI_RUN_ID ?? "";
// guard:allow-env-credential — GitHub run metadata, never a credential
const repository = process.env.GITHUB_REPOSITORY ?? "";
const defaultManifestPath = "deployment-manifest.json";
// guard:allow-env-credential — runner file path written by the workflow, never a credential
const manifestPath = process.env.DEPLOYMENT_MANIFEST ?? defaultManifestPath;

if (!/^[0-9a-f]{40}$/.test(sha))
  throw new Error("DEPLOY_SHA must be a full git SHA");
const sourceCiRunId = validateRunId(rawCiRunId);
if (!repository) throw new Error("GITHUB_REPOSITORY is required");
writeFileSync(
  manifestPath,
  `${JSON.stringify({ repository, sha, sourceCiRunId }, null, 2)}\n`,
);
