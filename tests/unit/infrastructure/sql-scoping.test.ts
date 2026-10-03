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

import * as sql from "../../../src/infrastructure/sql/sql";

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

/** A statement whose shape depends on how many rows it guards is exported as a
 * builder rather than a constant, and would otherwise slip past both suites
 * above — which is the whole of the tenancy guard. */
const builders = Object.entries(exported).filter(
  (entry): entry is [string, (count: number) => string] =>
    typeof entry[1] === "function",
);

describe("SQL statements", () => {
  it("exports the statements the repositories use", () => {
    // A rename that silently drops a statement would leave the loops below
    // asserting nothing at all.
    expect(statements.length).toBeGreaterThanOrEqual(20);
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
        ["'active'", "'event'", "'seating_table'", "'forward'"].includes(
          literal,
        ),
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

  it("exports the optional pieces of the list statements", () => {
    expect(fragments.length).toBeGreaterThanOrEqual(5);
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

describe("SQL builders", () => {
  it("exports the statements that are built for a number of rows", () => {
    // A builder that stopped being exported would leave the loops below
    // asserting nothing at all, the same way a renamed constant would.
    expect(builders.length).toBeGreaterThanOrEqual(1);
  });

  it.each(builders)(
    "%s is scoped by organization at every arity",
    (_name, build) => {
      for (const count of [1, 2, 5]) {
        const statement = build(count);
        expect(statement).toContain("org_id = ?");
        // One scoped clause per row it guards: a builder that dropped the
        // scope from all but the first would still contain the string.
        expect(statement.split("org_id = ?").length - 1).toBe(count);
      }
    },
  );

  it.each(builders)("%s parameterises every value", (_name, build) => {
    for (const count of [1, 2, 5]) {
      const statement = build(count);
      expect(statement).not.toContain("${");
      const literals = statement.match(/'[^']*'/g) ?? [];
      expect(literals).toEqual([]);
    }
  });

  it.each(builders)("%s refuses an arity it cannot guard", (_name, build) => {
    // Zero rows would produce a `WHERE` with nothing in it, which is an
    // unguarded write rather than a small one.
    expect(() => build(0)).toThrow();
    expect(() => build(1.5)).toThrow();
  });
});
