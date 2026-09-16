import { describe, expect, it } from "vitest";

import {
  blocksOrganizationSelfAdmission,
  organizationRequestTail,
} from "../../../server/organization-request-policy";

describe("organization mount-relative request tail", () => {
  it.each([
    ["/_agent-native/org", "", ""],
    ["/_agent-native/org/", "", ""],
    ["/_agent-native/org/join-by-domain", "", "/join-by-domain"],
    ["/_agent-native/org/invitations/", "", "/invitations"],
    // An APP_BASE_PATH deployment: the recorded path keeps the base prefix.
    ["/app/_agent-native/org", "", ""],
    ["/app/_agent-native/org/invitations", "", "/invitations"],
  ])("reads %s as the tail %s", (mounted, eventPathname, expected) => {
    expect(organizationRequestTail(mounted, eventPathname)).toBe(expected);
  });

  it("falls back to the stripped event path when the shim recorded nothing", () => {
    expect(organizationRequestTail(undefined, "/invitations")).toBe(
      "/invitations",
    );
    expect(organizationRequestTail(undefined, "/")).toBe("");
  });
});

describe("organization self-admission request policy", () => {
  it.each(["", "/unmatched-framework-tail", "/join-by-domain"])(
    "blocks the framework organization creation surface at tail %s",
    (tail) => {
      expect(blocksOrganizationSelfAdmission("POST", tail)).toBe(true);
    },
  );

  it("blocks the domain auto-join write that would admit a whole email domain", () => {
    expect(blocksOrganizationSelfAdmission("PUT", "/domain")).toBe(true);
  });

  it.each([
    ["GET", "/me"],
    ["GET", "/domain"],
    ["PUT", "/switch"],
    ["PUT", "/auth-provider"],
    ["PUT", "/workspace-url"],
    ["POST", "/invitations"],
    ["POST", "/invitations/invite_1/accept"],
    ["POST", "/a2a-secret/sync"],
    ["POST", "/a2a-secret/receive"],
  ])("does not overblock %s %s", (method, tail) => {
    expect(blocksOrganizationSelfAdmission(method, tail)).toBe(false);
  });

  it("denies a POST whose tail the shim left un-stripped", () => {
    expect(blocksOrganizationSelfAdmission("POST", "/_agent-native/org")).toBe(
      true,
    );
  });
});
