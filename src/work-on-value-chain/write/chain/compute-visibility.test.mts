// Tests for compute-visibility.mts (V4 — per-branch, multi-anchor).
//
// Validates:
//   - anchor pinned at ANCHOR_VISIBILITY (single-anchor case)
//   - L=1 and L=2 keep components close to the anchor (effective L floor)
//   - L=3 stretches the longest chain to Y_MIN
//   - long chains use the full vertical range
//   - secondary anchors land between two integer depth levels of the
//     primary chain (multi-anchor case from the design doc)
//   - strict edge direction Y(parent) > Y(child) on diamonds, shortcuts,
//     branches with mixed depths
//   - semantic jitter: components on the longest chain ratio=1 are pushed
//     up; components on shorter chains are pushed down or unbiased
//   - orphans land at ORPHAN_FALLBACK_Y
//   - mapSize stays at base for L ≤ 24 and scales with L beyond that
//   - throws when no anchor is present
//   - evolution seeded from PHASE_CENTROIDS (anchors at 0.5)
//   - label placeholder is { 0, 0 }

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVisibility,
  computeMapSize,
  ANCHOR_VISIBILITY,
  Y_MIN,
  ORPHAN_FALLBACK_Y,
  BAND_MAX,
  EDGE_MIN_GAP,
  SECONDARY_ANCHOR_OFFSET,
  MIN_EFFECTIVE_L,
  BASE_CANVAS_WIDTH,
  BASE_CANVAS_HEIGHT,
} from './compute-visibility.mjs';
import { PHASE_CENTROIDS } from '../../../schemas/inputs.schema.mjs';
import type { RawValueChain } from '../../../types/value-chain.mjs';

// ─── helpers ─────────────────────────────────────────────────────────────

function chain(overrides: Partial<RawValueChain> = {}): RawValueChain {
  return {
    metadata: {
      title: 't', angle: 'a', scope: 's', objective: 'o', imperatives: [],
      temporality: 'present', contextSummary: '',
    },
    components: [],
    links: [],
    ...overrides,
  };
}

function findY(result: ReturnType<typeof computeVisibility>, name: string): number {
  const c = result.chain.components.find(c => c.name === name);
  if (!c) throw new Error(`component not found: ${name}`);
  return c.visibility;
}

function assertEdgeDirection(result: ReturnType<typeof computeVisibility>): void {
  const yByName = new Map(result.chain.components.map(c => [c.name, c.visibility] as const));
  for (const { from, to } of result.chain.links) {
    const ya = yByName.get(from);
    const yb = yByName.get(to);
    assert.ok(ya !== undefined && yb !== undefined,
      `link references unknown component: ${from} -> ${to}`);
    assert.ok(ya > yb,
      `edge direction violated: Y(${from})=${ya} must be > Y(${to})=${yb}`);
  }
}

// ─── basic anchor + evolution + label ───────────────────────────────────

