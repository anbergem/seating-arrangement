import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// `patches/@agent-native__core@<version>.patch` carries two changes: it bounds the
// audit write's hold on the request, which is the measured cause of wedged isolates,
// and it bounds every statement, which covers the same failure in the framework's
// other runtime table bootstraps (DISCREPANCIES.md, 2026-09-16). Like the
// bundle patches in `scripts/lib/worker-patches.mjs`, it is pinned to one version
// and must be re-examined at every upgrade rather than carried silently (D03).
const CORE_VERSION = JSON.parse(
  readFileSync(
    path.join(root, "node_modules", "@agent-native", "core", "package.json"),
    "utf8",
  ),
).version;

test("the patch is pinned to the installed core version", () => {
  const workspace = readFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    "utf8",
  );
  // Quoting is oxfmt's to choose, so match the pair rather than one spelling.
  const entry = new RegExp(
    `^\\s*['"]?@agent-native/core@${CORE_VERSION}['"]?:\\s*patches/@agent-native__core@${CORE_VERSION}\\.patch\\s*$`,
    "m",
  );
  assert.match(
    workspace,
    entry,
    `pnpm-workspace.yaml does not patch @agent-native/core@${CORE_VERSION}. An upgrade needs a re-cut patch: see docs/plan/upstream-issues/runtime-ddl-wedges-d1-isolates.md`,
  );
});

test("the audit write can no longer block the request forever", () => {
  const action = readFileSync(
    path.join(
      root,
      "node_modules",
      "@agent-native",
      "core",
      "dist",
      "action.js",
    ),
    "utf8",
  );
  // An unbounded `await` here is what wedged isolates: `ensureAuditTables()` can
  // stop settling, and a `try/catch` around it catches rejections, not silence.
  // The row is still waited for — with a ceiling, which is the point. Detaching
  // it entirely also works and was tried; it drops the ordering two e2e tests
  // depend on, and they failed, correctly.
  assert.ok(
    action.includes("wait for the audit write, but only briefly"),
    "the installed @agent-native/core still awaits its audit write without a ceiling — run `pnpm install`",
  );
  assert.match(action, /AGENT_NATIVE_AUDIT_WAIT_MS/);
  assert.match(action, /Promise\.race\(\[\s*auditTask,/);
});

test("statements are still bounded", () => {
  const client = readFileSync(
    path.join(
      root,
      "node_modules",
      "@agent-native",
      "core",
      "dist",
      "db",
      "client.js",
    ),
    "utf8",
  );
  assert.ok(client.includes("AGENT_NATIVE_DB_STATEMENT_TIMEOUT_MS"));
  // `getDbExec()` hands back the raw client once `_exec` is set, so the bound has to
  // be installed on that object. Wrapping only the internal funnel guarded nothing,
  // which a deploy proved the expensive way.
  assert.match(client, /return installStatementDeadline\(_exec\)/);
});

// When upstream stops creating its tables through a long sequence of
// expected-to-fail DDL statements, neither half is load-bearing any more and this
// says so rather than leaving a workaround nobody revisits.
test("upstream still bootstraps the audit table with failing ALTERs", () => {
  const store = readFileSync(
    path.join(
      root,
      "node_modules",
      "@agent-native",
      "core",
      "dist",
      "audit",
      "store.js",
    ),
    "utf8",
  );
  assert.match(store, /ALTER TABLE agent_audit_log ADD COLUMN/);
  assert.match(store, /_initPromise/);
});
