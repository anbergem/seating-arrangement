import { describe, expect, it } from "vitest";

import {
  DomainError,
  layoutOf,
  MAX_SECTION_TABLES,
  planVenueLayout,
  type LayoutRequest,
  type PlannedLayout,
} from "../../../src/domain";

/**
 * The planned arrangement drawn as text, so a failing assertion shows the
 * actual furniture: a letter is that table's body, `o` is a chair that is
 * there, and `.` is free floor — including a chair the plan took off, which is
 * the whole point of the thing being tested.
 */
function picture(plan: PlannedLayout): string {
  const grid = Array.from({ length: plan.room.height }, () =>
    Array.from({ length: plan.room.width }, () => "."),
  );
  plan.tables.forEach((table, index) => {
    const layout = layoutOf(table.shape);
    const mark = String.fromCharCode(97 + index);
    for (const cell of layout.body) {
      grid[table.gridY + cell.y]![table.gridX + cell.x] = mark.toUpperCase();
    }
    layout.seats.forEach((cell, seat) => {
      if (table.removed.includes(seat)) return;
      grid[table.gridY + cell.y]![table.gridX + cell.x] = "o";
    });
  });
  return grid.map((row) => row.join("")).join("\n");
}

function seats(plan: PlannedLayout): number {
  return plan.tables.reduce(
    (total, table) =>
      total + layoutOf(table.shape).seats.length - table.removed.length,
    0,
  );
}

function blocked(plan: PlannedLayout): number {
  return plan.tables.reduce((total, table) => total + table.removed.length, 0);
}

function request(overrides: Partial<LayoutRequest> = {}): LayoutRequest {
  return {
    kind: "L",
    sections: [2, 1],
    tableLength: 3,
    endSeats: true,
    ...overrides,
  };
}

describe("planVenueLayout", () => {
  it("stands a section's tables end to end as one continuous run", () => {
    const plan = planVenueLayout(
      request({ kind: "L", sections: [3, 1], tableLength: 2 }),
    );
    // Six body cells in an unbroken line: three tables of two, with the chairs
    // that would have capped each join gone, because the next table is there.
    expect(picture(plan)).toBe(
      [".oooooo.", "oAABBCCo", ".oooooDo", ".....oDo", "......o."].join("\n"),
    );
  });

  it("draws an L, with the chairs inside the corner taken off", () => {
    const plan = planVenueLayout(request({ sections: [2, 1] }));
    expect(picture(plan)).toBe(
      [
        ".oooooo.",
        "oAAABBBo",
        ".oooooCo",
        ".....oCo",
        ".....oCo",
        "......o.",
      ].join("\n"),
    );
    // Two runs of three that would seat 8 + 8 = 16 as separate tables.
    expect(seats(plan)).toBe(19);
    expect(blocked(plan)).toBe(5);
  });

  it("draws a U with both wings hanging off the middle", () => {
    const plan = planVenueLayout(
      request({ kind: "U", sections: [2, 3, 2], tableLength: 3 }),
    );
    expect(picture(plan)).toBe(
      [
        ".ooooooooo.",
        "oAAABBBCCCo",
        "oDoooooooFo",
        "oDo.....oFo",
        "oDo.....oFo",
        "oEo.....oGo",
        "oEo.....oGo",
        "oEo.....oGo",
        ".o.......o.",
      ].join("\n"),
    );
    expect(plan.tables).toHaveLength(7);
  });

  it("asks for a room big enough to hold the whole arrangement", () => {
    const plan = planVenueLayout(
      request({ kind: "U", sections: [3, 4, 3], tableLength: 4 }),
    );
    // Well past the 16 by 10 an event starts with: this is why the bootstrap
    // grows the room rather than refusing.
    expect(plan.room).toEqual({ width: 18, height: 15 });
    expect(picture(plan).split("\n")).toHaveLength(15);
  });

  it("keeps the layout against the top-left corner of the room it asks for", () => {
    const plan = planVenueLayout(request());
    expect(Math.min(...plan.tables.map((table) => table.gridX))).toBe(0);
    expect(Math.min(...plan.tables.map((table) => table.gridY))).toBe(0);
  });

  it("leaves the far ends capped when endSeats is on, and bare when it is off", () => {
    const capped = planVenueLayout(request({ sections: [1, 1] }));
    const bare = planVenueLayout(
      request({ sections: [1, 1], endSeats: false }),
    );
    expect(seats(capped)).toBeGreaterThan(seats(bare));
    // The chairs at the join come off either way: that is where the other
    // table stands, not a matter of taste.
    expect(blocked(capped)).toBeGreaterThan(0);
    expect(blocked(bare)).toBeGreaterThan(0);
  });

  it("never plans two tables into the same cell", () => {
    for (const kind of ["L", "U"] as const) {
      for (const length of [1, 2, 3, 5, 8]) {
        const sections = kind === "L" ? [3, 2] : [2, 3, 2];
        const plan = planVenueLayout(
          request({ kind, sections, tableLength: length }),
        );
        const taken = new Set<string>();
        for (const table of plan.tables) {
          const geometry = layoutOf(table.shape);
          const cells = [
            ...geometry.body,
            ...geometry.seats.filter(
              (_, seat) => !table.removed.includes(seat),
            ),
          ];
          for (const cell of cells) {
            const key = `${table.gridX + cell.x},${table.gridY + cell.y}`;
            expect(taken.has(key)).toBe(false);
            taken.add(key);
          }
        }
      }
    }
  });

  it("rejects the wrong number of sections, and counts out of range", () => {
    expect(() => planVenueLayout(request({ sections: [2] }))).toThrow(
      "A L layout has 2 sections, not 1",
    );
    expect(() =>
      planVenueLayout(request({ kind: "U", sections: [2, 2] })),
    ).toThrow("A U layout has 3 sections, not 2");
    expect(() => planVenueLayout(request({ sections: [0, 1] }))).toThrow(
      DomainError,
    );
    expect(() =>
      planVenueLayout(request({ sections: [MAX_SECTION_TABLES + 1, 1] })),
    ).toThrow(DomainError);
    expect(() => planVenueLayout(request({ tableLength: 0 }))).toThrow(
      DomainError,
    );
    expect(() => planVenueLayout(request({ tableLength: 9 }))).toThrow(
      DomainError,
    );
  });
});
