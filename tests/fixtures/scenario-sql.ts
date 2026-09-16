/**
 * Prints the deterministic seed scenario as one line of JSON on stdout, for
 * `scripts/seed.mjs` to read (blueprint B12, task T11 step 2).
 *
 * `scripts/seed.mjs` is plain ESM JavaScript so it runs under `node` with no
 * build step, but the scenario itself is TypeScript and must stay the single
 * definition — a second, hand-written copy of the same rows in the seed script
 * is exactly the drift B12 forbids. This file bridges the two: the seed script
 * spawns `pnpm exec tsx tests/fixtures/scenario-sql.ts` and parses what comes
 * back. A child process rather than a programmatic `tsx` import so the seed
 * script needs no loader hook of its own and stays runnable by hand.
 *
 * The output carries the user list and the default password too, so that
 * `SEED_MEMBERSHIPS` and `DEFAULT_SEED_PASSWORD` also have exactly one
 * definition.
 */

import {
  buildScenarioResetSql,
  buildScenarioSql,
  DEFAULT_SEED_PASSWORD,
  SEED_MEMBERSHIPS,
} from "./scenario";

/** The shape `scripts/seed.mjs` expects. Keep the two in step. */
export interface ScenarioSqlOutput {
  scenarioSql: string[];
  resetSql: string[];
  defaultPassword: string;
  users: { email: string; orgId: string; role: string }[];
}

const output: ScenarioSqlOutput = {
  scenarioSql: buildScenarioSql(),
  resetSql: buildScenarioResetSql(),
  defaultPassword: DEFAULT_SEED_PASSWORD,
  // One membership per user (B12), so the membership list is the user list.
  users: SEED_MEMBERSHIPS.map((membership) => ({
    email: membership.email,
    orgId: membership.orgId,
    role: membership.role,
  })),
};

// One line, nothing else on stdout: the caller reads the last non-empty line.
process.stdout.write(`${JSON.stringify(output)}\n`);
