// Tests for adjust-x.mts
//
// Validates the four deterministic invariants:
//   (a) preservation of LLM intent: final X âˆˆ [xHint âˆ’ BAND_HALF, xHint + BAND_HALF]
//       (or in the global bounds if anti-collision overrides)
//   (b) clamp to [LEFT_BOUND, RIGHT_BOUND]
//   (c) anti-collision: no two same-Y components within MIN_GAP_X
//   (d) supplier alignment: a supplier with â‰¥ 2 consumers sits at the
//       (band-clamped) mean of their X
//   (e) multi-anchor: two anchors with the same xHint at the same Y end
//       up at least MIN_GAP_X apart
//   (f) mapWidth scales with the densest Â±DENSITY_WINDOW_HALF window
//   (g) fallback: a component with no xHint receives a fallback X within
//       its Y-level uniform spread
//   (h) constants sanity

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustX,
  LEFT_BOUND,
  RIGHT_BOUND,
  BAND_HALF,
  MIN_GAP_X,
  DENSITY_LIMIT_K,
  DENSITY_REFERENCE_K,
  BASE_CANVAS_WIDTH,
} from './adjust-x.mjs';
import type {
  PositionedValueChain,
  PositionedComponent,
} from '../../../../../types/value-chain.mjs';

interface Seed {
  name: string;
  role: 'anchor' | 'need' | 'capability';
  visibility: number;
  xHint?: number;
}

function seed(
  components: Seed[],
  links: Array<{ from: string; to: string }>,
): PositionedValueChain {
  return {
    metadata: {
      title: 't', angle: '', scope: '', objective: '',
      imperatives: [], temporality: 'present', contextSummary: '',
    },
    components: components.map<PositionedComponent>(c => ({
      name: c.name,
      type: c.role === 'anchor' ? 'anchor' : 'component',
      role: c.role,
      
      xHint: c.xHint,
      visibility: c.visibility,
      evolution: 0,
      label: { dx: 0, dy: 0 },
    })),
    links,
  };
}

function xByName(chain: PositionedValueChain): Map<string, number> {
  return new Map(chain.components.map(c => [c.name, c.evolution]));
}

describe('adjustX â€” clamp & preservation (a, b)', () => {
  it('keeps every X within [LEFT_BOUND, RIGHT_BOUND]', () => {
    const out = adjustX(seed(
      [
        { name: 'A', role: 'anchor',     visibility: 0.95, xHint: 0.05 }, // below LEFT_BOUND
        { name: 'B', role: 'need',       visibility: 0.65, xHint: 0.99 }, // above RIGHT_BOUND
        { name: 'C', role: 'capability', visibility: 0.30, xHint: 0.50 },
      ],
      [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
    ));
    for (const c of out.chain.components) {
      assert.ok(c.evolution >= LEFT_BOUND, `${c.name} below LEFT_BOUND`);
      assert.ok(c.evolution <= RIGHT_BOUND, `${c.name} above RIGHT_BOUND`);
    }
  });

  it('keeps single-consumer components within Â±BAND_HALF of their xHint', () => {
    const out = adjustX(seed(
      [
        { name: 'A', role: 'anchor', visibility: 0.95, xHint: 0.50 },
        { name: 'B', role: 'need',   visibility: 0.65, xHint: 0.30 },
        { name: 'C', role: 'need',   visibility: 0.65, xHint: 0.75 },
      ],
      [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }],
    ));
    const x = xByName(out.chain);
    assert.ok(Math.abs(x.get('A')! - 0.50) <= BAND_HALF + 1e-9);
    assert.ok(Math.abs(x.get('B')! - 0.30) <= BAND_HALF + 1e-9);
    assert.ok(Math.abs(x.get('C')! - 0.75) <= BAND_HALF + 1e-9);
  });
});

