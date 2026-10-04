import { describe, expect, it } from "vitest";

import {
  APP_MEMBERSHIP_MODE,
  MAX_OWNED_ORGANIZATIONS,
  otherMembershipMode,
  parseMembershipMode,
} from "../../../src/domain/membership";

describe("membership mode", () => {
  it("parses the two modes and nothing else", () => {
    expect(parseMembershipMode("invite-only")).toBe("invite-only");
    expect(parseMembershipMode("open")).toBe("open");
    expect(parseMembershipMode(undefined)).toBeUndefined();
    expect(parseMembershipMode("")).toBeUndefined();
    expect(parseMembershipMode("Open")).toBeUndefined();
    expect(parseMembershipMode("other")).toBeUndefined();
  });

  it("names the other mode", () => {
    expect(otherMembershipMode("open")).toBe("invite-only");
    expect(otherMembershipMode("invite-only")).toBe("open");
  });

  it("ships a valid mode and a positive ownership bound", () => {
    expect(parseMembershipMode(APP_MEMBERSHIP_MODE)).toBe(APP_MEMBERSHIP_MODE);
    expect(MAX_OWNED_ORGANIZATIONS).toBeGreaterThan(0);
  });
});
