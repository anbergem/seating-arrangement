/**
 * The pure geometry the floor plan UI shares with the server.
 *
 * `app/` may import types and pure helpers from `src/domain` and nothing else
 * from `src` (`scripts/check-boundaries.mjs`), and this is the one place that
 * does it, so the allowance is visible in a single file. It is a deep import
 * rather than the `src/domain` barrel deliberately: the barrel would drag the
 * whole domain — events, the operation ledger, the error type — into the
 * browser bundle for the sake of a handful of functions.
 *
 * Sharing them is the point twice over. The drag preview decides whether a drop
 * is legal with exactly the arithmetic the server will use, down to which
 * individual cells a table holds, so the outline never turns red for a move the
 * server would have accepted. And `layoutOf` is what draws the table at all:
 * where the body runs and where each numbered seat sits are answers only the
 * domain has, because they are derived from the shape rather than stored.
 */

export {
  availableSeatCount,
  blockedSeats,
  boundingBoxOf,
  buildSeats,
  cellKey,
  cellsAt,
  cellsOf,
  findSeat,
  fitsAt,
  footprintSize,
  isWithinRoom,
  layoutOf,
  occupiedCellKeys,
  planWith,
  rotatedPlacement,
  seatCount,
  seatMoveFits,
  seatOffset,
  shapeOf,
  DEFAULT_ROOM_HEIGHT,
  DEFAULT_ROOM_WIDTH,
  MAX_ROUND_DIAMETER,
  MAX_SEAT_LABEL_LENGTH,
  MAX_SIZE,
  MAX_TABLE_LENGTH,
  MIN_TABLE_SIZE,
  TABLE_SHAPE_KINDS,
} from "../../../src/domain/seating-table";

export {
  LAYOUT_KINDS,
  MAX_SECTION_TABLES,
  SECTION_COUNT,
} from "../../../src/domain/venue-layout";

export type {
  Cell,
  FloorPlan,
  MovedSeats,
  Rect,
  Room,
  Rotation,
  Seat,
  SeatingTable,
  SeatingTablePosition,
  SeatRef,
  TableLayout,
  TableShape,
  TableShapeKind,
} from "../../../src/domain/seating-table";

export type { LayoutKind } from "../../../src/domain/venue-layout";
