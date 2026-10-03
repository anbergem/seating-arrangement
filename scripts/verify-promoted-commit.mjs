#!/usr/bin/env node
// Proves the commit checked out for a promotion is the one that passed staging (T20 step 2,
// D21: production never rebuilds a different tree).
//
// Both `process.env` reads below are git SHAs chosen by the workflow, never credentials, so
// each carries the doctor's documented opt-out marker (DISCREPANCIES, 2026-09-06 T11).
import { verifyPromotedCommit } from "./lib/deployment-validation.mjs";

// guard:allow-env-credential — the staging run's git commit, never a credential
const expected = process.env.STAGING_SHA ?? "";
// guard:allow-env-credential — the checked-out git commit, never a credential
const checkout = process.env.CHECKOUT_SHA ?? "";

const result = verifyPromotedCommit(expected, checkout);
console.log(`verified promoted commit ${result.sha}`);
