import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_CLASSES,
  environmentLabel,
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
