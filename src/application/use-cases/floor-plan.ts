/**
 * Loading a floor plan: the room a table stands in, and what else is in it.
 *
 * Every placement rule in `src/domain/seating-table.ts` takes a `FloorPlan`,
 * because a position is legal only if it is both inside the room and clear of
 * the other tables — and the room belongs to the **event**, not to the
 * application. So every seating command that places, moves, turns, reshapes or
 * restores a table reads its event first.
 *
 * That is one extra read per write, and it is worth being explicit about why it
 * is not avoidable: without it the domain would have to fall back on a constant
 * room size, which is exactly the assumption a per-event room removes. The read
 * is by primary key and the write that follows is version-guarded, so a room
 * resized between the two loses the race the same way any other stale write
 * does.
 */

import type { Event, FloorPlan, SeatingTable } from "../../domain";
import { roomOf } from "../../domain";
import { AppError } from "../errors";
import type { Dependencies } from "../ports";

export interface LoadedFloorPlan {
  event: Event;
  /** Active tables only — an archived one holds no cells. */
  plan: FloorPlan;
}

export async function loadFloorPlan(
  deps: Dependencies,
  orgId: string,
  eventId: string,
): Promise<LoadedFloorPlan> {
  const event = await deps.events.getById(orgId, eventId);
  if (!event) throw new AppError("NOT_FOUND", "Event not found");
  const tables = await deps.seatingTables.list(orgId, {
    eventId,
    status: "active",
  });
  return { event, plan: { room: roomOf(event), tables } };
}

/** The same, for a caller that already has the event in hand. */
export function floorPlanOf(
  event: Event,
  tables: readonly SeatingTable[],
): FloorPlan {
  return { room: roomOf(event), tables };
}
