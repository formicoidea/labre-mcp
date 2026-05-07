// Phase 7 — canonical snap refinement after V6 force-directed.
//
// V6's continuous-position simulation finds a globally-good layout
// but doesn't apply the V5 canonical conventions (proportional
// `dx_left = -(name.length × 7 + 3)`, `dy ∈ {0, ±25}` family,
// preference for cardinal directions). On a 14-component Spotify
// chain the user manually re-snapped 11 labels back to canonical
// positions, calling them "the finishing touches".
//
// Phase 7 reproduces this finishing pass deterministically: per
// label, evaluate the V6 continuous offset alongside 8 V5 canonical
// candidates, score each, prefer the canonical when it doesn't
// degrade the hard-violation count.

import type {
  LabelOffset,
  PositionedComponent,
  PositionedValueChain,
} from '../../../../../types/value-chain.mjs';
import type { EmitOwmOptions } from '../emit/emit-owm.mjs';
import { computeGeometry } from '../../../../../lib/owm/analytical-geometry.mjs';
import {
  detectAllOverlaps,
  type Overlap,
} from '../../../../../lib/owm/overlap-detector.mjs';
import { LABEL_CHAR_WIDTH } from '../../../../../lib/owm/svg-bbox-parser.mjs';
import { projectHardConstraints } from './force-directed.mjs';

// ─── Canonical offset constants (re-introduced from V5) ────────────────

/** Pixel gap between the right edge of a left-aligned label and the
 *  component circle. Empirical, validated by the user 2026-05-06. */
export const LEFT_FLUSH_BUFFER_PX = 3;
/** Constant offset for the right cardinal and right diagonals. */
export const RIGHT_OFFSET_PX = 20;
/** Y offsets for the cardinals. */
export const TOP_OFFSET_PX = -25;
export const BOTTOM_OFFSET_PX = 25;
/** Y offset magnitude for diagonals. */
export const DIAGONAL_DY_OFFSET_PX = 15;

// ─── Score weights (mirror V5 verify-layout) ──────────────────────────

export const SCORE_HARD_PENALTY    = 1000;
export const SCORE_SPACING_PENALTY = 100;
export const SCORE_EDGE_PENALTY    = 10;
export const SCORE_AXIS_PENALTY    = 1;

const HARD_KINDS: ReadonlySet<Overlap['kind']> = new Set([
  'label-label',
  'component-label',
  'label-canvas',
]);

const PENALTY_BY_KIND: Record<Overlap['kind'], number> = {
  'label-label':         SCORE_HARD_PENALTY,
  'component-label':     SCORE_HARD_PENALTY,
  'label-canvas':        SCORE_HARD_PENALTY,
  'label-spacing':       SCORE_SPACING_PENALTY,
  'label-edge':          SCORE_EDGE_PENALTY,
  'label-axis':          SCORE_AXIS_PENALTY,
  // Out of scope for label-only optimisation.
  'anchor-anchor':       0,
  'anchor-component':    0,
  'anchor-label':        0,
  'component-component': 0,
};

// ─── Canonical candidate set ──────────────────────────────────────────

/**
 * Eight V5 canonical label offsets for `componentName`. The LEFT
 * cardinals scale with the label width so the right edge of the
 * label sits `LEFT_FLUSH_BUFFER_PX` pixels left of the component
 * circle.
 */
export function canonicalOffsetsFor(componentName: string): ReadonlyArray<LabelOffset> {
  const labelWidth = Math.max(1, componentName.length) * LABEL_CHAR_WIDTH;
  const dxLeft = -(labelWidth + LEFT_FLUSH_BUFFER_PX);
  return [
    { dx: 0,                dy: BOTTOM_OFFSET_PX           }, // BELOW
    { dx: 0,                dy: TOP_OFFSET_PX              }, // ABOVE
    { dx: RIGHT_OFFSET_PX,  dy: 0                          }, // RIGHT
    { dx: dxLeft,           dy: 0                          }, // LEFT (proportional)
    { dx: RIGHT_OFFSET_PX,  dy: -DIAGONAL_DY_OFFSET_PX     }, // RIGHT_UP
    { dx: RIGHT_OFFSET_PX,  dy:  DIAGONAL_DY_OFFSET_PX     }, // RIGHT_DOWN
    { dx: dxLeft,           dy: -DIAGONAL_DY_OFFSET_PX     }, // LEFT_UP
    { dx: dxLeft,           dy:  DIAGONAL_DY_OFFSET_PX     }, // LEFT_DOWN
  ];
}

