import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_CLASSES,
  environmentLabel,
  isGoogleOnlySignIn,
} from "../../../src/infrastructure/env-check";

describe("environmentLabel", () => {
  it("labels every environment that is not production", () => {
    expect(environmentLabel("local")).toBe("Development");
    expect(environmentLabel("ci")).toBe("CI");
    expect(environmentLabel("staging")).toBe("Staging");
  });

  it("gives production no label, so its pages are unchanged", () => {
    expect(environmentLabel("production")).toBeNull();
  });

  it("covers every environment class", () => {
    for (const environment of ENVIRONMENT_CLASSES) {
      expect(() => environmentLabel(environment)).not.toThrow();
    }
  });
});

describe("isGoogleOnlySignIn", () => {
  it("is true in production and nowhere else", () => {
    expect(isGoogleOnlySignIn("production")).toBe(true);
    for (const appEnv of ["local", "ci", "staging"] as const) {
      expect(isGoogleOnlySignIn(appEnv)).toBe(false);
    }
  });
});
