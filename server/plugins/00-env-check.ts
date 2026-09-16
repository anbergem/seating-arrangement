import { validateEnvironment } from "../../src/infrastructure/env-check";

/**
 * Refuse to start on a misconfigured deployment (blueprint B13, decision D16).
 *
 * `00-` so Nitro's lexical plugin order runs this before auth and agent-chat.
 * On Workers plugins are lazy, so this runs inside the first request instead of
 * at boot; that is acceptable — the first request fails with the same message.
 *
 * The rules live in `src/infrastructure/env-check.ts`. This file only reads the
 * environment and turns findings into one error, so the reads stay in one small,
 * auditable place and the rules stay unit-testable.
 */
export default function checkEnvironmentPlugin() {
  const violations = validateEnvironment({
    APP_ENV: process.env.APP_ENV, // guard:allow-env-credential — deployment validation, values are never logged
    DATABASE_URL: process.env.DATABASE_URL, // guard:allow-env-credential — deployment validation, values are never logged
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET, // guard:allow-env-credential — deployment validation, values are never logged
    OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET, // guard:allow-env-credential — deployment validation, values are never logged
    APP_URL: process.env.APP_URL, // guard:allow-env-credential — deployment validation, values are never logged
    GOOGLE_SIGN_IN_CLIENT_ID: process.env.GOOGLE_SIGN_IN_CLIENT_ID, // guard:allow-env-credential — deployment validation, values are never logged
    GOOGLE_SIGN_IN_CLIENT_SECRET: process.env.GOOGLE_SIGN_IN_CLIENT_SECRET, // guard:allow-env-credential — deployment validation, values are never logged
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, // guard:allow-env-credential — deployment validation, values are never logged
    AUTH_DISABLED: process.env.AUTH_DISABLED, // guard:allow-env-credential — deployment validation, values are never logged
    SEED_ENABLED: process.env.SEED_ENABLED, // guard:allow-env-credential — deployment validation, values are never logged
    ACCESS_TOKEN: process.env.ACCESS_TOKEN, // guard:allow-env-credential — deployment validation, values are never logged
    ACCESS_TOKENS: process.env.ACCESS_TOKENS, // guard:allow-env-credential — deployment validation, values are never logged
    AGENT_PROD_CODE_EXECUTION: process.env.AGENT_PROD_CODE_EXECUTION, // guard:allow-env-credential — deployment validation, values are never logged
  });

  if (violations.length > 0) {
    throw new Error(
      violations.map((violation) => `env-check: ${violation}`).join("\n"),
    );
  }
}
