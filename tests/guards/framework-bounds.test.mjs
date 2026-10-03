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

// Up to 0.176.5 this repository patched @agent-native/core: requests wedged forever
// on a hung audit-table bootstrap, because a `try/catch` catches rejections, not
// silence. The patch bounded the audit write and every statement
// (DISCREPANCIES.md, 2026-09-16 and 2026-09-17). From 0.198 upstream does both
// things itself, so the patch is gone. These tests watch the two upstream facts
// that made it unnecessary; if either disappears in a later version, the old
// patch is the starting point — `git log --all -- 'patches/@agent-native__core@*.patch'`.
const core = (...segments) =>
  readFileSync(
    path.join(root, "node_modules", "@agent-native", "core", ...segments),
    "utf8",
  );

test("no framework patch is carried", () => {
  const workspace = readFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    "utf8",
  );
  assert.doesNotMatch(
    workspace,
    /@agent-native\/core@[^:\s]+:\s*patches\//,
    "pnpm-workspace.yaml patches @agent-native/core again: re-derive why, and update this guard with the reason",
  );
});

test("upstream runs every statement under a time limit", () => {
  const client = core("dist", "db", "client.js");
  // A hang becomes a rejection, which every caller's `catch` already handles.
  assert.match(client, /export function dbOpTimeoutMs\(/);
  const bounded = client.match(/withDbTimeout\("query"/g) ?? [];
  assert.ok(
    bounded.length >= 4,
    `expected the framework's PostgreSQL paths to wrap queries in withDbTimeout, found ${bounded.length}`,
  );
});

test("upstream probes the audit table before changing it", () => {
  const store = core("dist", "audit", "store.js");
  // The wedge was ten ALTERs expected to throw on every boot after the first.
  assert.match(store, /ensureColumnExists\(\s*"agent_audit_log"/);
  assert.match(store, /ADD COLUMN IF NOT EXISTS/);
});
