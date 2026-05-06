// Fixed set of label offset candidates that `verify-layout` (Phase 3)
// will try when an initial offset chosen by `place-labels.mts` ends up
// in a collision. The first three entries match the legacy palette
// already used by `place-labels.mts` so the existing topological
// rules remain a valid initial guess; the diagonals extend the search
// space when straight cardinals are blocked.

import type { LabelOffset } from '../../types/value-chain.mjs';

export const LABEL_OFFSET_CANDIDATES: ReadonlyArray<LabelOffset> = [
  { dx:    0, dy:  25 },   // BELOW (legacy)
  { dx:    0, dy: -25 },   // ABOVE
  { dx:   20, dy:   0 },   // RIGHT (legacy)
  { dx: -100, dy:   0 },   // LEFT (legacy)
  { dx:   20, dy: -15 },   // RIGHT_UP
  { dx:   20, dy:  15 },   // RIGHT_DOWN
  { dx: -100, dy: -15 },   // LEFT_UP
  { dx: -100, dy:  15 },   // LEFT_DOWN
];
