/**
 * Startup validation of the deployment environment (blueprint B13, decision D16).
 *
 * Pure on purpose: it takes the environment as an argument and returns findings
 * instead of reading `process.env`, throwing or logging. That keeps the rules
 * unit-testable without a process, and keeps the Nitro plugin that calls it down
 * to a read and a throw.
 *
 * No message ever contains a value. A violation names the variable and the rule
 * it broke; whoever set it can look it up. This file must stay free of framework
 * and Node imports.
 */

/** The four environment classes, spelled by `APP_ENV`. */
export const ENVIRONMENT_CLASSES = [
  "local",
  "ci",
  "staging",
  "production",
] as const;

export type EnvironmentClass = (typeof ENVIRONMENT_CLASSES)[number];

/** Deployment secrets that must be at least this long (F7). */
const MINIMUM_SECRET_LENGTH = 32;

/**
 * Values that mean "this switch is off". A production configuration is allowed
 * to state a dangerous flag explicitly as disabled — that is a decision someone
 * wrote down — but not to enable it.
 */
const DISABLED_VALUES = new Set(["", "0", "false", "off", "no"]);

function value(env: Record<string, string | undefined>, name: string): string {
  return (env[name] ?? "").trim();
}

function isPresent(
  env: Record<string, string | undefined>,
  name: string,
): boolean {
  return value(env, name).length > 0;
}

function isEnabled(
  env: Record<string, string | undefined>,
  name: string,
): boolean {
  return !DISABLED_VALUES.has(value(env, name).toLowerCase());
}

function isEnvironmentClass(candidate: string): candidate is EnvironmentClass {
  return (ENVIRONMENT_CLASSES as readonly string[]).includes(candidate);
}

/**
 * The environment class this configuration describes.
 *
 * An unset `APP_ENV` is `local`: the Node dev server is the only place that
 * legitimately runs without one, because every hosted environment sets it in
 * `wrangler.jsonc` `vars`.
 */
export function resolveEnvironmentClass(
  env: Record<string, string | undefined>,
): EnvironmentClass | null {
  const raw = value(env, "APP_ENV");
  if (raw.length === 0) return "local";
  return isEnvironmentClass(raw) ? raw : null;
}

/**
 * Every way this environment is misconfigured, one sentence each. An empty
 * array means the configuration is usable.
 */
export function validateEnvironment(
  env: Record<string, string | undefined>,
): string[] {
  const appEnv = resolveEnvironmentClass(env);
  if (appEnv === null) {
    // Without a known class there is no rule set to apply, and guessing one
    // would report violations the operator did not ask for.
    return [
      `APP_ENV is set to an unknown environment class; it must be one of ${ENVIRONMENT_CLASSES.join(", ")}`,
    ];
  }

  const violations: string[] = [];

  if (appEnv === "production") {
    if (value(env, "BETTER_AUTH_SECRET").length < MINIMUM_SECRET_LENGTH) {
      violations.push(
        `BETTER_AUTH_SECRET must be set to at least ${MINIMUM_SECRET_LENGTH} characters in production`,
      );
    }
    if (value(env, "OAUTH_STATE_SECRET").length < MINIMUM_SECRET_LENGTH) {
      violations.push(
        `OAUTH_STATE_SECRET must be set to at least ${MINIMUM_SECRET_LENGTH} characters in production`,
      );
    }
    if (!isPresent(env, "APP_URL")) {
      violations.push("APP_URL must be set in production");
    } else if (!value(env, "APP_URL").startsWith("https://")) {
      violations.push("APP_URL must be an https:// origin in production");
    }
    for (const name of [
      "GOOGLE_SIGN_IN_CLIENT_ID",
      "GOOGLE_SIGN_IN_CLIENT_SECRET",
    ]) {
      // D11: Google is the production sign-in route, so its client must exist.
      if (!isPresent(env, name)) {
        violations.push(`${name} must be set in production (Google sign-in)`);
      }
    }
    if (!isPresent(env, "ANTHROPIC_API_KEY")) {
      violations.push(
        "ANTHROPIC_API_KEY must be set in production (the embedded agent has no other provider)",
      );
    }

    // Development conveniences that would be a data leak in production.
    if (isEnabled(env, "AUTH_DISABLED")) {
      violations.push(
        "AUTH_DISABLED must not be enabled in production; it runs every request as one shared user",
      );
    }
    if (isEnabled(env, "SEED_ENABLED")) {
      violations.push(
        "SEED_ENABLED must not be enabled in production; seed data belongs to local, CI and staging",
      );
    }
    for (const name of ["ACCESS_TOKEN", "ACCESS_TOKENS"]) {
      // F7: static MCP bearer tokens, which this application never issues.
      if (isPresent(env, name)) {
        violations.push(`${name} must not be set in production`);
      }
    }
    if (isEnabled(env, "AGENT_PROD_CODE_EXECUTION")) {
      violations.push(
        "AGENT_PROD_CODE_EXECUTION must not be enabled in production; the agent runs actions, not code",
      );
    }
    if (isPresent(env, "DATABASE_URL")) {
      violations.push(
        "DATABASE_URL must not be set in production; the Worker reaches D1 through its binding",
      );
    }
  }

  if (appEnv === "local") {
    // A laptop pointed at a hosted database is the accident this catches.
    if (
      isPresent(env, "DATABASE_URL") &&
      !value(env, "DATABASE_URL").startsWith("file:")
    ) {
      violations.push("DATABASE_URL must be a file: URL when APP_ENV is local");
    }
  }

  return violations;
}
