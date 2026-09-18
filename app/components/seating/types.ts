/** The shapes the seating actions return, as the UI sees them. */
import type { SeatingTable } from "./geometry";

export interface EventSummary {
  id: string;
  name: string;
  startsAt: string;
  /** The event's own floor, in grid cells. */
  roomWidth: number;
  roomHeight: number;
  status: "active" | "archived";
  version: number;
}

export interface EventDetail {
  event: EventSummary;
  tables: SeatingTable[];
}