describe('computeVisibility — basic invariants', () => {
  it('pins a single anchor at ANCHOR_VISIBILITY with evolution 0.5', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'Customer', type: 'anchor',    role: 'anchor', phase: 'phase4' },
        { name: 'Payment',  type: 'component', role: 'need',   phase: 'phase3' },
      ],
      links: [{ from: 'Customer', to: 'Payment' }],
    }));
    const anchor = result.chain.components.find(c => c.name === 'Customer')!;
    assert.equal(anchor.visibility, ANCHOR_VISIBILITY);
    assert.equal(anchor.evolution, 0.5);
  });

  it('throws when no anchor is present', () => {
    assert.throws(
      () => computeVisibility(chain({
        components: [
          { name: 'Only', type: 'component', role: 'capability', phase: 'phase3' },
        ],
      })),
      /no anchor component found/,
    );
  });

  it('seeds non-anchor evolution from PHASE_CENTROIDS', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'Customer',  type: 'anchor',    role: 'anchor', phase: 'phase4' },
        { name: 'Genesis',   type: 'component', role: 'need',   phase: 'phase1' },
        { name: 'Custom',    type: 'component', role: 'need',   phase: 'phase2' },
        { name: 'Product',   type: 'component', role: 'need',   phase: 'phase3' },
        { name: 'Commodity', type: 'component', role: 'need',   phase: 'phase4' },
      ],
      links: [
        { from: 'Customer', to: 'Genesis' },
        { from: 'Customer', to: 'Custom' },
        { from: 'Customer', to: 'Product' },
        { from: 'Customer', to: 'Commodity' },
      ],
    }));
    assert.equal(findEvolution(result, 'Genesis'),   PHASE_CENTROIDS.phase1);
    assert.equal(findEvolution(result, 'Custom'),    PHASE_CENTROIDS.phase2);
    assert.equal(findEvolution(result, 'Product'),   PHASE_CENTROIDS.phase3);
    assert.equal(findEvolution(result, 'Commodity'), PHASE_CENTROIDS.phase4);
  });

  it('assigns a placeholder { 0, 0 } label to every component', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'Customer', type: 'anchor',    role: 'anchor', phase: 'phase4' },
        { name: 'Payment',  type: 'component', role: 'need',   phase: 'phase3' },
      ],
      links: [{ from: 'Customer', to: 'Payment' }],
    }));
    for (const c of result.chain.components) {
      assert.deepEqual(c.label, { dx: 0, dy: 0 });
    }
  });
});

function findEvolution(result: ReturnType<typeof computeVisibility>, name: string): number {
  return result.chain.components.find(c => c.name === name)!.evolution;
}

// ─── effective-L floor: L=1 / L=2 stay near the anchor ──────────────────

describe('computeVisibility — effective L floor for short chains', () => {
  it('L=1 keeps the only need above 0.5 (close to anchor)', () => {
    // step uses MIN_EFFECTIVE_L=3 → step ≈ 0.283. Need at depth 1 lands
    // around Y = 0.95 - 0.283 = 0.667 (± jitter). Not at Y_MIN.
    const result = computeVisibility(chain({
      components: [
        { name: 'Customer', type: 'anchor',    role: 'anchor', phase: 'phase4' },
        { name: 'Payment',  type: 'component', role: 'need',   phase: 'phase3' },
      ],
      links: [{ from: 'Customer', to: 'Payment' }],
    }));
    const y = findY(result, 'Payment');
    assert.ok(y > 0.5, `expected Y(Payment) > 0.5 with L=1, got ${y}`);
    assert.ok(y < ANCHOR_VISIBILITY);
  });

  it('L=2 keeps the deepest leaf above 0.35 (not yet at Y_MIN)', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'Customer', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'Payment',  type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'Fraud',    type: 'component', role: 'capability', phase: 'phase2' },
      ],
      links: [
        { from: 'Customer', to: 'Payment' },
        { from: 'Payment',  to: 'Fraud'   },
      ],
    }));
    const yLeaf = findY(result, 'Fraud');
    assert.ok(yLeaf > 0.35, `expected Y(Fraud) > 0.35 with L=2, got ${yLeaf}`);
    assertEdgeDirection(result);
  });
});

// ─── L=3: leaf reaches Y_MIN (within band_half) ─────────────────────────

describe('computeVisibility — full-range usage from L=3', () => {
  it('L=3 places the leaf of the longest chain near Y_MIN', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'A', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'B', type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'C', type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'D', type: 'component', role: 'capability', phase: 'phase1' },
      ],
      links: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'D' },
      ],
    }));
    const yLeaf = findY(result, 'D');
    // step = 0.85/3 ≈ 0.283. Y_nominal(D) = 0.10. With ratio=1, offset = +band_half,
    // but clamp keeps it in [Y_MIN, ANCHOR_VISIBILITY]. Y(D) ∈ [0.10, 0.10 + BAND_MAX].
    assert.ok(yLeaf >= Y_MIN);
    assert.ok(yLeaf <= Y_MIN + BAND_MAX + 1e-9, `expected Y(D) ≤ ${Y_MIN + BAND_MAX}, got ${yLeaf}`);
    assertEdgeDirection(result);
  });

  it('long chain (L=10) uses the full vertical range', () => {
    const components = [
      { name: 'R',  type: 'anchor' as const,    role: 'anchor' as const,     phase: 'phase4' as const },
    ];
    for (let i = 1; i <= 10; i++) {
      components.push({
        name: `N${i}`, type: 'component' as const, role: 'capability' as const, phase: 'phase3' as const,
      });
    }
    const links = [
      { from: 'R', to: 'N1' },
    ];
    for (let i = 1; i < 10; i++) links.push({ from: `N${i}`, to: `N${i + 1}` });

    const result = computeVisibility(chain({ components, links }));
    const yFirst = findY(result, 'N1');
    const yLast  = findY(result, 'N10');
    assert.ok(yFirst > 0.80, `N1 should sit close to anchor, got Y=${yFirst}`);
    assert.ok(yLast  < 0.20, `N10 should sit close to Y_MIN, got Y=${yLast}`);
    assertEdgeDirection(result);
  });
});

