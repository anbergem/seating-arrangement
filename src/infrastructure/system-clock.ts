/**
 * The real clock (blueprint B3, B7).
 *
 * Every domain function takes `now` as an argument and every use case gets it
 * from `Dependencies.clock`, so this is the only place in the application that
 * reads the wall clock. Tests replace it with a fixed value and nothing else
 * changes.
 *
 * ISO 8601 UTC with milliseconds, because timestamps are stored as TEXT and
 * compared lexicographically (B3): `toISOString()` is fixed-width and always
 * `Z`, so string order is time order.
 */

import type { Clock } from "../application/ports";

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};
