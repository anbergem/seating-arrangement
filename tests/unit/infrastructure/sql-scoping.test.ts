/**
 * The tenancy test (blueprint B11, decision D07).
 *
 * The framework's `no-unscoped-queries` guard does not see these tables, so
 * nothing but this test stands between a forgotten `WHERE org_id = ?` and one
 * organization reading another's rows. It runs on every `pnpm check`.
 *
 * It asserts a property of the module rather than a list of statements on
 * purpose: a statement added later is covered the moment it is exported, with
 * no test to remember to update.
 */

import { describe, expect, it } from "vitest";

import * as sql from "../../../src/infrastructure/d1/sql";

// Read as a plain record: the test is about what the module exports at
// runtime, and the literal types TypeScript infers for the constants would
// only get in the way of iterating them.
const exported: Record<string, unknown> = { ...sql };

/** Statements are exported as strings; the optional pieces appended to a
 * `SELECT` are grouped in records, which the second suite checks instead. */
const statements = Object.entries(exported).filter(
  (entry): entry is [string, string] => typeof entry[1] === "string",
);

const fragmentGroups = Object.entries(exported).filter(
  (entry): entry is [string, Record<string, string>] =>
    typeof entry[1] === "object" && entry[1] !== null,
);

describe("SQL statements", () => {
  it("exports the statements the repositories use", () => {
    // A rename that silently drops a statement would leave the loops below
    // asserting nothing at all.
    expect(statements.length).toBeGreaterThanOrEqual(18);
  });

  it.each(statements)("%s is scoped by organization", (_name, statement) => {
    expect(statement).toContain("org_id = ?");
  });

  it.each(statements)("%s parameterises every value", (_name, statement) => {
    // Values reach the database as arguments, never as text: no template
    // interpolation survived into the constant, and no quoted literal appears
    // except the fixed enum values the guards compare against.
    expect(statement).not.toContain("${");
    const literals = statement.match(/'[^']*'/g) ?? [];
    expect(literals).toEqual(
      literals.filter((literal) =>
        ["'active'", "'customer'", "'job'", "'forward'"].includes(literal),
      ),
    );
  });
});

describe("SQL fragments", () => {
  const fragments = fragmentGroups.flatMap(([group, value]) =>
    Object.entries(value).map(
      ([name, fragment]) => [`${group}.${name}`, fragment] as const,
    ),
  );

  it("exports the optional pieces of the two list statements", () => {
    expect(fragments.length).toBeGreaterThanOrEqual(8);
  });

  it.each(fragments)(
    "%s is a fixed clause with at most one placeholder",
    (_name, fragment) => {
      // A fragment has no `org_id` of its own — it is appended to a statement
      // that already carries one — so the rule it must obey instead is that it
      // is a constant chosen by filter name, with the caller's value passed as
      // an argument.
      expect(fragment).toMatch(
        /^ (AND [a-z_]+(\([a-z_]+\))? (=|>=|<|LIKE) \?( ESCAPE '\\')?|ORDER BY [a-z_]+ (ASC|DESC)(, [a-z_]+ (ASC|DESC))?)$/,
      );
      expect(fragment.split("?").length - 1).toBeLessThanOrEqual(1);
    },
  );
});
