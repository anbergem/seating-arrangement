import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const checker = new URL("../../scripts/check-boundaries.mjs", import.meta.url);
function check(source) {
  const root = mkdtempSync(path.join(tmpdir(), "boundaries-"));
  try {
    mkdirSync(path.join(root, "src/domain"), { recursive: true });
    writeFileSync(path.join(root, "src/domain/example.ts"), source);
    return spawnSync(process.execPath, [checker.pathname, "--root", root], {
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("rejects multiline imports, exports, dynamic imports and type imports", () => {
  for (const source of [
    'import {\n getDbExec,\n} from "@agent-native/core/db";',
    'export {\n getDbExec,\n} from "@agent-native/core/db";',
    'const load = () => import(\n "@agent-native/core/db"\n);',
    'type Db = import("@agent-native/core/db").DbExec;',
    'import "@agent-native/core/db";',
  ]) {
    const result = check(source);
    assert.equal(result.status, 1, source);
    assert.match(result.stderr, /forbidden import/);
  }
});

test("ignores import-like text in comments and strings", () => {
  const result = check(
    '// import {x} from "react";\nconst example = \'import {x} from "react"\';\nexport { example };',
  );
  assert.equal(result.status, 0, result.stderr);
});

test("fails on syntax errors instead of silently skipping a file", () => {
  assert.notEqual(check("import { broken").status, 0);
});
