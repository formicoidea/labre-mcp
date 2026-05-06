// Tests for force-directed.mts — Phase 6b label simulation.
//
// All tests are pure JS — no cli-owm calls. The simulation operates
// on `PositionedValueChain` directly via `computeGeometry`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateLabels,
  SIM_LABEL_ITERATIONS,
  KINETIC_ENERGY_THRESHOLD,
} from './force-directed.mjs';
import type {
  PositionedValueChain,
  PositionedComponent,
} from '../../../types/value-chain.mjs';

interface Seed {
  name: string;
  role: 'anchor' | 'need' | 'capability';
  evolution: number;
  visibility: number;
  dx?: number;
  dy?: number;
}

function chain(seeds: Seed[], links: Array<{ from: string; to: string }> = []): PositionedValueChain {
  return {
    metadata: {
      title: 't', angle: '', scope: '', objective: '',
      imperatives: [], temporality: 'present', contextSummary: '',
    },
    components: seeds.map<PositionedComponent>(s => ({
      name: s.name,
      type: s.role === 'anchor' ? 'anchor' : 'component',
      role: s.role,
      phase: 'phase3',
      evolution: s.evolution,
      visibility: s.visibility,
      label: { dx: s.dx ?? 0, dy: s.dy ?? 25 },
    })),
    links,
  };
}

function findLabel(c: PositionedValueChain, name: string): { dx: number; dy: number } {
  const comp = c.components.find(c => c.name === name);
  if (!comp) throw new Error(`component ${name} not found`);
  return comp.label;
}

const emitOpts = { style: 'plain' as const };

describe('simulateLabels — separation', () => {
  it('separates two labels that start at the exact same position', () => {
    // Two components at almost-identical positions, both with dy=+25.
    // Their starting label positions coincide → strong repulsion
    // should push them apart.
    const c = chain([
      { name: 'A', role: 'capability', evolution: 0.5, visibility: 0.5, dx: 0, dy: 25 },
      { name: 'B', role: 'capability', evolution: 0.5, visibility: 0.5, dx: 0, dy: 25 },
    ]);
    const out = simulateLabels(c, emitOpts);
    const labelA = findLabel(out.chain, 'A');
    const labelB = findLabel(out.chain, 'B');
    // After simulation the labels should NOT both still be at (0, 25).
    const moved = labelA.dx !== 0 || labelA.dy !== 25
               || labelB.dx !== 0 || labelB.dy !== 25;
    assert.ok(moved, 'expected at least one of the labels to have moved');
    assert.ok(out.modified.length >= 1, 'expected modified list to include ≥ 1 label');
  });
});

describe('simulateLabels — home attraction', () => {
  it('leaves a single isolated label at its home position', () => {
    // A single particle inside the canvas, no other forces. The seed
    // offset IS the home (the spring rest point), so the label
    // shouldn't drift.
    const c = chain([
      { name: 'Solo', role: 'capability', evolution: 0.5, visibility: 0.5, dx: 50, dy: 25 },
    ]);
    const out = simulateLabels(c, emitOpts);
    const lbl = findLabel(out.chain, 'Solo');
    assert.equal(lbl.dx, 50);
    assert.equal(lbl.dy, 25);
  });

  it('after a perturbing neighbour is added, the label drifts but stays near home', () => {
    // Two labels start coincident at (0, 25). After simulation the
    // home attraction limits how far each can drift from the seed.
    const c = chain([
      { name: 'A', role: 'capability', evolution: 0.5, visibility: 0.5, dx: 0, dy: 25 },
      { name: 'B', role: 'capability', evolution: 0.5, visibility: 0.5, dx: 0, dy: 25 },
    ]);
    const out = simulateLabels(c, emitOpts);
    const labelA = findLabel(out.chain, 'A');
    const labelB = findLabel(out.chain, 'B');
    // Neither should have drifted by more than ~200 px from home;
    // home attraction caps the free flight even under strong repulsion.
    assert.ok(Math.abs(labelA.dx) <= 200, `A.dx drifted too far: ${labelA.dx}`);
    assert.ok(Math.abs(labelA.dy - 25) <= 200, `A.dy drifted too far: ${labelA.dy}`);
    assert.ok(Math.abs(labelB.dx) <= 200, `B.dx drifted too far: ${labelB.dx}`);
    assert.ok(Math.abs(labelB.dy - 25) <= 200, `B.dy drifted too far: ${labelB.dy}`);
  });
});

describe('simulateLabels — stability under pathological input', () => {
  it('does not diverge when initialised far outside the canvas', () => {
    // Pathological input: label at (10000, 10000). The velocity cap +
    // damping should keep the system bounded.
    const c = chain([
      { name: 'X', role: 'capability', evolution: 0.5, visibility: 0.5, dx: 10000, dy: 10000 },
    ]);
    const out = simulateLabels(c, emitOpts);
    const lbl = findLabel(out.chain, 'X');
    // Position must remain finite (not NaN, not Infinity).
    assert.ok(Number.isFinite(lbl.dx), `dx is not finite: ${lbl.dx}`);
    assert.ok(Number.isFinite(lbl.dy), `dy is not finite: ${lbl.dy}`);
  });
});

