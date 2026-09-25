import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/**
 * Where `scripts/e2e-server.mjs` records the private SQLite file it owns, so
 * `resetScenario()` can execute SQL against that exact database. The path is
 * passed to the server as an explicit `--state-file` argument rather than
 * through the environment, so no test-only variable is read or mutated at
 * runtime (`agent-native doctor`'s `no-env-credentials` and `no-env-mutation`
 * guards).
 */
export const SERVER_STATE_FILE = path.join(
  repoRoot,
  ".e2e",
  "server-state.json",
);
