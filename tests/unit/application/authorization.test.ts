import { describe, expect, it } from "vitest";

import type { Actor } from "../../../src/application/actor";
import {
  hasCapability,
  requireCapability,
  ROLE_CAPABILITIES,
  type Capability,
  type Role,
} from "../../../src/application/authorization";
import { AppError } from "../../../src/application/errors";

const ROLES: readonly Role[] = ["owner", "admin", "member"];

/**
 * The expected role → capability matrix from blueprint B6, written out
 * independently of `ROLE_CAPABILITIES` so this test actually checks the
 * policy's shape rather than the export against itself.
 */
const CAPABILITY_ROLES: Record<Capability, readonly Role[]> = {
  "events:read": ["owner", "admin", "member"],
  "events:create": ["owner", "admin", "member"],
  "events:archive": ["owner", "admin"],
  "seating:read": ["owner", "admin", "member"],
  "seating:write": ["owner", "admin", "member"],
  "history:read": ["owner", "admin", "member"],
  "history:undo": ["owner", "admin", "member"],
};

const ALL_CAPABILITIES = Object.keys(CAPABILITY_ROLES) as Capability[];

function actorWith(role: Role): Actor {
  return {
    userEmail: "owner@example.invalid",
    orgId: "org_acme",
    role,
    caller: "test",
  };
}

describe("hasCapability", () => {
  for (const role of ROLES) {
    for (const cap of ALL_CAPABILITIES) {
      const expected = CAPABILITY_ROLES[cap].includes(role);
      it(`${role} ${expected ? "may" : "may not"} ${cap}`, () => {
        expect(hasCapability(role, cap)).toBe(expected);
      });
    }
  }
});

describe("ROLE_CAPABILITIES", () => {
  it("matches the B6 matrix exactly for every role", () => {
    for (const role of ROLES) {
      const expected = ALL_CAPABILITIES.filter((cap) =>
        CAPABILITY_ROLES[cap].includes(role),
      ).sort();
      expect([...ROLE_CAPABILITIES[role]].sort()).toEqual(expected);
    }
  });
});

describe("requireCapability", () => {
  it("does not throw when the role has the capability", () => {
    expect(() =>
      requireCapability(actorWith("member"), "seating:write"),
    ).not.toThrow();
  });

  it("throws AppError AUTHORIZATION with the exact message when it does not", () => {
    const actor = actorWith("member");
    expect(() => requireCapability(actor, "events:archive")).toThrow(AppError);

    let caught: unknown;
    try {
      requireCapability(actor, "events:archive");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("AUTHORIZATION");
    expect((caught as AppError).message).toBe(
      "Role member may not events:archive",
    );
  });

  it("a member cannot archive-event (the admin-only demonstration)", () => {
    expect(() =>
      requireCapability(actorWith("member"), "events:archive"),
    ).toThrow("Role member may not events:archive");
  });

  it("admin and owner can archive an event", () => {
    for (const role of ["admin", "owner"] as const) {
      expect(() =>
        requireCapability(actorWith(role), "events:archive"),
      ).not.toThrow();
      expect(() =>
        requireCapability(actorWith(role), "events:archive"),
      ).not.toThrow();
    }
  });
});
