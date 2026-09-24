#!/usr/bin/env node
// The application's own name, read from the one place that owns it (T28).
//
// `server/plugins/config.ts` carries `app: { id }`, which the framework uses for credential
// scoping and which the agent-chat plugin registers under (D18). `scripts/rename-app.mjs`
// rewrites it, so it is the identity every other script should agree with — and unlike
// `package.json` "name", it is the sample application's name rather than the starter's.
//
// Read as text rather than imported: these are Node scripts with no TypeScript loader, and
// the shape is a single declaration the rename script also matches by pattern.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** @returns {string} */
export function appName() {
  const source = readFileSync(
    path.join(repoRoot, "server", "plugins", "config.ts"),
    "utf8",
  );
  const match = /app:\s*\{[^}]*\bid:\s*"([^"]+)"/.exec(source);
  if (!match?.[1]) {
    throw new Error(
      'server/plugins/config.ts has no `app: { id: "…" }`; the application has no name to work from',
    );
  }
  return match[1];
}