// ─── Multi-anchor: example from the design doc ──────────────────────────

describe('computeVisibility — multi-anchor placement', () => {
  it('places R2 between Y(D) and Y(E) in the converging-chains example', () => {
    // R1 → A → B → C → D → E → F → G → H → I  (depth 1..9)
    // R2 → E → J → K                          (J at depth 6, K at depth 7)
    const result = computeVisibility(chain({
      components: [
        { name: 'R1', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'R2', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'A',  type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'B',  type: 'component', role: 'capability', phase: 'phase3' },
        { name: 'C',  type: 'component', role: 'capability', phase: 'phase3' },
        { name: 'D',  type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'E',  type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'F',  type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'G',  type: 'component', role: 'capability', phase: 'phase1' },
        { name: 'H',  type: 'component', role: 'capability', phase: 'phase1' },
        { name: 'I',  type: 'component', role: 'capability', phase: 'phase1' },
        { name: 'J',  type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'K',  type: 'component', role: 'capability', phase: 'phase1' },
      ],
      links: [
        { from: 'R1', to: 'A' },
        { from: 'A',  to: 'B' },
        { from: 'B',  to: 'C' },
        { from: 'C',  to: 'D' },
        { from: 'D',  to: 'E' },
        { from: 'E',  to: 'F' },
        { from: 'F',  to: 'G' },
        { from: 'G',  to: 'H' },
        { from: 'H',  to: 'I' },
        { from: 'R2', to: 'E' },
        { from: 'E',  to: 'J' },
        { from: 'J',  to: 'K' },
      ],
    }));

    // Primary anchor stays at the top.
    assert.equal(findY(result, 'R1'), ANCHOR_VISIBILITY);

    // Secondary anchor sits below D and above E.
    const yD  = findY(result, 'D');
    const yE  = findY(result, 'E');
    const yR2 = findY(result, 'R2');
    assert.ok(yR2 < yD,  `Y(R2)=${yR2} must be < Y(D)=${yD}`);
    assert.ok(yR2 > yE,  `Y(R2)=${yR2} must be > Y(E)=${yE}`);

    // Strict edge direction holds globally.
    assertEdgeDirection(result);
  });

  it('parallel anchors (same converged child at depth 1) both stay at the top', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'R1',     type: 'anchor',    role: 'anchor', phase: 'phase4' },
        { name: 'R2',     type: 'anchor',    role: 'anchor', phase: 'phase4' },
        { name: 'Shared', type: 'component', role: 'need',   phase: 'phase3' },
      ],
      links: [
        { from: 'R1', to: 'Shared' },
        { from: 'R2', to: 'Shared' },
      ],
    }));
    assert.equal(findY(result, 'R1'), ANCHOR_VISIBILITY);
    assert.equal(findY(result, 'R2'), ANCHOR_VISIBILITY);
    assertEdgeDirection(result);
  });

  it('childless anchor remains at ANCHOR_VISIBILITY', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'R',     type: 'anchor',    role: 'anchor', phase: 'phase4' },
        { name: 'Lone',  type: 'anchor',    role: 'anchor', phase: 'phase4' },
        { name: 'Need',  type: 'component', role: 'need',   phase: 'phase3' },
      ],
      links: [{ from: 'R', to: 'Need' }],
    }));
    assert.equal(findY(result, 'Lone'), ANCHOR_VISIBILITY);
  });
});

