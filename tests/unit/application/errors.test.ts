import { describe, expect, it } from "vitest";

import {
  AppError,
  fromDomainError,
  HTTP_STATUS_FOR,
  toAppError,
  type AppErrorCode,
} from "../../../src/application/errors";
import { DomainError } from "../../../src/domain";

describe("HTTP_STATUS_FOR", () => {
  it("has exactly one status per AppErrorCode, matching blueprint B5", () => {
    const expected: Record<AppErrorCode, number> = {
      VALIDATION: 400,
      AUTHENTICATION: 401,
      AUTHORIZATION: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      INVARIANT: 422,
      EXTERNAL: 502,
      INTERNAL: 500,
    };
    expect(HTTP_STATUS_FOR).toEqual(expected);
  });
});

describe("fromDomainError", () => {
  it("maps a VALIDATION DomainError to a VALIDATION AppError, keeping message and details", () => {
    const domainError = new DomainError(
      "VALIDATION",
      "Customer name must be between 1 and 200 characters",
      {
        field: "name",
      },
    );
    const appError = fromDomainError(domainError);
    expect(appError).toBeInstanceOf(AppError);
    expect(appError.code).toBe("VALIDATION");
    expect(appError.message).toBe(
      "Customer name must be between 1 and 200 characters",
    );
    expect(appError.details).toEqual({ field: "name" });
  });

  it("maps an INVARIANT DomainError to an INVARIANT AppError", () => {
    const domainError = new DomainError(
      "INVARIANT",
      "Cannot archive a customer that is archived",
    );
    const appError = fromDomainError(domainError);
    expect(appError.code).toBe("INVARIANT");
    expect(appError.message).toBe("Cannot archive a customer that is archived");
  });
});

describe("toAppError", () => {
  it("passes an AppError through unchanged", () => {
    const original = new AppError(
      "CONFLICT",
      "The record was changed by someone else",
    );
    expect(toAppError(original)).toBe(original);
  });

  it("maps a DomainError the same way fromDomainError does", () => {
    const domainError = new DomainError(
      "INVARIANT",
      "Job is already scheduled at that time",
    );
    const appError = toAppError(domainError);
    expect(appError.code).toBe("INVARIANT");
    expect(appError.message).toBe("Job is already scheduled at that time");
  });

  it.each([
    new Error("boom"),
    "a thrown string",
    undefined,
    null,
    { message: "not an Error instance" },
  ])("wraps an unknown value (%#) as INTERNAL 'Unexpected error'", (value) => {
    const appError = toAppError(value);
    expect(appError).toBeInstanceOf(AppError);
    expect(appError.code).toBe("INTERNAL");
    expect(appError.message).toBe("Unexpected error");
  });
});
