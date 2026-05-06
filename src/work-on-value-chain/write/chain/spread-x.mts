// Step 4 of the write:chain:* pipeline — deterministic X dispatch for
// READABILITY (not for evolution semantics).
//
// Goal: minimise the total length of dependency edges along X while keeping
// the chain readable. The output X coordinate is purely visual; real
// evolution positioning is delegated to phase 3 of the Wardley study cycle
// (estimateEvolution downstream).
//
// Algorithm (initial spread + single bottom-up barycenter pass):
//
//   1. Initial layout — group by visibility level, order each level by the
//      median X of its consumers (parents), spread the level evenly across
//      [LEFT_BOUND, RIGHT_BOUND]. This gives a wide, well-distributed
//      starting point.
//
//   2. Bottom-up barycenter — for every component that has at least two
//      children, recenter X on the mean of its children X. Single-child
//      and leaf nodes keep their initial spread position so the chain
//      stays visually spread within each level.
//
//   Anchor stays pinned at ANCHOR_X. X is clamped to [LEFT_BOUND, RIGHT_BOUND].
//
// Why not iterative full relaxation? In small chains (single-child paths)
// repeated barycenter passes collapse children onto their parent's X,
// destroying the horizontal spread. The single bottom-up pass with a
// >=2-children threshold gives most of the benefit (parents centred on
// their subtree) without the collapse.

import type {
  PositionedComponent,
  PositionedValueChain,
} from '../../../types/value-chain.mjs';

export const ANCHOR_X = 0.5;
export const LEFT_BOUND = 0.10;
export const RIGHT_BOUND = 0.90;
/** Minimum number of children a non-anchor node must have to qualify for
 *  the bottom-up barycenter recentering. Below this, the node keeps its
 *  initial spread position. */
export const BARYCENTER_MIN_CHILDREN = 2;

function median(values: readonly number[]): number {
  if (values.length === 0) return ANCHOR_X;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return ANCHOR_X;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/** Initial spread: order each level by median parent X, then distribute
 *  evenly across [LEFT_BOUND, RIGHT_BOUND]. Anchor stays at ANCHOR_X. */
function initialSpread(chain: PositionedValueChain): Map<string, number> {
  const xByName = new Map<string, number>();

  // Group components by visibility (Y) level.
  const levels = new Map<number, PositionedComponent[]>();
  for (const c of chain.components) {
    const list = levels.get(c.visibility) ?? [];
    list.push(c);
    levels.set(c.visibility, list);
  }

  // Process from top (anchor) to bottom.
  const sortedYs = [...levels.keys()].sort((a, b) => b - a);

  for (const y of sortedYs) {
    const peers = levels.get(y)!;
    const anchorPeers = peers.filter(p => p.role === 'anchor');
    const otherPeers = peers.filter(p => p.role !== 'anchor');
    // TODO(x-spread): every anchor is pinned to ANCHOR_X = 0.5. With
    // multiple anchors (multi-source DAG) they will overlap visually.
    // Address in a dedicated X-spread session.
    for (const a of anchorPeers) xByName.set(a.name, ANCHOR_X);

    if (otherPeers.length === 0) continue;

    const ordered = otherPeers
      .map(p => {
        const parents = chain.links.filter(l => l.to === p.name).map(l => l.from);
        const parentXs = parents
          .map(n => xByName.get(n))
          .filter((x): x is number => x !== undefined);
        return { peer: p, key: median(parentXs) };
      })
      .sort((a, b) => a.key - b.key || a.peer.name.localeCompare(b.peer.name));

    const n = ordered.length;
    if (n === 1) {
      xByName.set(ordered[0].peer.name, ANCHOR_X);
    } else {
      for (let i = 0; i < n; i++) {
        const x = LEFT_BOUND + ((RIGHT_BOUND - LEFT_BOUND) * i) / (n - 1);
        xByName.set(ordered[i].peer.name, x);
      }
    }
  }

  return xByName;
}

/** Bottom-up barycenter: each non-anchor component with at least
 *  BARYCENTER_MIN_CHILDREN children is recentered on the mean of its
 *  children's X. Components with fewer children keep their initial
 *  position so the level-wide spread is preserved. */
function barycenterChildren(
  xByName: Map<string, number>,
  chain: PositionedValueChain,
): void {
  const anchorName = chain.components.find(c => c.role === 'anchor')?.name;

  // Process bottom-up by visibility (smallest Y first) so children are
  // already finalised when the parent is recentered.
  const orderedByDepth = [...chain.components].sort((a, b) => a.visibility - b.visibility);

  for (const c of orderedByDepth) {
    if (c.name === anchorName) continue;

    const childNames = chain.links.filter(l => l.from === c.name).map(l => l.to);
    if (childNames.length < BARYCENTER_MIN_CHILDREN) continue;

    const childXs = childNames
      .map(n => xByName.get(n))
      .filter((x): x is number => x !== undefined);

    if (childXs.length < BARYCENTER_MIN_CHILDREN) continue;

    const target = clamp(mean(childXs), LEFT_BOUND, RIGHT_BOUND);
    xByName.set(c.name, target);
  }
}

/**
 * Spread X coordinates for visual readability. Initial level spread, then
 * a single bottom-up barycenter pass for nodes with >= 2 children.
 */
export function spreadXForReadability(chain: PositionedValueChain): PositionedValueChain {
  const xByName = initialSpread(chain);
  barycenterChildren(xByName, chain);

  return {
    metadata: chain.metadata,
    links: chain.links,
    components: chain.components.map(c => ({
      ...c,
      evolution: clamp(xByName.get(c.name) ?? c.evolution, LEFT_BOUND, RIGHT_BOUND),
    })),
  };
}