describe('adjustX â€” anti-collision (c, e)', () => {
  it('separates two same-Y components with identical xHint by â‰¥ MIN_GAP_X', () => {
    const out = adjustX(seed(
      [
        { name: 'A', role: 'anchor', visibility: 0.95, xHint: 0.50 },
        { name: 'B', role: 'need',   visibility: 0.65, xHint: 0.45 },
        { name: 'C', role: 'need',   visibility: 0.65, xHint: 0.45 },
      ],
      [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }],
    ));
    const x = xByName(out.chain);
    assert.ok(Math.abs(x.get('B')! - x.get('C')!) >= MIN_GAP_X - 1e-9);
  });

  it('separates two anchors at the same Y when xHint coincides', () => {
    const out = adjustX(seed(
      [
        { name: 'R1', role: 'anchor', visibility: 0.95, xHint: 0.45 },
        { name: 'R2', role: 'anchor', visibility: 0.95, xHint: 0.45 },
      ],
      [],
    ));
    const x = xByName(out.chain);
    assert.ok(Math.abs(x.get('R1')! - x.get('R2')!) >= MIN_GAP_X - 1e-9);
  });

  it('produces no same-Y collision across a denser sample', () => {
    const peers: Seed[] = Array.from({ length: 6 }, (_, i) => ({
      name: `P${i}`,
      role: 'capability' as const,
      visibility: 0.50,
      xHint: 0.30 + i * 0.005, // bunched, all within MIN_GAP_X of each other
    }));
    const out = adjustX(seed(
      [{ name: 'A', role: 'anchor', visibility: 0.95, xHint: 0.50 }, ...peers],
      peers.map(p => ({ from: 'A', to: p.name })),
    ));
    const x = xByName(out.chain);
    const sorted = peers
      .map(p => x.get(p.name)!)
      .sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(
        sorted[i] - sorted[i - 1] >= MIN_GAP_X - 1e-9,
        `collision between rank ${i - 1} and ${i}: ${sorted[i - 1]} vs ${sorted[i]}`,
      );
    }
  });
});

describe('adjustX â€” supplier alignment (d)', () => {
  it('aligns a supplier with â‰¥ 2 consumers on the consumer X mean', () => {
    // S has two consumers at xHint 0.20 and 0.80. S's hint is 0.50; mean is 0.50.
    const out = adjustX(seed(
      [
        { name: 'A',  role: 'anchor',     visibility: 0.95, xHint: 0.50 },
        { name: 'B',  role: 'need',       visibility: 0.65, xHint: 0.20 },
        { name: 'C',  role: 'need',       visibility: 0.65, xHint: 0.80 },
        { name: 'S',  role: 'capability', visibility: 0.30, xHint: 0.50 },
      ],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'B', to: 'S' },
        { from: 'C', to: 'S' },
      ],
    ));
    const x = xByName(out.chain);
    // Mean(B, C) = (0.20 + 0.80) / 2 = 0.50, equal to S.xHint â†’ S stays at 0.50.
    assert.ok(Math.abs(x.get('S')! - 0.50) < 1e-9);
  });

  it('caps supplier alignment to the band when consumer mean is outside', () => {
    // S's hint is 0.30. Consumer mean is 0.70 â†’ outside [0.20, 0.40].
    // S should stop at 0.40 (band edge).
    const out = adjustX(seed(
      [
        { name: 'A', role: 'anchor',     visibility: 0.95, xHint: 0.50 },
        { name: 'B', role: 'need',       visibility: 0.65, xHint: 0.60 },
        { name: 'C', role: 'need',       visibility: 0.65, xHint: 0.80 },
        { name: 'S', role: 'capability', visibility: 0.30, xHint: 0.30 },
      ],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'B', to: 'S' },
        { from: 'C', to: 'S' },
      ],
    ));
    const x = xByName(out.chain);
    // 0.30 + BAND_HALF (0.10) = 0.40 â€” band edge.
    assert.ok(Math.abs(x.get('S')! - (0.30 + BAND_HALF)) < 1e-9);
  });

  it('leaves single-consumer suppliers at xHint', () => {
    const out = adjustX(seed(
      [
        { name: 'A', role: 'anchor',     visibility: 0.95, xHint: 0.50 },
        { name: 'B', role: 'need',       visibility: 0.65, xHint: 0.30 },
        { name: 'C', role: 'capability', visibility: 0.30, xHint: 0.70 },
      ],
      [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
    ));
    const x = xByName(out.chain);
    assert.ok(Math.abs(x.get('C')! - 0.70) < 1e-9);
  });
});

