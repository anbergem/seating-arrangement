import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("app catalogs have key and placeholder parity", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-i18n-catalogs.mjs"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /parity and placeholders verified/);
});

test("only the planned app locale catalogs remain", () => {
  assert.deepEqual(readdirSync(path.join(root, "app/i18n")).sort(), [
    "en-US.ts",
    "index.ts",
    "nb-NO.ts",
  ]);
  assert.match(
    readFileSync(path.join(root, "app/i18n/nb-NO.ts"), "utf8"),
    /^\/\/ REVIEW: .*needs native review/,
  );
});

function fixture(english, norwegian, usage = "") {
  const directory = mkdtempSync(path.join(tmpdir(), "i18n-guard-"));
  mkdirSync(path.join(directory, "app/i18n"), { recursive: true });
  writeFileSync(
    path.join(directory, "app/i18n/en-US.ts"),
    `const messages = ${english}; export default messages;`,
  );
  writeFileSync(
    path.join(directory, "app/i18n/nb-NO.ts"),
    `const messages = ${norwegian}; export default messages;`,
  );
  writeFileSync(path.join(directory, "app/example.tsx"), usage);
  const result = spawnSync(
    process.execPath,
    ["scripts/check-i18n-catalogs.mjs", "--root", directory],
    { cwd: root, encoding: "utf8" },
  );
  rmSync(directory, { recursive: true, force: true });
  return result;
}

test("guard finds real missing usages but ignores comments and strings", () => {
  const result = fixture(
    '{ common: { save: "Save" } }',
    '{ common: { save: "Lagre" } }',
    '// t("missing.comment")\nconst text = \'t("missing.string")\';\nexport const x = () => t("missing.real");',
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing\.real/);
  assert.doesNotMatch(result.stderr, /missing\.comment|missing\.string/);
});

test("guard finds missing translations and placeholder mismatches", () => {
  const missing = fixture(
    '{ greeting: "Hello {{name}}", extra: "Extra" }',
    '{ greeting: "Hei {{name}}" }',
  );
  assert.match(missing.stderr, /nb-NO missing extra/);
  const placeholder = fixture(
    '{ greeting: "Hello {{name}}" }',
    '{ greeting: "Hei {{person}}" }',
  );
  assert.match(placeholder.stderr, /placeholder mismatch for greeting/);
});

test("guard rejects a placeholder the framework never substitutes", () => {
  // Both catalogs agree, so parity alone passes; a single brace still reaches
  // the screen verbatim because the framework only replaces `{{name}}`.
  const result = fixture(
    '{ greeting: "Hello {name}" }',
    '{ greeting: "Hei {name}" }',
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /en-US greeting: \{name\} is never substituted/);
  assert.match(result.stderr, /nb-NO greeting: \{name\} is never substituted/);
});

test("guard expands finite dynamic translation families", () => {
  const result = fixture(
    '{ status: { active: "Active" } }',
    '{ status: { active: "Aktiv" } }',
    "export const x = (status: string) => t(`status.${status}`);",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing dynamic en-US key status\.all/);
});
