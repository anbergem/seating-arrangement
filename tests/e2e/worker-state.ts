import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/**
 * Where `scripts/e2e-server.mjs` records the private Wrangler configuration and
 * local D1 directory it owns, so `resetScenario()` can execute SQL against that
 * exact instance. The path is passed to the server as an explicit
 * `--state-file` argument rather than through the environment, so no test-only
 * variable is read or mutated at runtime (`agent-native doctor`'s
 * `no-env-credentials` and `no-env-mutation` guards).
 */
export const WORKER_STATE_FILE = path.join(
  repoRoot,
  ".wrangler",
  "e2e-worker-state.json",
);
