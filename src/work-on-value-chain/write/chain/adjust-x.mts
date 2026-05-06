// Step 5 of the write:chain:* pipeline — deterministic X adjustment for
// READABILITY around the LLM-proposed `xHint`.
//
// Contract: the LLM (step 3, propose-x-rough) proposes a rough X per
// component for visual clarity (NOT evolution maturity — that is a phase 3
// concern, hidden here). This step preserves the LLM's intent within a
// tolerance band of ±BAND_HALF, while enforcing four readability invariants:
//
//   1. Initialisation
//      X(c) = c.xHint                                         (or fallback)
//      X_anchor(c) = X(c)                                     (band centre)
//      Clamp to [LEFT_BOUND, RIGHT_BOUND].
//      When xHint is undefined (LLM degradation or per-component miss),
//      fall back to a uniform spread within the component's Y level so
//      orphans do not all collapse to a single X.
//
//   2. Supplier alignment (parents↔children)
//      A "supplier" c with ≥ 2 consumers (components A such that A → c) is
//      recentred on the mean X of those consumers, capped to the band
//      [X_anchor − BAND_HALF, X_anchor + BAND_HALF]. Single-consumer
//      suppliers and orphans keep X_anchor.
//      Pass order: top-down by Y descending (consumers first), so each
//      supplier sees the post-pass X of its consumers.
//
//   3. Anti-collision
//      Within each Y level (|ΔY| < EDGE_GAP_Y), sort by current X
//      ascending and sweep left-to-right enforcing MIN_GAP_X between
//      consecutive components. Pushing past X_anchor + BAND_HALF emits a
//      warning on the ambient collector but the push is still applied
//      (the unicity invariant for (X, Y) takes precedence over band
//      preservation).
//
//   4. Map width
//      mapWidth scales with the densest ±DENSITY_WINDOW_HALF horizontal
//      window. Mirrors the canvas-height rule in compute-visibility:
//      width grows linearly above a saturation count.
//
// Anchors traverse this pipeline like any other component (rule D2):
// the legacy 0.5 pinning is gone. Multi-anchor X collisions are resolved
// by step 3.

import type {
  PositionedComponent,
  PositionedValueChain,
} from '../../../types/value-chain.mjs';
import { getCurrentCollector } from '../../../lib/degradation/index.mjs';
import { EDGE_MIN_GAP } from './compute-visibility.mjs';

// ─── Constants ──────────────────────────────────────────────────────────

export const LEFT_BOUND = 0.10;
export const RIGHT_BOUND = 0.90;
/** Tolerance band around X_anchor (the LLM-proposed xHint). */
export const BAND_HALF = 0.10;
/** Minimum X gap between two components sharing a Y level. */
export const MIN_GAP_X = 0.02;
/** Half-width of the sliding window used for horizontal density. */
export const DENSITY_WINDOW_HALF = 0.05;
/** Strict threshold on K above which mapWidth is scaled. */
export const DENSITY_LIMIT_K = 4;
/** Reference window count used to compute the width scale factor. */
export const DENSITY_REFERENCE_K = 5;
export const BASE_CANVAS_WIDTH = 1216;
/** Y delta below which two components are considered "at the same level"
 *  for anti-collision purposes. Aligned with the EDGE_MIN_GAP invariant
 *  enforced upstream by compute-visibility. */
export const EDGE_GAP_Y = EDGE_MIN_GAP;

// ─── Helpers ────────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function warn(source: string, message: string): void {
  const collector = getCurrentCollector();
  if (collector) {
    collector.recordError(source, new Error(message), {
      recoverable: true,
      severity: 'warning',
    });
  }
}

/** Group components by approximate Y level (within EDGE_GAP_Y). Returns
 *  groups in arbitrary order; ordering inside a group is preserved. */
function groupByYLevel(
  components: readonly PositionedComponent[],
): PositionedComponent[][] {
  const sorted = [...components].sort((a, b) => b.visibility - a.visibility);
  const groups: PositionedComponent[][] = [];
  for (const c of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last[0].visibility - c.visibility) < EDGE_GAP_Y) {
      last.push(c);
    } else {
      groups.push([c]);
    }
  }
  return groups;
}

/** Initial X for a component: xHint clamped, or a uniform per-Y-level
 *  spread when xHint is missing. The fallback mirrors the legacy
 *  initialSpread behaviour just enough to give the deterministic passes
 *  something to work with. */
