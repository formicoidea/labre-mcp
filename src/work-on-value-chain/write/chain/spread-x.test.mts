// Tests for spread-x.mts
//
// Validates:
//   - anchor stays pinned at 0.5
//   - peers within a level are spread across [LEFT_BOUND, RIGHT_BOUND]
//   - first peer of a multi-peer level lands on LEFT_BOUND, last on RIGHT_BOUND
//   - single peer of a level sits on ANCHOR_X
//   - peer order follows median parent X (Sugiyama barycenter)
//   - phase / seed evolution from the LLM is overwritten

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  spreadXForReadability,
  ANCHOR_X,
  LEFT_BOUND,
  RIGHT_BOUND,
} from './spread-x.mjs';
import type { PositionedValueChain } from '../../../types/value-chain.mjs';

function seed(components: Array<{
  name: string; role: 'anchor' | 'need' | 'capability'; visibility: number; evolution?: number;
}>, links: Array<{ from: string; to: string }>): PositionedValueChain {
  return {
    metadata: {
      title: 't', angle: '', scope: '', objective: '', imperatives: [],
      temporality: 'present', contextSummary: '',
    },
    components: components.map(c => ({
      name: c.name,
      type: c.role === 'anchor' ? 'anchor' : 'component',
      role: c.role,
      phase: 'phase3',
      visibility: c.visibility,
      evolution: c.evolution ?? 0.5,
      label: { dx: 0, dy: 0 },
    })),
    links,
  };
}

describe('spreadXForReadability', () => {
  it('keeps the anchor pinned at ANCHOR_X', () => {
    const out = spreadXForReadability(seed(
      [
        { name: 'A', role: 'anchor', visibility: 0.95 },
        { name: 'B', role: 'need',   visibility: 0.65 },
        { name: 'C', role: 'need',   visibility: 0.65 },
      ],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
      ],
    ));
    const anchor = out.components.find(c => c.name === 'A')!;
    assert.equal(anchor.evolution, ANCHOR_X);
  });

  it('spreads two peers to the bounds of the canvas', () => {
    const out = spreadXForReadability(seed(
      [
        { name: 'A', role: 'anchor', visibility: 0.95 },
        { name: 'B', role: 'need',   visibility: 0.65 },
        { name: 'C', role: 'need',   visibility: 0.65 },
      ],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
      ],
    ));
    const xs = out.components
      .filter(c => c.name !== 'A')
      .map(c => c.evolution)
      .sort((a, b) => a - b);
    assert.equal(xs[0], LEFT_BOUND);
    assert.equal(xs[1], RIGHT_BOUND);
  });

  it('spreads four peers evenly across the canvas', () => {
    const out = spreadXForReadability(seed(
      [
        { name: 'A', role: 'anchor', visibility: 0.95 },
        { name: 'B', role: 'need',   visibility: 0.65 },
        { name: 'C', role: 'need',   visibility: 0.65 },
        { name: 'D', role: 'need',   visibility: 0.65 },
        { name: 'E', role: 'need',   visibility: 0.65 },
      ],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'A', to: 'D' },
        { from: 'A', to: 'E' },
      ],
    ));
    const xs = out.components
      .filter(c => c.name !== 'A')
      .map(c => c.evolution)
      .sort((a, b) => a - b);
    const span = RIGHT_BOUND - LEFT_BOUND;
    assert.ok(Math.abs(xs[0] - LEFT_BOUND) < 1e-6);
    assert.ok(Math.abs(xs[1] - (LEFT_BOUND + span / 3)) < 1e-6);
    assert.ok(Math.abs(xs[2] - (LEFT_BOUND + 2 * span / 3)) < 1e-6);
    assert.ok(Math.abs(xs[3] - RIGHT_BOUND) < 1e-6);
  });

  it('places a single peer in a level at ANCHOR_X', () => {
    const out = spreadXForReadability(seed(
      [
        { name: 'A',     role: 'anchor', visibility: 0.95 },
        { name: 'Lone',  role: 'need',   visibility: 0.65 },
      ],
      [
        { from: 'A', to: 'Lone' },
      ],
    ));
    const lone = out.components.find(c => c.name === 'Lone')!;
    assert.equal(lone.evolution, ANCHOR_X);
  });

  it('orders children under their parents (median parent X tie-break)', () => {
    // Two parents at level 0.65 placed left/right. Their children in level
    // 0.35 should inherit the left-right order so links don't cross.
    const out = spreadXForReadability(seed(
      [
        { name: 'A',     role: 'anchor',     visibility: 0.95 },
        { name: 'Left',  role: 'need',       visibility: 0.65 },
        { name: 'Right', role: 'need',       visibility: 0.65 },
        { name: 'LX',    role: 'capability', visibility: 0.35 },
        { name: 'RX',    role: 'capability', visibility: 0.35 },
      ],
      [
        { from: 'A',     to: 'Left' },
        { from: 'A',     to: 'Right' },
        { from: 'Left',  to: 'LX' },
        { from: 'Right', to: 'RX' },
      ],
    ));
    const lx = out.components.find(c => c.name === 'LX')!;
    const rx = out.components.find(c => c.name === 'RX')!;
    // Children inherit left/right order from their parents.
    assert.ok(lx.evolution < rx.evolution,
      `expected LX (${lx.evolution}) < RX (${rx.evolution})`);
  });

  it('recenters a parent on its >= 2 children (bottom-up barycenter)', () => {
    // P has 3 children spread across the canvas. After bottom-up pass, P
    // should sit at roughly their mean, not at its initial spread X.
    const out = spreadXForReadability(seed(
      [
        { name: 'A',  role: 'anchor',     visibility: 0.95 },
        { name: 'P',  role: 'need',       visibility: 0.65 },
        { name: 'X1', role: 'capability', visibility: 0.35 },
        { name: 'X2', role: 'capability', visibility: 0.35 },
        { name: 'X3', role: 'capability', visibility: 0.35 },
      ],
      [
        { from: 'A',  to: 'P' },
        { from: 'P',  to: 'X1' },
        { from: 'P',  to: 'X2' },
        { from: 'P',  to: 'X3' },
      ],
    ));
    const p = out.components.find(c => c.name === 'P')!;
    const xs = ['X1', 'X2', 'X3'].map(n => out.components.find(c => c.name === n)!.evolution);
    const expectedMean = (xs[0] + xs[1] + xs[2]) / 3;
    assert.ok(Math.abs(p.evolution - expectedMean) < 1e-6,
      `expected P (${p.evolution}) close to mean(children)=${expectedMean}`);
  });

  it('overwrites the LLM-seeded phase evolution', () => {
    const out = spreadXForReadability(seed(
      [
        { name: 'A', role: 'anchor', visibility: 0.95, evolution: 0.5 },
        { name: 'B', role: 'need',   visibility: 0.65, evolution: 0.09 /* phase1 seed */ },
        { name: 'C', role: 'need',   visibility: 0.65, evolution: 0.85 /* phase4 seed */ },
      ],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
      ],
    ));
    const b = out.components.find(c => c.name === 'B')!;
    const c = out.components.find(c => c.name === 'C')!;
    // Both should land on the level bounds (phase seed ignored).
    const xs = [b.evolution, c.evolution].sort((a, z) => a - z);
    assert.equal(xs[0], LEFT_BOUND);
    assert.equal(xs[1], RIGHT_BOUND);
  });
});