describe('adjustX â€” fallback for missing xHint (g)', () => {
  it('spreads no-hint components uniformly within their Y level', () => {
    const out = adjustX(seed(
      [
        { name: 'A', role: 'anchor', visibility: 0.95, xHint: 0.50 },
        { name: 'B', role: 'need',   visibility: 0.65 }, // no hint
        { name: 'C', role: 'need',   visibility: 0.65 }, // no hint
        { name: 'D', role: 'need',   visibility: 0.65 }, // no hint
      ],
      [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }, { from: 'A', to: 'D' }],
    ));
    const x = xByName(out.chain);
    // Three peers spread on [LEFT_BOUND, RIGHT_BOUND]: 0.10, 0.50, 0.90.
    // Order may differ but the three values should be present.
    const xs = ['B', 'C', 'D'].map(n => x.get(n)!).sort((a, b) => a - b);
    assert.ok(Math.abs(xs[0] - LEFT_BOUND) < 1e-9, `lowest=${xs[0]}`);
    assert.ok(Math.abs(xs[2] - RIGHT_BOUND) < 1e-9, `highest=${xs[2]}`);
  });

  it('places a single no-hint component at the centre of [LEFT_BOUND, RIGHT_BOUND]', () => {
    const out = adjustX(seed(
      [
        { name: 'A', role: 'anchor', visibility: 0.95, xHint: 0.50 },
        { name: 'B', role: 'need',   visibility: 0.65 }, // no hint, alone at level
      ],
      [{ from: 'A', to: 'B' }],
    ));
    const x = xByName(out.chain);
    assert.ok(Math.abs(x.get('B')! - (LEFT_BOUND + RIGHT_BOUND) / 2) < 1e-9);
  });
});

describe('adjustX â€” mapWidth (f)', () => {
  function chainWithKHints(K: number): PositionedValueChain {
    // K components inside the same Â±DENSITY_WINDOW_HALF window (here 0.45..0.55).
    const peers: Seed[] = Array.from({ length: K }, (_, i) => ({
      name: `P${i}`,
      role: 'capability' as const,
      visibility: 0.30,
      // Spread tightly inside the 0.10-wide window so K_max = K.
      xHint: 0.45 + (i / Math.max(K - 1, 1)) * 0.10,
    }));
    return seed(
      [{ name: 'A', role: 'anchor', visibility: 0.95, xHint: 0.50 }, ...peers],
      peers.map(p => ({ from: 'A', to: p.name })),
    );
  }

  it('keeps mapWidth at BASE when K_max â‰¤ DENSITY_LIMIT_K', () => {
    // Build a chain whose densest Â±0.05 window holds DENSITY_LIMIT_K
    // components. Use sparse hints so anti-collision doesn't pile peers up.
    const out = adjustX(seed(
      [
        { name: 'A', role: 'anchor',     visibility: 0.95, xHint: 0.50 },
        { name: 'B', role: 'capability', visibility: 0.30, xHint: 0.20 },
        { name: 'C', role: 'capability', visibility: 0.30, xHint: 0.50 },
        { name: 'D', role: 'capability', visibility: 0.30, xHint: 0.80 },
      ],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'A', to: 'D' },
      ],
    ));
    assert.equal(out.mapSize.width, BASE_CANVAS_WIDTH);
  });

  it('scales mapWidth when the densest window saturates', () => {
    // 6 peers crammed inside one window â†’ K_max = 6 > DENSITY_LIMIT_K = 4.
    // After anti-collision the 6 components span ~5 Ã— MIN_GAP_X = 0.10,
    // exactly the window width, so 6 still fit in one window.
    const out = adjustX(chainWithKHints(6));
    const expected = Math.ceil((BASE_CANVAS_WIDTH * 6) / DENSITY_REFERENCE_K);
    assert.equal(out.mapSize.width, expected);
  });
});

describe('adjustX â€” constants sanity (h)', () => {
  it('LEFT_BOUND < RIGHT_BOUND', () => {
    assert.ok(LEFT_BOUND < RIGHT_BOUND);
  });
  it('MIN_GAP_X is small enough to fit â‰¥ 2 in one window', () => {
    assert.ok(MIN_GAP_X * 2 <= 2 * 0.05);
  });
  it('BAND_HALF leaves room for anti-collision', () => {
    assert.ok(BAND_HALF >= MIN_GAP_X);
  });
  it('DENSITY thresholds are coherent', () => {
    assert.ok(DENSITY_REFERENCE_K > DENSITY_LIMIT_K);
  });
});
