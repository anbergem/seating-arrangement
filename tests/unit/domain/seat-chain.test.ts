import { describe, expect, it } from "vitest";

import {
  chainNeighbours,
  chairKey,
  createSeatingTable,
  findSeat,
  mapChairs,
  planVenueLayout,
  restoreSeatLabels,
  seatChain,
  shiftSeats,
  shiftTargets,
  type ChairRef,
  type FloorPlan,
  type LayoutKind,
  type SeatingTable,
  type TableShapeKind,
} from "../../../src/domain";

const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";
const ROOM = { width: 16, height: 12 };

function table(
  id: string,
  overrides: {
    kind?: TableShapeKind;
    size?: number;
    endSeats?: boolean;
    gridX?: number;
    gridY?: number;
  },
  standing: readonly SeatingTable[] = [],
): SeatingTable {
  return createSeatingTable(
    {
      id,
      orgId: "org_1",
      eventId: "evt_1",
      name: id,
      kind: overrides.kind ?? "rectangle",
      size: overrides.size ?? 2,
      endSeats: overrides.endSeats ?? false,
      gridX: overrides.gridX ?? 0,
      gridY: overrides.gridY ?? 0,
      createdBy: "owner@example.invalid",
      now,
    },
    { room: ROOM, tables: standing },
  );
}

function plan(tables: readonly SeatingTable[]): FloorPlan {
  return { room: ROOM, tables };
}

/** The same table with names written on the given seats. */
function seated(
  subject: SeatingTable,
  labels: Readonly<Record<number, string>>,
): SeatingTable {
  return {
    ...subject,
    seats: subject.seats.map((seat, index) =>
      index in labels ? { label: labels[index] ?? "" } : seat,
    ),
  };
}

/** A bootstrapped arrangement, as real tables. */
function arrangement(
  kind: LayoutKind,
  sections: number[],
  tableLength: number,
): FloorPlan {
  const planned = planVenueLayout({
    kind,
    sections,
    tableLength,
    endSeats: true,
  });
  const tables = planned.tables.map((entry, index) =>
    createSeatingTable(
      {
        id: `t${index}`,
        orgId: "org_1",
        eventId: "evt_1",
        name: `t${index}`,
        kind: entry.shape.kind,
        size: entry.shape.size,
        endSeats: entry.shape.endSeats,
        rotation: entry.shape.rotation,
        gridX: entry.gridX,
        gridY: entry.gridY,
        createdBy: "owner@example.invalid",
        now,
      },
      { room: planned.room, tables: [] },
    ),
  );
  return { room: planned.room, tables };
}

/**
 * Walks every chair in every direction and reports what each walk ended as.
 *
 * The property, not an example: a chain that is ambiguous anywhere is a chain
 * nobody can predict, and the whole design rests on there being no such place
 * in any shape this application can build.
 */
function everyWalk(floor: FloorPlan): Record<string, number> {
  const chairs = mapChairs(floor);
  const tally: Record<string, number> = {};
  for (const chair of chairs.byRef.values()) {
    const ref = { tableId: chair.tableId, seat: chair.seat };
    for (const toward of chainNeighbours(chairs, ref)) {
      const chain = seatChain(chairs, ref, toward);
      // A walk that had to guess stops early, so a short open path on a shape
      // that should close is how ambiguity would show up here.
      const kind = chain.closed ? "closed" : "open";
      tally[kind] = (tally[kind] ?? 0) + 1;
    }
  }
  return tally;
}

