import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { patchWorkerSource } from "../../scripts/lib/worker-patches.mjs";

const fixture =
  'const $fail=(name)=>{throw new Error(name)};const fs=new Proxy({},{get($a,$b){return $fail("fs."+String($b))}});const os=new Proxy({},{get(e,t){return $fail("os."+String(t))}});';
test("patches dollar identifiers and keeps unknown APIs throwing", () => {
  const source = patchWorkerSource(fixture);
  const value = runInNewContext(source + ";({fs,os})");
  assert.equal(value.fs.existsSync("/missing"), false);
  assert.equal(value.os.homedir(), "/");
  assert.throws(() => value.fs.readFileSync, /fs.readFileSync/);
  assert.throws(() => value.os.unsupported, /os.unsupported/);
});
test("fails closed when patterns disappear or occur twice", () => {
  assert.throws(() => patchWorkerSource(""), /expected 1 match, found 0/);
  assert.throws(
    () => patchWorkerSource(fixture + fixture),
    /expected 1 match, found 2/,
  );
});