function initialX(
  components: readonly PositionedComponent[],
): Map<string, number> {
  const out = new Map<string, number>();

  // First pass — honour every defined xHint.
  for (const c of components) {
    if (typeof c.xHint === 'number') {
      out.set(c.name, clamp(c.xHint, LEFT_BOUND, RIGHT_BOUND));
    }
  }

  // Second pass — uniform per-level spread for components with no hint.
  // Spread positions inside each level, skipping slots already occupied
  // by hinted siblings so the fallback doesn't trample the LLM intent.
  const groups = groupByYLevel(components);
  for (const group of groups) {
    const missing = group.filter(c => !out.has(c.name));
    if (missing.length === 0) continue;
    const n = missing.length;
    if (n === 1) {
      out.set(missing[0].name, (LEFT_BOUND + RIGHT_BOUND) / 2);
      continue;
    }
    for (let i = 0; i < n; i++) {
      const x = LEFT_BOUND + ((RIGHT_BOUND - LEFT_BOUND) * i) / (n - 1);
      out.set(missing[i].name, x);
    }
  }

  return out;
}

/** Pass 2 — supplier alignment. */
function alignSuppliers(
  chain: PositionedValueChain,
  x: Map<string, number>,
  xAnchor: ReadonlyMap<string, number>,
): void {
  const consumers = new Map<string, string[]>();
  for (const c of chain.components) consumers.set(c.name, []);
  for (const link of chain.links) {
    consumers.get(link.to)?.push(link.from);
  }

  // Top-down by Y descending — consumers (higher Y) settled before suppliers.
  const order = [...chain.components].sort((a, b) => b.visibility - a.visibility);
  for (const c of order) {
    const cons = consumers.get(c.name) ?? [];
    if (cons.length < 2) continue;

    const xs: number[] = [];
    for (const n of cons) {
      const xn = x.get(n);
      if (xn !== undefined) xs.push(xn);
    }
    if (xs.length < 2) continue;

    const target = xs.reduce((s, v) => s + v, 0) / xs.length;
    const anchor = xAnchor.get(c.name) ?? target;
    const constrained = clamp(target, anchor - BAND_HALF, anchor + BAND_HALF);
    x.set(c.name, clamp(constrained, LEFT_BOUND, RIGHT_BOUND));
  }
}

/** Pass 3 — anti-collision sweep within each Y level. */
function antiCollision(
  chain: PositionedValueChain,
  x: Map<string, number>,
  xAnchor: ReadonlyMap<string, number>,
): void {
  const groups = groupByYLevel(chain.components);
  for (const group of groups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      const ax = x.get(a.name) ?? 0;
      const bx = x.get(b.name) ?? 0;
      return ax - bx || a.name.localeCompare(b.name);
    });
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const prevX = x.get(prev.name) ?? 0;
      const currX = x.get(curr.name) ?? 0;
      if (currX - prevX >= MIN_GAP_X) continue;

      const desired = prevX + MIN_GAP_X;
      const anchor = xAnchor.get(curr.name) ?? desired;
      if (desired > anchor + BAND_HALF || desired > RIGHT_BOUND) {
        warn(
          'write-chain:adjust-x',
          `anti-collision pushed "${curr.name}" past its tolerance band ` +
          `to clear "${prev.name}" at y=${curr.visibility.toFixed(3)}`,
        );
      }
      x.set(curr.name, clamp(desired, LEFT_BOUND, RIGHT_BOUND));
    }
  }
}

/** Pass 4 — densest ±DENSITY_WINDOW_HALF window count, drives mapWidth. */
function computeMapWidth(x: ReadonlyMap<string, number>): number {
  const xs = [...x.values()].sort((a, b) => a - b);
  if (xs.length === 0) return BASE_CANVAS_WIDTH;

  let kMax = 0;
  let left = 0;
  for (let right = 0; right < xs.length; right++) {
    while (xs[right] - xs[left] > 2 * DENSITY_WINDOW_HALF) left++;
    const count = right - left + 1;
    if (count > kMax) kMax = count;
  }

  if (kMax <= DENSITY_LIMIT_K) return BASE_CANVAS_WIDTH;
  return Math.ceil((BASE_CANVAS_WIDTH * kMax) / DENSITY_REFERENCE_K);
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface AdjustXResult {
  chain: PositionedValueChain;
  mapSize: { width: number };
}

/**
 * Adjust X for readability around the LLM-proposed xHint and compute the
 * required canvas width. Returns a new chain (input is not mutated); the
 * `evolution` field carries the final X coordinate.
 */
export function adjustX(chain: PositionedValueChain): AdjustXResult {
  const x = initialX(chain.components);
  const xAnchor = new Map(x);

  alignSuppliers(chain, x, xAnchor);
  antiCollision(chain, x, xAnchor);

  const width = computeMapWidth(x);

  return {
    chain: {
      metadata: chain.metadata,
      links: chain.links,
      components: chain.components.map(c => ({
        ...c,
        evolution: clamp(x.get(c.name) ?? c.evolution, LEFT_BOUND, RIGHT_BOUND),
      })),
    },
    mapSize: { width },
  };
}
