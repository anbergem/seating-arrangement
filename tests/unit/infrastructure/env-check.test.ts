import { describe, expect, it } from "vitest";

import {
  resolveEnvironmentClass,
  validateEnvironment,
} from "../../../src/infrastructure/env-check";

type Env = Record<string, string | undefined>;

/** A production configuration that satisfies every B13 rule; each test
 * mutates a copy of this rather than repeating the full set. */
function validProductionEnv(): Env {
  return {
    APP_ENV: "production",
    BETTER_AUTH_SECRET: "a".repeat(32),
    OAUTH_STATE_SECRET: "b".repeat(32),
    APP_URL: "https://app.example.invalid",
    GOOGLE_SIGN_IN_CLIENT_ID: "google-client-id",
    GOOGLE_SIGN_IN_CLIENT_SECRET: "google-client-secret",
    ANTHROPIC_API_KEY: "anthropic-key",
  };
}

describe("resolveEnvironmentClass", () => {
  it("resolves a missing APP_ENV to local", () => {
    expect(resolveEnvironmentClass({})).toBe("local");
  });

  it("resolves each known class", () => {
    for (const value of ["local", "ci", "staging", "production"] as const) {
      expect(resolveEnvironmentClass({ APP_ENV: value })).toBe(value);
    }
  });

  it("returns null for an unknown APP_ENV", () => {
    expect(resolveEnvironmentClass({ APP_ENV: "prod" })).toBeNull();
  });
});

describe("validateEnvironment — missing APP_ENV", () => {
  it("treats it as local and reports no violations with nothing else set", () => {
    expect(validateEnvironment({})).toEqual([]);
  });
});

describe("validateEnvironment — unknown APP_ENV", () => {
  it("is a single violation naming the allowed classes", () => {
    const violations = validateEnvironment({ APP_ENV: "prod" });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toBe(
      "APP_ENV is set to an unknown environment class; it must be one of local, ci, staging, production",
    );
  });
});

describe("validateEnvironment — a correct production environment", () => {
  it("reports no violations", () => {
    expect(validateEnvironment(validProductionEnv())).toEqual([]);
  });
});

describe("validateEnvironment — production, one missing required var at a time", () => {
  const requiredVars = [
    "BETTER_AUTH_SECRET",
    "OAUTH_STATE_SECRET",
    "APP_URL",
    "GOOGLE_SIGN_IN_CLIENT_ID",
    "GOOGLE_SIGN_IN_CLIENT_SECRET",
    "ANTHROPIC_API_KEY",
  ] as const;

  for (const name of requiredVars) {
    it(`reports exactly one violation when ${name} is missing`, () => {
      const env = validProductionEnv();
      delete env[name];
      const violations = validateEnvironment(env);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(name);
    });
  }
});

describe("validateEnvironment — production dangerous flags", () => {
  it("SEED_ENABLED=1 is a violation", () => {
    const violations = validateEnvironment({
      ...validProductionEnv(),
      SEED_ENABLED: "1",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("SEED_ENABLED");
  });

  it("SEED_ENABLED=0 stated explicitly is not a violation", () => {
    const violations = validateEnvironment({
      ...validProductionEnv(),
      SEED_ENABLED: "0",
    });
    expect(violations).toEqual([]);
  });

  it("AUTH_DISABLED=1 is a violation, AUTH_DISABLED=0 is not", () => {
    expect(
      validateEnvironment({ ...validProductionEnv(), AUTH_DISABLED: "1" }),
    ).toHaveLength(1);
    expect(
      validateEnvironment({ ...validProductionEnv(), AUTH_DISABLED: "0" }),
    ).toEqual([]);
  });

  it("AGENT_PROD_CODE_EXECUTION=1 is a violation, =0 is not", () => {
    expect(
      validateEnvironment({
        ...validProductionEnv(),
        AGENT_PROD_CODE_EXECUTION: "1",
      }),
    ).toHaveLength(1);
    expect(
      validateEnvironment({
        ...validProductionEnv(),
        AGENT_PROD_CODE_EXECUTION: "0",
      }),
    ).toEqual([]);
  });

  it("ACCESS_TOKEN present at all is a violation, even set to an empty-ish disabled value", () => {
    expect(
      validateEnvironment({ ...validProductionEnv(), ACCESS_TOKEN: "any" }),
    ).toHaveLength(1);
    expect(
      validateEnvironment({ ...validProductionEnv(), ACCESS_TOKENS: "any" }),
    ).toHaveLength(1);
  });
});

describe("validateEnvironment — production forbids DATABASE_URL when present at all", () => {
  it("a non-file DATABASE_URL is a violation", () => {
    const violations = validateEnvironment({
      ...validProductionEnv(),
      DATABASE_URL: "postgres://user:pass@host/db",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("DATABASE_URL");
  });

  it("APP_ENV=production combined with a local file database is still a violation", () => {
    const violations = validateEnvironment({
      ...validProductionEnv(),
      DATABASE_URL: "file:./data/app.db",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("DATABASE_URL");
  });
});

describe("validateEnvironment — local", () => {
  it("a non-file DATABASE_URL is a violation", () => {
    const violations = validateEnvironment({
      APP_ENV: "local",
      DATABASE_URL: "libsql://x",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toBe(
      "DATABASE_URL must be a file: URL when APP_ENV is local",
    );
  });

  it("a file: DATABASE_URL is not a violation", () => {
    expect(
      validateEnvironment({
        APP_ENV: "local",
        DATABASE_URL: "file:./data/app.db",
      }),
    ).toEqual([]);
  });
});

describe("validateEnvironment — violation strings never contain a value from the input", () => {
  // Not "every literal substring of the input never appears anywhere" — the
  // environment class itself ("production") is expected to appear, since it
  // is a fixed enum the messages are written against, not a leaked value.
  // What must never appear is the actual configured value of a variable the
  // validator is complaining about.
  it("does not leak the DATABASE_URL or ACCESS_TOKEN values it forbids", () => {
    const secretDatabaseUrl = "file:./secret-path-xyz123.db";
    const secretAccessToken = "super-secret-token-abc";
    const violations = validateEnvironment({
      ...validProductionEnv(),
      DATABASE_URL: secretDatabaseUrl,
      ACCESS_TOKEN: secretAccessToken,
    });
    expect(violations).toHaveLength(2);
    for (const violation of violations) {
      expect(violation).not.toContain(secretDatabaseUrl);
      expect(violation).not.toContain(secretAccessToken);
    }
  });

  it("does not leak an actual secret value when several required vars are missing", () => {
    const env: Env = {
      APP_ENV: "production",
      BETTER_AUTH_SECRET: "short-secret-value",
      // OAUTH_STATE_SECRET, APP_URL, GOOGLE_SIGN_IN_CLIENT_ID/SECRET,
      // ANTHROPIC_API_KEY: left unset, each its own violation.
    };
    const violations = validateEnvironment(env);
    expect(violations.length).toBeGreaterThan(1);
    for (const violation of violations) {
      expect(violation).not.toContain("short-secret-value");
    }
  });
});
