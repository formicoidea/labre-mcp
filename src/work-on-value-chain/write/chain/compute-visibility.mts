// Step 3 of the write:chain:* pipeline — deterministic Y (visibility) for
// a value-chain DAG with one or more anchors.
//
// Hard rule (DSL semantics): every dependency edge `A -> B` produces
// `Y(A) > Y(B)` strictly. Y is the only visual cue for the dependency
// direction in OWM, so two connected nodes can NEVER share a horizontal
// line and their order on Y is fixed by the link orientation.
//
// Algorithm — per-branch reasoning rooted at the anchor(s):
//
//   1. Build the merged DAG (multi-source: every component with role
//      'anchor' is a source). Compute, for each non-anchor component,
//      depth(c) = length of the LONGEST path from any anchor to c. The
//      longest-path choice means each parent ends up strictly above each
//      child by construction — no separate enforcement pass is needed.
//
//   2. Pick a step that uses the full canvas height [Y_MIN, ANCHOR_VISIBILITY]:
//        L           = max depth(c) over reachable non-anchor components
//        L_effective = max(L, MIN_EFFECTIVE_L)        // floor so L=1/L=2 stay
//                                                    // visually compact near
//                                                    // the anchor instead of
//                                                    // stretching across the
//                                                    // whole canvas.
//        step        = (ANCHOR_VISIBILITY − Y_MIN) / L_effective
//
//   3. Y_nominal(c) = ANCHOR_VISIBILITY − depth(c) × step.
//
//   4. Semantic jitter (deterministic, NOT random) to avoid the rigid
//      "all-same-depth nodes on a perfect horizontal line" look:
//
//        chain_through(c) = longestIn(c) + longestOut(c)
//        ratio(c)         = chain_through(c) / L          // ∈ [0, 1]
//        band_half        = min(BAND_MAX, (step − EDGE_MIN_GAP) / 2)
//        offset(c)        = (2 × ratio(c) − 1) × band_half
//        Y(c)             = clamp(Y_nominal(c) + offset(c), Y_MIN, ANCHOR_VISIBILITY)
//
//      Components on the longest chain (ratio=1) are pushed up by
//      band_half. Components on short chains are pushed down. The cap on
//      band_half guarantees worst-case parent − worst-case child ≥
//      EDGE_MIN_GAP, so the strict edge-direction rule still holds.
//
//   5. Anchors:
//        anchor_depth(A) = max(0, min(depth(c) for c ∈ children(A)) − 1)
//        if anchor_depth(A) = 0 :  Y(A) = ANCHOR_VISIBILITY
//        else                  :  Y(A) = ANCHOR_VISIBILITY
//                                          − (anchor_depth(A) + SECONDARY_ANCHOR_OFFSET)
//                                          × step
//
//      A "secondary" anchor (one whose first reachable child sits deep in
//      another anchor's chain) lands between two integer depth levels
//      thanks to SECONDARY_ANCHOR_OFFSET, avoiding a Y collision with the
//      regular components at depth(child)−1.
//
//   6. Canvas height — when the longest chain exceeds DENSITY_LIMIT_L,
//      the vertical step would drop below 0.1 / 3, breaking visual
//      readability in the renderer's default canvas. We keep the
//      normalised Y values in [Y_MIN, ANCHOR_VISIBILITY] and instead
//      scale the OWM canvas height proportionally so the per-step pixel
//      gap stays roughly constant. Canvas WIDTH is computed by step 4
//      (adjust-x) based on horizontal density.
//
//   7. Orphans (components unreachable from any anchor) receive
//      Y = ORPHAN_FALLBACK_Y (mid-canvas) and X = INITIAL_EVOLUTION_PLACEHOLDER
//      (overwritten by step 4 — adjust-x — using the LLM xHint or a
//      uniform per-Y-level fallback).

import type {
  DependencyLink,
  LabelOffset,
  PositionedComponent,
  PositionedValueChain,
  RawValueChain,
  ValueChainComponent,
} from '../../../types/value-chain.mjs';

// ─── Constants ──────────────────────────────────────────────────────────

export const ANCHOR_VISIBILITY = 0.95;
export const Y_MIN = 0.10;
/** Floor on the effective chain length used to derive `step`. Ensures that
 *  short graphs (L=1, L=2) keep components close to the anchor instead of
 *  spreading them across the full canvas. */
export const MIN_EFFECTIVE_L = 3;
/** Half-amplitude cap of the semantic jitter (so peak-to-peak ≤ 0.10). */
export const BAND_MAX = 0.05;
/** Minimum visible gap between a parent and its child after jitter. */
export const EDGE_MIN_GAP = 0.01;
/** Sub-step push applied to secondary anchors so they don't collide with
 *  regular components at depth(child) − 1. */