// ─── Strict edge direction on common shapes ─────────────────────────────

describe('computeVisibility — strict edge direction', () => {
  it('linear chain', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'A', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'B', type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'C', type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'D', type: 'component', role: 'capability', phase: 'phase1' },
      ],
      links: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'D' },
      ],
    }));
    assertEdgeDirection(result);
  });

  it('diamond — two parents converge on one child', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'Anchor', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'Left',   type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'Right',  type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'Joint',  type: 'component', role: 'capability', phase: 'phase2' },
      ],
      links: [
        { from: 'Anchor', to: 'Left' },
        { from: 'Anchor', to: 'Right' },
        { from: 'Left',   to: 'Joint' },
        { from: 'Right',  to: 'Joint' },
      ],
    }));
    assertEdgeDirection(result);
  });

  it('shortcut — direct edge bypasses an intermediate node', () => {
    // Anchor → A → B AND Anchor → B (shortcut). Longest-path depth keeps
    // B strictly below A (depth(B) = 2 via A, beats the shortcut's 1).
    const result = computeVisibility(chain({
      components: [
        { name: 'Anchor', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'A',      type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'B',      type: 'component', role: 'capability', phase: 'phase2' },
      ],
      links: [
        { from: 'Anchor', to: 'A' },
        { from: 'A',      to: 'B' },
        { from: 'Anchor', to: 'B' },
      ],
    }));
    assertEdgeDirection(result);
    const y = (n: string) => findY(result, n);
    assert.ok(y('A') - y('B') >= EDGE_MIN_GAP - 1e-9,
      `expected Y(A)−Y(B) ≥ ${EDGE_MIN_GAP}, got ${(y('A') - y('B')).toFixed(4)}`);
  });

  it('mixed depths — short branch and long branch coexist', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'Anchor', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'S',      type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'L1',     type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'L2',     type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'L3',     type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'L4',     type: 'component', role: 'capability', phase: 'phase1' },
      ],
      links: [
        { from: 'Anchor', to: 'S' },
        { from: 'Anchor', to: 'L1' },
        { from: 'L1',     to: 'L2' },
        { from: 'L2',     to: 'L3' },
        { from: 'L3',     to: 'L4' },
      ],
    }));
    assertEdgeDirection(result);
  });
});

// ─── Semantic jitter ────────────────────────────────────────────────────

describe('computeVisibility — semantic jitter', () => {
  it('component on the longest chain is biased upward (+band_half)', () => {
    // Single linear chain of length 5 — every node's chain_through equals
    // L, so every offset is +band_half.
    const result = computeVisibility(chain({
      components: [
        { name: 'A', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'B', type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'C', type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'D', type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'E', type: 'component', role: 'capability', phase: 'phase1' },
        { name: 'F', type: 'component', role: 'capability', phase: 'phase1' },
      ],
      links: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'D' },
        { from: 'D', to: 'E' },
        { from: 'E', to: 'F' },
      ],
    }));
    // L=5, step=0.17. Y_nominal(B)=0.78. With +band_half (0.05):
    // Y(B) ≈ 0.83. We assert above-nominal as a lower bound.
    const yB = findY(result, 'B');
    const stepValue = (ANCHOR_VISIBILITY - Y_MIN) / 5;
    const yNominalB = ANCHOR_VISIBILITY - stepValue;
    assert.ok(yB > yNominalB - 1e-9,
      `B on the longest chain should sit at or above its nominal Y (${yNominalB}), got ${yB}`);
  });

  it('leaf of a short side branch is biased downward (−band_half)', () => {
    // Anchor → S (short, leaf at depth 1) AND Anchor → L1 → L2 → L3 → L4
    // (long, L=4). L=4. S has chain_through = 1. Long-chain nodes have
    // chain_through = 4. ratio(S)=0.25 → offset(S) < 0.
    const result = computeVisibility(chain({
      components: [
        { name: 'Anchor', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'S',      type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'L1',     type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'L2',     type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'L3',     type: 'component', role: 'capability', phase: 'phase2' },
        { name: 'L4',     type: 'component', role: 'capability', phase: 'phase1' },
      ],
      links: [
        { from: 'Anchor', to: 'S' },
        { from: 'Anchor', to: 'L1' },
        { from: 'L1',     to: 'L2' },
        { from: 'L2',     to: 'L3' },
        { from: 'L3',     to: 'L4' },
      ],
    }));
    const stepValue = (ANCHOR_VISIBILITY - Y_MIN) / 4; // L=4
    const yNominalShort = ANCHOR_VISIBILITY - 1 * stepValue;
    const yNominalLong  = ANCHOR_VISIBILITY - 1 * stepValue;
    const yS  = findY(result, 'S');
    const yL1 = findY(result, 'L1');
    assert.ok(yS  < yNominalShort + 1e-9,
      `S on a short branch should sit at or below its nominal Y (${yNominalShort}), got ${yS}`);
    assert.ok(yL1 > yNominalLong  - 1e-9,
      `L1 on the longest chain should sit at or above its nominal Y (${yNominalLong}), got ${yL1}`);
  });
});

