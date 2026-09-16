import { describe, expect, it } from "vitest";

import { resolveActor, type RawContext } from "../../../src/application/actor";
import { AppError } from "../../../src/application/errors";
import type { MembershipReader } from "../../../src/application/ports";

function membershipReaderReturning(
  role: "owner" | "admin" | "member" | null,
): MembershipReader {
  return {
    getRole: async () => role,
    isMember: async () => role !== null,
  };
}

async function catchError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error("expected resolveActor to throw");
}

describe("resolveActor", () => {
  it("throws AUTHENTICATION 'Sign in required' when userEmail is missing", async () => {
    const raw: RawContext = { orgId: "org_acme" };
    const err = await catchError(
      resolveActor(raw, membershipReaderReturning("owner")),
    );
    expect(err.code).toBe("AUTHENTICATION");
    expect(err.message).toBe("Sign in required");
  });

  it("throws AUTHORIZATION 'No active organization' when orgId is missing", async () => {
    const raw: RawContext = { userEmail: "owner@example.invalid" };
    const err = await catchError(
      resolveActor(raw, membershipReaderReturning("owner")),
    );
    expect(err.code).toBe("AUTHORIZATION");
    expect(err.message).toBe("No active organization");
  });

  it("throws AUTHORIZATION 'No active organization' when orgId is null", async () => {
    const raw: RawContext = {
      userEmail: "owner@example.invalid",
      orgId: null,
    };
    const err = await catchError(
      resolveActor(raw, membershipReaderReturning("owner")),
    );
    expect(err.code).toBe("AUTHORIZATION");
    expect(err.message).toBe("No active organization");
  });

  it("throws AUTHORIZATION 'Not a member of the active organization' when membership.getRole returns null", async () => {
    const raw: RawContext = {
      userEmail: "outsider@example.invalid",
      orgId: "org_acme",
    };
    const err = await catchError(
      resolveActor(raw, membershipReaderReturning(null)),
    );
    expect(err.code).toBe("AUTHORIZATION");
    expect(err.message).toBe("Not a member of the active organization");
  });

  it("resolves an Actor with the looked-up role and the given caller", async () => {
    const raw: RawContext = {
      userEmail: "admin@example.invalid",
      orgId: "org_acme",
      caller: "agent",
    };
    const actor = await resolveActor(raw, membershipReaderReturning("admin"));
    expect(actor).toEqual({
      userEmail: "admin@example.invalid",
      orgId: "org_acme",
      role: "admin",
      caller: "agent",
    });
  });

  it("defaults caller to 'unknown' when the raw context does not supply one", async () => {
    const raw: RawContext = {
      userEmail: "owner@example.invalid",
      orgId: "org_acme",
    };
    const actor = await resolveActor(raw, membershipReaderReturning("owner"));
    expect(actor.caller).toBe("unknown");
  });
});