// ─── Helpers ──────────────────────────────────────────────────────────

function withLabel(
  chain: PositionedValueChain,
  name: string,
  label: LabelOffset,
): PositionedValueChain {
  return {
    metadata: chain.metadata,
    links: chain.links,
    components: chain.components.map<PositionedComponent>(c =>
      c.name === name ? { ...c, label } : c,
    ),
  };
}

function sameOffset(a: LabelOffset, b: LabelOffset): boolean {
  return a.dx === b.dx && a.dy === b.dy;
}

function scoreOverlaps(overlaps: readonly Overlap[]): { hard: number; total: number } {
  let hard = 0;
  let total = 0;
  for (const ov of overlaps) {
    if (HARD_KINDS.has(ov.kind)) hard++;
    const penalty = PENALTY_BY_KIND[ov.kind] ?? 0;
    total += penalty * ov.severity;
  }
  return { hard, total };
}

// ─── Public API ───────────────────────────────────────────────────────

export interface SnapResult {
  chain: PositionedValueChain;
  /** Names of components whose label was snapped to a canonical
   *  position by this pass. Excludes labels that were left at their
   *  V6 continuous position. */
  snapped: string[];
}

/**
 * For each non-anchor component, evaluate the V6 continuous offset
 * alongside the 8 V5 canonical candidates and pick the best
 * (minimum hard violations, with canonical preferred at hard ties).
 * After the per-label sweep, run `projectHardConstraints` once more
 * as defensive cleanup.
 *
 * The input chain is not mutated.
 */
export function snapToCanonical(
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
): SnapResult {
  let current = chain;
  const snappedNames: string[] = [];

  for (const c of chain.components) {
    if (c.role === 'anchor') continue;

    const continuous = c.label;
    const canonicalSet = canonicalOffsetsFor(c.name);

    // Evaluate the continuous (V6) candidate first so it always sits
    // in the comparison set, then each canonical option.
    interface Eval { offset: LabelOffset; isCanonical: boolean; hard: number; total: number; }
    const evals: Eval[] = [];
    const evalCandidate = (offset: LabelOffset, isCanonical: boolean): void => {
      const trial = withLabel(current, c.name, offset);
      const geometry = computeGeometry(trial, emitOpts);
      const overlaps = detectAllOverlaps(geometry);
      const { hard, total } = scoreOverlaps(overlaps);
      evals.push({ offset, isCanonical, hard, total });
    };
    evalCandidate(continuous, false);
    for (const cand of canonicalSet) evalCandidate(cand, true);

    // Selection rules:
    //  1. Lower hard always wins.
    //  2. Same hard — canonical preferred over continuous.
    //  3. Same hard + same canonicality — lower total score wins.
    let best: Eval = evals[0];
    for (let i = 1; i < evals.length; i++) {
      const cand = evals[i];
      const winsOnHard = cand.hard < best.hard;
      const sameHardCanonicalWins =
        cand.hard === best.hard && cand.isCanonical && !best.isCanonical;
      const sameClassLowerScore =
        cand.hard === best.hard && cand.isCanonical === best.isCanonical && cand.total < best.total;
      if (winsOnHard || sameHardCanonicalWins || sameClassLowerScore) {
        best = cand;
      }
    }

    if (!sameOffset(best.offset, continuous)) {
      current = withLabel(current, c.name, best.offset);
      if (best.isCanonical) snappedNames.push(c.name);
    }
  }

  // Defensive final projection — guarantees hard = 0 even if a snap
  // accidentally introduced a residual (impossible by construction
  // of the filter, but cheap insurance).
  current = projectHardConstraints(current, emitOpts);

  return { chain: current, snapped: snappedNames };
}
