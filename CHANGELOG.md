# Changelog

All notable user-facing changes to this app are documented here.

## 2026-09-22

### Added

- Drag a name from one seat to another to move a guest, at the same table or a different one.
  Dropping a name on a seat that is already taken swaps the two, so nobody is overwritten. The
  same move can be made from the keyboard: focus a seat, press Space to pick the name up, move
  to another seat and press Enter to place it. A move is one change in the activity feed with
  one Undo, even when it crosses two tables.

### Fixed

- A seated guest no longer disappears from the floor plan when a neighbouring table is pushed
  up against their chair. The rule that decides which of two tables gets a chair they share is
  a tie-break between two _empty_ chairs; it was also being applied to a chair somebody was
  sitting in, which took the chair away and hid the name while leaving it in the data.

## 2026-09-23

### Added

- Make room for a guest without retyping anybody. "Make room" marks every chair somebody can
  be moved along from; choose one, then choose which way, and everybody shifts up one place
  into the next free chair. The row of chairs is followed as it actually stands, so a shift
  runs round the end of a table and on to the next one where two are pushed together — which
  is how it works along one side of an L or a U. Chairs past the first free one are left
  alone. If a table's chairs go all the way round and every one of them is taken there is
  nowhere to leave a gap, so the table turns by one instead. It is one change in the activity
  feed with one Undo, however many tables it ran through.

## 2026-08-27

### Fixed

- Chat includes the runtime packages needed for provider keys after deployment.

For the full list of updates, see the [changelog folder](./changelog/).
