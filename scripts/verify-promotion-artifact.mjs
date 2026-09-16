#!/usr/bin/env node
// Proves the bundle downloaded from the staging run is the bundle that passed staging, and that
// the migrations and Wrangler configuration checked out next to it belong to the same commit
// (T20 step 2, D21: production never rebuilds). Fails when `dist/_worker.js/PATCHED.json` is
// missing, so an unpatched bundle can never reach production (D03).
//
// Every `process.env` read below is a path or a git SHA chosen by the workflow, never a
// credential, so each carries the doctor's documented opt-out marker (DISCREPANCIES,
// 2026-09-06 T11).
import { verifyPromotionArtifact } from "./lib/deployment-validation.mjs";

// guard:allow-env-credential — directory holding the downloaded bundle, never a credential
const directory = process.env.ARTIFACT_DIR ?? "dist";
// guard:allow-env-credential — the staging run's git commit, never a credential
const expected = process.env.STAGING_SHA ?? "";
// guard:allow-env-credential — the checked-out git commit, never a credential
const checkout = process.env.CHECKOUT_SHA ?? "";

const result = verifyPromotionArtifact(directory, expected, checkout);
console.log(`verified promoted bundle ${result.sha} (${result.workerSha256})`);