describe('simulateLabels — convergence', () => {
  it('terminates within SIM_LABEL_ITERATIONS', () => {
    const c = chain([
      { name: 'A', role: 'capability', evolution: 0.4, visibility: 0.5, dx: 0, dy: 25 },
      { name: 'B', role: 'capability', evolution: 0.5, visibility: 0.5, dx: 0, dy: 25 },
      { name: 'C', role: 'capability', evolution: 0.6, visibility: 0.5, dx: 0, dy: 25 },
    ]);
    const out = simulateLabels(c, emitOpts);
    assert.ok(out.iterations <= SIM_LABEL_ITERATIONS,
      `expected ≤ ${SIM_LABEL_ITERATIONS} iterations, got ${out.iterations}`);
    assert.ok(typeof out.finalKineticEnergy === 'number');
  });

  it('stops early when the system reaches equilibrium', () => {
    // A well-spread chain: labels are far apart from the start, so KE
    // should drop below threshold quickly.
    const c = chain([
      { name: 'A', role: 'capability', evolution: 0.2, visibility: 0.8, dx: 0, dy: 25 },
      { name: 'B', role: 'capability', evolution: 0.8, visibility: 0.2, dx: 0, dy: 25 },
    ]);
    const out = simulateLabels(c, emitOpts);
    assert.ok(out.iterations < SIM_LABEL_ITERATIONS,
      `should terminate before the cap, got ${out.iterations}`);
  });
});

describe('simulateLabels — anchor immobility', () => {
  it('does not move anchor components', () => {
    // Anchors are not particles; their (X, Y) positions and labels
    // remain unchanged after simulation.
    const c = chain([
      { name: 'A', role: 'anchor',     evolution: 0.95, visibility: 0.95, dx: -100, dy: 0 },
      { name: 'B', role: 'capability', evolution: 0.5,  visibility: 0.5,  dx: 0,    dy: 25 },
    ]);
    const out = simulateLabels(c, emitOpts);
    const a = out.chain.components.find(x => x.name === 'A')!;
    assert.equal(a.label.dx, -100);
    assert.equal(a.label.dy, 0);
    assert.ok(!out.modified.includes('A'),
      'anchor should never appear in modified list');
  });
});

describe('simulateLabels — boundary respect', () => {
  it('pulls a label inside the canvas when it overflows the right edge', () => {
    // Component at evolution=0.95 with dx=+200 places the label well
    // beyond the right side of the visible map (mapWidth=500 by default).
    // The boundary force should pull it back.
    const c = chain([
      { name: 'X', role: 'capability', evolution: 0.95, visibility: 0.5, dx: 200, dy: 0 },
    ]);
    const out = simulateLabels(c, emitOpts);
    const lbl = findLabel(out.chain, 'X');
    // The boundary force pushes inward (dx becomes smaller).
    assert.ok(lbl.dx < 200, `expected dx pulled back, got ${lbl.dx}`);
  });
});

describe('simulateLabels — preserved invariants', () => {
  it('does not mutate the input chain', () => {
    const c = chain([
      { name: 'A', role: 'capability', evolution: 0.5, visibility: 0.5, dx: 0, dy: 25 },
      { name: 'B', role: 'capability', evolution: 0.5, visibility: 0.5, dx: 0, dy: 25 },
    ]);
    const beforeA = c.components[0].label;
    simulateLabels(c, emitOpts);
    const afterA = c.components[0].label;
    // Reference equality: simulator returned a new chain, didn't mutate.
    assert.equal(beforeA, afterA);
  });

  it('outputs integer label offsets only', () => {
    const c = chain([
      { name: 'A', role: 'capability', evolution: 0.5, visibility: 0.5 },
      { name: 'B', role: 'capability', evolution: 0.5, visibility: 0.5 },
    ]);
    const out = simulateLabels(c, emitOpts);
    for (const comp of out.chain.components) {
      assert.equal(comp.label.dx, Math.round(comp.label.dx),
        `${comp.name} dx not an integer: ${comp.label.dx}`);
      assert.equal(comp.label.dy, Math.round(comp.label.dy),
        `${comp.name} dy not an integer: ${comp.label.dy}`);
    }
  });
});

describe('simulateLabels — constants sanity', () => {
  it('exposes a positive iteration cap and threshold', () => {
    assert.ok(SIM_LABEL_ITERATIONS > 0);
    assert.ok(KINETIC_ENERGY_THRESHOLD > 0);
  });
});
