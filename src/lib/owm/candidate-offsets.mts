// Per-label candidate offset generator for `verify-layout`.
//
// Phase 5a switched the V4 constant `LABEL_OFFSET_CANDIDATES` to a
// per-label function because the canonical `dx = -100` only fits short
// labels: longer labels' bbox right edge reaches into the component
// circle (or worse, into a foreign neighbour) when offset by a fixed
// amount. The user's manual corrections on the Spotify map followed
// the rule `dx_left = -(label_width + LEFT_FLUSH_BUFFER_PX)` to keep
// the right edge of the text rectangle flush a few pixels left of
// the circle.
//
// `dx_right` stays constant at +20: at default cli-owm geometry
// (`COMPONENT_RADIUS = 5`), 20 px puts the left edge of the text 15
// px past the circle right edge — comfortable spacing regardless of
// label length.

import { LABEL_CHAR_WIDTH } from './svg-bbox-parser.mjs';
import type { LabelOffset } from '../../types/value-chain.mjs';

/** Pixel gap between the right edge of a left-aligned label and the
 *  component circle. Empirical, validated by the user's manual
 *  corrections on 2026-05-06. */
export const LEFT_FLUSH_BUFFER_PX = 3;

/** Constant offset used for the right cardinal and diagonals. */
export const RIGHT_OFFSET_PX = 20;

/** Vertical offsets used by the cardinal and diagonal candidates. */
export const TOP_OFFSET_PX = -25;
export const BOTTOM_OFFSET_PX = 25;
export const DIAGONAL_DY_OFFSET_PX = 15;

/**
 * Eight label offset candidates for `componentName`. Order matters:
 * the first that ties on score is picked deterministically. We keep
 * the same ordering as V4 (cardinals first, then diagonals) so
 * baseline V4 behaviour is preserved when label widths are short.
 */
export function candidatesFor(componentName: string): ReadonlyArray<LabelOffset> {
  const labelWidth = Math.max(1, componentName.length) * LABEL_CHAR_WIDTH;
  const dxLeft = -(labelWidth + LEFT_FLUSH_BUFFER_PX);
  return [
    { dx: 0,                dy: BOTTOM_OFFSET_PX  },   // BELOW
    { dx: 0,                dy: TOP_OFFSET_PX     },   // ABOVE
    { dx: RIGHT_OFFSET_PX,  dy: 0                  },  // RIGHT
    { dx: dxLeft,           dy: 0                  },  // LEFT (proportional)
    { dx: RIGHT_OFFSET_PX,  dy: -DIAGONAL_DY_OFFSET_PX }, // RIGHT_UP
    { dx: RIGHT_OFFSET_PX,  dy:  DIAGONAL_DY_OFFSET_PX }, // RIGHT_DOWN
    { dx: dxLeft,           dy: -DIAGONAL_DY_OFFSET_PX }, // LEFT_UP
    { dx: dxLeft,           dy:  DIAGONAL_DY_OFFSET_PX }, // LEFT_DOWN
  ];
}

/**
 * V4 backwards-compat constant. Some callers (and existing tests)
 * import this directly; we keep it around as the candidates for a
 * 14-character placeholder name (close to the V4 `dx = -100` magic
 * number for typical label widths). New code should call
 * `candidatesFor(name)` instead.
 *
 * @deprecated Use `candidatesFor(componentName)` instead.
 */
export const LABEL_OFFSET_CANDIDATES: ReadonlyArray<LabelOffset> = candidatesFor(
  'XXXXXXXXXXXXXX',
);
