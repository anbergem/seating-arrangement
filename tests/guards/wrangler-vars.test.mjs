import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseJsonc } from "../../scripts/lib/jsonc.mjs";
import { findUninheritedVars } from "../../scripts/lib/wrangler-vars.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("a top-level var missing from an environment is reported", () => {
  const findings = findUninheritedVars({
    vars: { KEPT: "1", DROPPED: "1" },
    env: { staging: { vars: { KEPT: "1" } } },
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /env\.staging\.vars: DROPPED/);
  assert.match(findings[0], /does not inherit/);
});

test("every environment is checked, not just the first", () => {
  const findings = findUninheritedVars({
    vars: { A: "1" },
    env: { staging: { vars: {} }, production: { vars: {} } },
  });
  assert.equal(findings.length, 2);
});

// "Disabled" has to be spelled, not implied: `SEED_ENABLED: "0"` in production
// is the shape this rule forces, and it must not read as a violation.
test("a var set to a disabled value counts as present", () => {
  assert.deepEqual(
    findUninheritedVars({
      vars: { SEED_ENABLED: "1" },
      env: { production: { vars: { SEED_ENABLED: "0" } } },
    }),
    [],
  );
});

test("an environment with no vars at all reports every top-level var", () => {
  const findings = findUninheritedVars({
    vars: { A: "1", B: "2" },
    env: { staging: {} },
  });
  assert.equal(findings.length, 2);
});

test("a config with no environments or no vars is not a finding", () => {
  assert.deepEqual(findUninheritedVars({ vars: { A: "1" } }), []);
  assert.deepEqual(findUninheritedVars({ env: { staging: { vars: {} } } }), []);
  assert.deepEqual(findUninheritedVars(undefined), []);
});

// The rule exists because this actually shipped: staging deployed without
// AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT (DISCREPANCIES.md, 2026-09-14).
test("this repository's own wrangler.jsonc inherits every var", () => {
  const wrangler = parseJsonc(
    readFileSync(path.join(root, "wrangler.jsonc"), "utf8"),
  );
  assert.deepEqual(findUninheritedVars(wrangler), []);
});