export const SECONDARY_ANCHOR_OFFSET = 0.3;
/** Y placeholder for components unreachable from any anchor. */
export const ORPHAN_FALLBACK_Y = 0.50;
/** X placeholder seeded by this step for every non-anchor component. The
 *  value is overwritten by step 4 (adjust-x) using `xHint` or a uniform
 *  per-Y-level fallback, so it carries no semantic meaning. */
export const INITIAL_EVOLUTION_PLACEHOLDER = 0.5;

// ─── Canvas sizing ──────────────────────────────────────────────────────

export const BASE_CANVAS_HEIGHT = 650;
/** Strict threshold on L above which the canvas height is scaled. */
export const DENSITY_LIMIT_L = 24;
/** Reference chain length used to compute the height scale factor. */
export const DENSITY_REFERENCE_L = 25;

// ─── Adjacency helpers ──────────────────────────────────────────────────

interface Adjacency {
  children: Map<string, string[]>;
  parents: Map<string, string[]>;
}

function buildAdjacency(
  names: readonly string[],
  links: readonly DependencyLink[],
): Adjacency {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const n of names) {
    children.set(n, []);
    parents.set(n, []);
  }
  for (const { from, to } of links) {
    children.get(from)?.push(to);
    parents.get(to)?.push(from);
  }
  return { children, parents };
}

/** Kahn-style topological order. The graph is acyclic by upstream contract
 *  (cycle detection happens in step 2 — generate-chain validation). */
function topologicalOrder(
  names: readonly string[],
  children: Map<string, string[]>,
  parents: Map<string, string[]>,
): string[] {
  const inDegree = new Map<string, number>();
  for (const n of names) inDegree.set(n, parents.get(n)?.length ?? 0);

  const queue: string[] = names.filter(n => (inDegree.get(n) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of children.get(u) ?? []) {
      const d = (inDegree.get(v) ?? 0) - 1;
      inDegree.set(v, d);
      if (d === 0) queue.push(v);
    }
  }
  return order;
}

/** Multi-source longest path. Sources (anchors) start at 0; everything
 *  else starts at -∞. Returns -∞ for components unreachable from any
 *  anchor. */
function longestFromAnchors(
  anchorNames: readonly string[],
  topoOrder: readonly string[],
  children: Map<string, string[]>,
): Map<string, number> {
  const depth = new Map<string, number>();
  for (const n of topoOrder) depth.set(n, Number.NEGATIVE_INFINITY);
  for (const a of anchorNames) depth.set(a, 0);

  for (const u of topoOrder) {
    const du = depth.get(u);
    if (du === undefined || du === Number.NEGATIVE_INFINITY) continue;
    for (const v of children.get(u) ?? []) {
      const candidate = du + 1;
      if (candidate > (depth.get(v) ?? Number.NEGATIVE_INFINITY)) {
        depth.set(v, candidate);
      }
    }
  }
  return depth;
}

/** Longest path from each node to any leaf (a leaf has no outgoing edges). */
function longestToLeaf(
  topoOrder: readonly string[],
  children: Map<string, string[]>,
): Map<string, number> {
  const depth = new Map<string, number>();
  // Initialize leaves to 0; everything else accumulates from descendants.
  for (const n of topoOrder) {
    depth.set(n, (children.get(n) ?? []).length === 0 ? 0 : Number.NEGATIVE_INFINITY);
  }
  for (const u of [...topoOrder].reverse()) {
    for (const v of children.get(u) ?? []) {
      const dv = depth.get(v);
      if (dv === undefined || dv === Number.NEGATIVE_INFINITY) continue;
      const candidate = dv + 1;
      if (candidate > (depth.get(u) ?? Number.NEGATIVE_INFINITY)) {
        depth.set(u, candidate);
      }
    }
    // If u still has -Infinity (no descendant reaches a leaf, e.g.
    // disconnected sub-DAG), treat it as a leaf with depth 0.
    if (depth.get(u) === Number.NEGATIVE_INFINITY) depth.set(u, 0);
  }
  return depth;
}

// ─── Canvas height ──────────────────────────────────────────────────────

/** Compute the OWM canvas height for the given longest-chain length.
 *  Height is scaled when L > DENSITY_LIMIT_L so the per-step pixel gap
 *  remains readable. Width is the responsibility of step 4 (adjust-x). */
export function computeMapHeight(L: number): number {
  if (L <= DENSITY_LIMIT_L) return BASE_CANVAS_HEIGHT;
  return Math.ceil((BASE_CANVAS_HEIGHT * L) / DENSITY_REFERENCE_L);
}