describe("the chain of chairs", () => {
  it("closes into a loop around a table with a chair at each end", () => {
    for (const size of [1, 2, 4]) {
      const floor = plan([table("t", { size, endSeats: true })]);
      expect(everyWalk(floor)).toEqual({ closed: (2 * size + 2) * 2 });
    }
  });

  it("closes around a round table", () => {
    for (const size of [1, 2, 4]) {
      const floor = plan([table("t", { kind: "round", size })]);
      expect(everyWalk(floor)).toEqual({ closed: 4 * size * 2 });
    }
  });

  /**
   * The rule nobody had to write. A rectangle with no end chairs is two rows
   * with the table itself between them, so the walk can never get from one to
   * the other and the chain never closes — which is exactly why such a table
   * cannot be rotated.
   */
  it("never closes around a rectangle with no end chairs", () => {
    for (const size of [2, 4]) {
      const floor = plan([table("t", { size, endSeats: false })]);
      expect(everyWalk(floor).closed).toBeUndefined();
    }
  });

  it("closes all the way around an L and a U", () => {
    for (const [kind, sections, length] of [
      ["L", [2, 2], 3],
      ["L", [3, 3], 4],
      ["U", [2, 3, 2], 3],
      ["U", [3, 4, 3], 2],
    ] as const) {
      const floor = arrangement(kind, [...sections], length);
      const walks = everyWalk(floor);
      // Every chair, every direction, all the way round: no corner of either
      // arrangement is ambiguous and none of them dead-ends.
      expect({ kind, sections, walks }).toEqual({
        kind,
        sections,
        walks: { closed: walks.closed },
      });
      expect(walks.closed).toBeGreaterThan(0);
    }
  });

  /** The inside corner of an L is three chairs touching one another. Preferring
   * the orthogonal step is what picks the one that carries on along the same
   * surface; take that away and the walk stops here. */
  it("turns the inside corner of an L", () => {
    const floor = arrangement("L", [2, 2], 3);
    const chairs = mapChairs(floor);
    const crowded = [...chairs.byRef.values()].filter(
      (chair) =>
        chainNeighbours(chairs, { tableId: chair.tableId, seat: chair.seat })
          .length > 2,
    );
    // Orthogonal-first has already resolved the triangle, so no chair is left
    // with more than the two ends of its chain.
    expect(crowded).toEqual([]);
  });

  it("does not chain two tables that merely stand back to back", () => {
    // Their chairs touch across the walkway, but the tables have nothing to do
    // with one another: the bodies are three rows apart.
    const a = table("a", { size: 2, gridX: 0, gridY: 0 });
    const b = table("b", { size: 2, gridX: 0, gridY: 3 }, [a]);
    const floor = plan([a, b]);
    expect(everyWalk(floor).closed).toBeUndefined();

    const chairs = mapChairs(floor);
    const bench = seatChain(
      chairs,
      { tableId: "a", seat: 3 },
      { tableId: "a", seat: 2 },
    );
    expect(bench.path.every((ref) => ref.tableId === "a")).toBe(true);
  });

  it("chains two tables whose bodies are pushed together", () => {
    const left = table("left", { size: 3, endSeats: true, gridX: 0, gridY: 0 });
    const right = table(
      "right",
      { size: 3, endSeats: true, gridX: 3, gridY: 0 },
      [left],
    );
    const chairs = mapChairs(plan([left, right]));
    const bench = seatChain(
      chairs,
      { tableId: "left", seat: 0 },
      { tableId: "left", seat: 1 },
    );
    expect(bench.path.some((ref) => ref.tableId === "right")).toBe(true);
  });

  /** A table pushed into the middle of a run takes chairs away, but it is also
   * standing against it — so its own chairs carry the chain on round it. */
  it("carries the chain round a table pushed into a run", () => {
    const run = table("run", { size: 4, endSeats: true, gridX: 0, gridY: 0 });
    const intruder = table(
      "intruder",
      { size: 2, endSeats: false, gridX: 2, gridY: 1 },
      [run],
    );
    const floor = plan([run, intruder]);
    const chairs = mapChairs(floor);
    const runChairs = [...chairs.byRef.values()].filter(
      (chair) => chair.tableId === "run",
    );
    expect(runChairs).toHaveLength(run.seats.length - 2);
    expect(chairs.touching.size).toBe(1);
    // One loop around the pair of them, rather than two broken benches.
    expect(everyWalk(floor)).toEqual({ closed: chairs.byRef.size * 2 });
  });

  /**
   * A missing chair is a break nobody can be shifted past, which is the whole
   * point of pushing everyone one seat over.
   *
   * The neighbour here stands well clear of the run — the chairs it takes are
   * ones it got to first, not ones its body is sitting in — so nothing joins
   * the two chains back up.
   */
  it("splits where an unrelated neighbour got to a chair first", () => {
    const earlier = table("earlier", {
      size: 2,
      endSeats: false,
      gridX: 2,
      gridY: 2,
    });
    const run = table("run", { size: 4, endSeats: true, gridX: 0, gridY: 0 }, [
      earlier,
    ]);
    const floor = plan([earlier, run]);
    const chairs = mapChairs(floor);
    const runChairs = [...chairs.byRef.values()].filter(
      (chair) => chair.tableId === "run",
    );
    expect(runChairs).toHaveLength(run.seats.length - 2);
    expect(chairs.touching.size).toBe(0);
    expect(everyWalk(floor).closed).toBeUndefined();
  });
});

