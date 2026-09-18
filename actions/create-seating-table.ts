import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { createSeatingTable } from "../src/application/use-cases/create-seating-table";
import { runAppAction } from "../src/interface/run-app-action";

/** See `create-event.ts` for why this is structural and optional-chained. */
function createdId(result: unknown): string | undefined {
  return (result as { resource?: { id?: string } } | undefined)?.resource?.id;
}

export default defineAction({
  description:
    "Add a table to an event's seating arrangement. A table is rectangular or round, and its seats are worked out for you: one at every free cell touching it, numbered clockwise from 0, all of them unlabelled. A rectangle of length n seats 2n, plus one at each end when endSeats is on; a round table of diameter n seats 4n. Every event has its own room, so read get-event first for how big this one is. Leave gridX and gridY out and the table drops into the first free spot, which is usually what you want. For an L- or U-shaped arrangement use bootstrap-event-layout on an empty plan, or stand tables against each other and take the chairs off the join with remove-seat. Fails with NOT_FOUND when the event does not exist in the organization or has been archived, with INVARIANT when the position you asked for is outside the room or on top of another table, and with CONFLICT when somebody claimed that space first. Compensatable, not reversible: undo-operation removes the table rather than deleting it.",
  schema: z.object({
    eventId: z
      .string()
      .min(1)
      .describe("Id of the active event this table belongs to"),
    name: z
      .string()
      .min(1)
      .describe("What the table is called, 1 to 60 characters, e.g. 'Table 4'"),
    kind: z
      .enum(["rectangle", "round"])
      .optional()
      .describe(
        "rectangle is a straight run of tables' worth of seats down two sides; round is a circular table with chairs all the way around. Defaults to rectangle",
      ),
    size: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe(
        "How big the table is, in grid cells: a rectangle's length along its run (1 to 8), or a round table's diameter (1 to 4). A round table of diameter n seats 4n",
      ),
    endSeats: z
      .boolean()
      .optional()
      .describe(
        "Add a seat capping each end of a rectangle's run. Ignored for a round table, which has no ends",
      ),
    rotation: z
      .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
      .optional()
      .describe("Quarter turns clockwise; defaults to 0"),
    gridX: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Left edge in grid cells, counting from 0; omit both coordinates to use the first free spot",
      ),
    gridY: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Top edge in grid cells, counting from 0"),
    idempotencyKey: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Pass the same key when retrying a call whose outcome you did not see; the second call returns the table the first one created instead of creating another",
      ),
  }),
  mcpTool: true,
  audit: {
    target: (_args, result) => ({
      type: "seating_table",
      id: createdId(result),
      visibility: "org",
    }),
    summary: (args) => `Added table ${args.name}`,
  },
  run: (args, ctx) =>
    runAppAction(ctx, "create-seating-table", (actor, deps) =>
      createSeatingTable(deps, actor, args),
    ),
});