// ─── Misc helpers ───────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function emptyLabel(): LabelOffset {
  return { dx: 0, dy: 0 };
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface ComputeVisibilityResult {
  chain: PositionedValueChain;
  mapSize: { height: number };
}

/**
 * Compute the Y coordinate for every component plus the OWM canvas size.
 *
 * Returns a `PositionedValueChain` where:
 *   - `visibility` respects the strict edge-direction rule,
 *   - `evolution` is seeded with `INITIAL_EVOLUTION_PLACEHOLDER` (overwritten by step 4 — adjust-x),
 *   - `label` is the placeholder `{ dx: 0, dy: 0 }` (filled by step 5 — place-labels).
 *
 * Throws when no anchor (`role === 'anchor'`) is present.
 */
export function computeVisibility(raw: RawValueChain): ComputeVisibilityResult {
  const anchors = raw.components.filter(c => c.role === 'anchor');
  if (anchors.length === 0) {
    throw new Error('computeVisibility: no anchor component found (role="anchor")');
  }

  const names = raw.components.map(c => c.name);
  const anchorNames = anchors.map(a => a.name);
  const { children, parents } = buildAdjacency(names, raw.links);
  const topoOrder = topologicalOrder(names, children, parents);

  const dIn = longestFromAnchors(anchorNames, topoOrder, children);
  const dOut = longestToLeaf(topoOrder, children);

  // L = longest chain measured on non-anchor reachable components.
  let L = 0;
  for (const c of raw.components) {
    if (c.role === 'anchor') continue;
    const d = dIn.get(c.name);
    if (d === undefined || d === Number.NEGATIVE_INFINITY) continue;
    if (d > L) L = d;
  }
  const lEffective = Math.max(L, MIN_EFFECTIVE_L);
  const step = (ANCHOR_VISIBILITY - Y_MIN) / lEffective;
  const bandHalf = Math.max(0, Math.min(BAND_MAX, (step - EDGE_MIN_GAP) / 2));

  // For ratio in jitter — division by L (not lEffective): when L < 3 we
  // intentionally don't compress further, but ratio is bounded in [0, 1]
  // regardless because chain_through ≤ L by construction.
  const ratioDenominator = L > 0 ? L : 1;

  // ── Place anchors ────────────────────────────────────────────────────
  const yByName = new Map<string, number>();
  for (const a of anchors) {
    const childNames = children.get(a.name) ?? [];
    let minChildDepth = Number.POSITIVE_INFINITY;
    for (const cn of childNames) {
      const d = dIn.get(cn);
      if (d === undefined || d === Number.NEGATIVE_INFINITY) continue;
      if (d < minChildDepth) minChildDepth = d;
    }
    if (minChildDepth === Number.POSITIVE_INFINITY) {
      // No reachable child — anchor sits at the top.
      yByName.set(a.name, ANCHOR_VISIBILITY);
      continue;
    }
    const anchorDepth = Math.max(0, minChildDepth - 1);
    if (anchorDepth === 0) {
      yByName.set(a.name, ANCHOR_VISIBILITY);
    } else {
      const y = ANCHOR_VISIBILITY - (anchorDepth + SECONDARY_ANCHOR_OFFSET) * step;
      yByName.set(a.name, clamp(y, Y_MIN, ANCHOR_VISIBILITY));
    }
  }

  // ── Place non-anchor reachable components ───────────────────────────
  for (const c of raw.components) {
    if (c.role === 'anchor') continue;
    const d = dIn.get(c.name);
    if (d === undefined || d === Number.NEGATIVE_INFINITY) continue;

    const yNominal = ANCHOR_VISIBILITY - d * step;
    const out = dOut.get(c.name) ?? 0;
    const chainThrough = d + out;
    const ratio = chainThrough / ratioDenominator;
    const offset = (2 * ratio - 1) * bandHalf;
    yByName.set(c.name, clamp(yNominal + offset, Y_MIN, ANCHOR_VISIBILITY));
  }

  // ── Assemble PositionedComponents ───────────────────────────────────
  const positioned: PositionedComponent[] = raw.components.map((c: ValueChainComponent) => {
    const y = yByName.get(c.name);
    if (y !== undefined) {
      return {
        ...c,
        visibility: y,
        evolution: INITIAL_EVOLUTION_PLACEHOLDER,
        label: emptyLabel(),
      };
    }
    // Orphan — unreachable from any anchor.
    return {
      ...c,
      visibility: ORPHAN_FALLBACK_Y,
      evolution: INITIAL_EVOLUTION_PLACEHOLDER,
      label: emptyLabel(),
    };
  });

  return {
    chain: {
      metadata: raw.metadata,
      components: positioned,
      links: raw.links,
    },
    mapSize: { height: computeMapHeight(L) },
  };
}