describe("shiftTargets", () => {
  it("offers nothing from an empty chair", () => {
    const subject = table("t", { size: 4, endSeats: true });
    const chairs = mapChairs(plan([subject]));
    expect(shiftTargets(chairs, { tableId: "t", seat: 0 })).toEqual([]);
  });

  it("offers both ways round a loop, however full it is", () => {
    const subject = table("t", { size: 2, endSeats: true });
    const full = seated(
      subject,
      Object.fromEntries(subject.seats.map((_, i) => [i, `Guest ${i}`])),
    );
    const chairs = mapChairs(plan([full]));
    expect(shiftTargets(chairs, { tableId: "t", seat: 0 })).toHaveLength(2);
  });

  it("offers only the way that has an empty chair ahead of it", () => {
    // A straight bench of four, nobody at the far right.
    const subject = seated(table("t", { size: 4, endSeats: false }), {
      0: "Ada",
      1: "Grace",
      2: "Katherine",
    });
    const chairs = mapChairs(plan([subject]));
    const targets = shiftTargets(chairs, { tableId: "t", seat: 1 });
    // Seats 0..3 run along the far side; 3 is the empty one, so only the walk
    // toward seat 2 has anywhere to put anybody.
    expect(targets).toEqual([{ tableId: "t", seat: 2 }]);
  });

  it("offers nothing along a full bench that does not close", () => {
    const subject = seated(table("t", { size: 2, endSeats: false }), {
      0: "Ada",
      1: "Grace",
    });
    const chairs = mapChairs(plan([subject]));
    expect(shiftTargets(chairs, { tableId: "t", seat: 0 })).toEqual([]);
  });
});