// ─── Orphans ────────────────────────────────────────────────────────────

describe('computeVisibility — orphans', () => {
  it('orphan components land at ORPHAN_FALLBACK_Y', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'Customer', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'Need',     type: 'component', role: 'need',       phase: 'phase3' },
        { name: 'Orphan',   type: 'component', role: 'capability', phase: 'phase1' },
      ],
      links: [
        { from: 'Customer', to: 'Need' },
      ],
    }));
    assert.equal(findY(result, 'Orphan'), ORPHAN_FALLBACK_Y);
    // Orphan keeps its phase-derived evolution.
    assert.equal(findEvolution(result, 'Orphan'), PHASE_CENTROIDS.phase1);
  });
});

// ─── Map sizing ─────────────────────────────────────────────────────────

describe('computeMapSize', () => {
  it('keeps the base size for L ≤ DENSITY_LIMIT_L', () => {
    assert.deepEqual(computeMapSize(0),  { width: BASE_CANVAS_WIDTH, height: BASE_CANVAS_HEIGHT });
    assert.deepEqual(computeMapSize(1),  { width: BASE_CANVAS_WIDTH, height: BASE_CANVAS_HEIGHT });
    assert.deepEqual(computeMapSize(MIN_EFFECTIVE_L), { width: BASE_CANVAS_WIDTH, height: BASE_CANVAS_HEIGHT });
    assert.deepEqual(computeMapSize(24), { width: BASE_CANVAS_WIDTH, height: BASE_CANVAS_HEIGHT });
  });

  it('scales the height proportionally for L > DENSITY_LIMIT_L', () => {
    // L=25 → 650*25/25 = 650 (no scaling at the boundary).
    assert.deepEqual(computeMapSize(25), { width: BASE_CANVAS_WIDTH, height: 650 });
    // L=26 → ceil(650*26/25) = 676.
    assert.deepEqual(computeMapSize(26), { width: BASE_CANVAS_WIDTH, height: 676 });
    // L=50 → ceil(650*50/25) = 1300.
    assert.deepEqual(computeMapSize(50), { width: BASE_CANVAS_WIDTH, height: 1300 });
  });

  it('exposes mapSize on the computeVisibility result', () => {
    const result = computeVisibility(chain({
      components: [
        { name: 'A', type: 'anchor',    role: 'anchor',     phase: 'phase4' },
        { name: 'B', type: 'component', role: 'need',       phase: 'phase3' },
      ],
      links: [{ from: 'A', to: 'B' }],
    }));
    assert.deepEqual(result.mapSize, { width: BASE_CANVAS_WIDTH, height: BASE_CANVAS_HEIGHT });
  });
});

// ─── Constants sanity ───────────────────────────────────────────────────

describe('computeVisibility — constants sanity', () => {
  it('SECONDARY_ANCHOR_OFFSET stays within (0, 1) so secondary anchors land between two integer levels', () => {
    assert.ok(SECONDARY_ANCHOR_OFFSET > 0 && SECONDARY_ANCHOR_OFFSET < 1);
  });
});
