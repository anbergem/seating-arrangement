import { defineAgentNativeConfig } from "@agent-native/core/config";

// Public, non-secret framework configuration (docs/plan/tasks/T03 step 1, D15, D20).
// Every value here is serialized into the browser bundle: never put a secret in it.
export default defineAgentNativeConfig({
  version: 1,
  // No Builder.io connection and no per-user provider keys (D15): the first-run
  // "Connect" flow has nothing to offer.
  onboarding: { firstRun: "off" },
  // `database.required: false` even though every deployment has a `DATABASE_URL`
  // (T28): the local server falls back to a SQLite file when it is unset, and on
  // the platform the value is mapped from `POSTGRESQL_ADDON_URI` by
  // `server/plugins/00-database-url.ts`, which runs after this config is read
  // (B13, F8).
  runtime: { auth: { enabled: true }, database: { required: false } },
  diagnostics: { failOnBuild: false },
  // Two audiences, two files (D20): `agent/AGENTS.md` is the deployed runtime
  // prompt, root `AGENTS.md` is for coding agents and never ships.
  instructions: { runtime: "agent/AGENTS.md", development: "AGENTS.md" },
  translations: { locales: ["en-US"] },
  changelog: { enabled: false },
  harness: false,
});