describe("shiftSeats", () => {
  const bench = () =>
    seated(table("t", { size: 4, endSeats: false }), {
      0: "Ada",
      1: "Grace",
      2: "Katherine",
    });

  it("makes room at the chosen chair and stops at the first empty one", () => {
    const subject = bench();
    const shifted = shiftSeats(
      plan([subject]),
      { tableId: "t", seat: 0 },
      { tableId: "t", seat: 1 },
      later,
    );
    const [next] = shifted.tables as [SeatingTable];
    expect(next.seats.slice(0, 4).map((seat) => seat.label)).toEqual([
      "",
      "Ada",
      "Grace",
      "Katherine",
    ]);
    expect(next.version).toBe(subject.version + 1);
    expect(next.updatedAt).toBe(later);
  });

  it("touches no chair past the gap", () => {
    // Ada, Grace, a space, then Katherine: only the first two move.
    const subject = seated(table("t", { size: 4, endSeats: false }), {
      0: "Ada",
      1: "Grace",
      3: "Katherine",
    });
    const shifted = shiftSeats(
      plan([subject]),
      { tableId: "t", seat: 0 },
      { tableId: "t", seat: 1 },
      later,
    );
    const [next] = shifted.tables as [SeatingTable];
    expect(next.seats.slice(0, 4).map((seat) => seat.label)).toEqual([
      "",
      "Ada",
      "Grace",
      "Katherine",
    ]);
    expect(shifted.previous.map((entry) => entry.seat).sort()).toEqual([
      0, 1, 2,
    ]);
  });

  it("turns a full loop by one, bringing the last person round", () => {
    const subject = table("t", { size: 2, endSeats: true });
    const full = seated(
      subject,
      Object.fromEntries(subject.seats.map((_, i) => [i, `Guest ${i}`])),
    );
    const chairs = mapChairs(plan([full]));
    const [toward] = chainNeighbours(chairs, {
      tableId: "t",
      seat: 0,
    }) as [ChairRef];
    const shifted = shiftSeats(
      plan([full]),
      { tableId: "t", seat: 0 },
      toward,
      later,
    );
    const [next] = shifted.tables as [SeatingTable];
    // Nobody is dropped and nobody is duplicated: a rotation is a permutation.
    expect(next.seats.map((seat) => seat.label).sort()).toEqual(
      full.seats.map((seat) => seat.label).sort(),
    );
    // And the chair the shift started from is not freed — there is nowhere for
    // a gap to go on a full loop.
    expect(findSeat(next, 0)?.label).not.toBe("");
    expect(findSeat(next, 0)?.label).not.toBe("Guest 0");
  });

  it("carries a shift across the tables of an L", () => {
    const floor = arrangement("L", [2, 2], 3);
    const chairs = mapChairs(floor);
    // Seat the whole outer bench of the first table, then shift along it.
    const first = floor.tables[0]!;
    const filled = seated(first, { 0: "Ada", 1: "Grace", 2: "Katherine" });
    const seatedFloor = plan([filled, ...floor.tables.slice(1)]);
    const start: ChairRef = { tableId: first.id, seat: 0 };
    const targets = shiftTargets(mapChairs(seatedFloor), start);
    expect(targets.length).toBeGreaterThan(0);
    const shifted = shiftSeats(seatedFloor, start, targets[0]!, later);
    expect(shifted.tables.length).toBeGreaterThanOrEqual(1);
    expect(chairs.byRef.size).toBeGreaterThan(0);
  });

  it("refuses a chair nobody is sitting in", () => {
    const subject = bench();
    expect(() =>
      shiftSeats(
        plan([subject]),
        { tableId: "t", seat: 3 },
        { tableId: "t", seat: 2 },
        later,
      ),
    ).toThrow("There is nobody on that seat");
  });

  it("refuses a direction that is not the next chair along", () => {
    const subject = bench();
    expect(() =>
      shiftSeats(
        plan([subject]),
        { tableId: "t", seat: 0 },
        { tableId: "t", seat: 3 },
        later,
      ),
    ).toThrow("not the next chair along");
  });

  it("refuses when every chair along the way is taken", () => {
    const subject = seated(table("t", { size: 2, endSeats: false }), {
      0: "Ada",
      1: "Grace",
    });
    expect(() =>
      shiftSeats(
        plan([subject]),
        { tableId: "t", seat: 0 },
        { tableId: "t", seat: 1 },
        later,
      ),
    ).toThrow("There is nowhere to shift to");
  });

  it("refuses a chair that is not there", () => {
    const run = table("run", { size: 4, endSeats: true, gridX: 0, gridY: 0 });
    const intruder = table(
      "intruder",
      { size: 2, endSeats: false, gridX: 2, gridY: 1 },
      [run],
    );
    const chairs = mapChairs(plan([run, intruder]));
    const gone = run.seats.findIndex(
      (_, index) =>
        !chairs.byRef.has(chairKey({ tableId: "run", seat: index })),
    );
    expect(gone).toBeGreaterThanOrEqual(0);
    expect(() =>
      shiftSeats(
        plan([run, intruder]),
        { tableId: "run", seat: gone },
        { tableId: "run", seat: 0 },
        later,
      ),
    ).toThrow("There is no chair there");
  });
});

describe("restoreSeatLabels", () => {
  it("puts every recorded name back", () => {
    const subject = seated(table("t", { size: 4, endSeats: false }), {
      1: "Ada",
      2: "Grace",
    });
    const [restored] = restoreSeatLabels(
      plan([subject]),
      [
        { tableId: "t", seat: 0, label: "Ada" },
        { tableId: "t", seat: 1, label: "Grace" },
        { tableId: "t", seat: 2, label: "" },
      ],
      later,
    ) as [SeatingTable];
    expect(restored.seats.slice(0, 3).map((seat) => seat.label)).toEqual([
      "Ada",
      "Grace",
      "",
    ]);
    expect(restored.version).toBe(subject.version + 1);
  });

  it("writes nothing for a seat that already holds what was recorded", () => {
    const subject = seated(table("t", { size: 4, endSeats: false }), {
      0: "Ada",
    });
    expect(
      restoreSeatLabels(
        plan([subject]),
        [{ tableId: "t", seat: 0, label: "Ada" }],
        later,
      ),
    ).toEqual([]);
  });

  it("treats a seat the table no longer has as a corrupt row", () => {
    const subject = table("t", { size: 2, endSeats: false });
    expect(() =>
      restoreSeatLabels(
        plan([subject]),
        [{ tableId: "t", seat: 9, label: "Ada" }],
        later,
      ),
    ).toThrow("This table has no seat 10");
  });
});
