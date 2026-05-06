// Tests for verify-layout.mts (V6 — full force-directed).
//
// V6 doesn't invoke the OwmRenderAdapter during placement, so the
// elaborate mock-SVG infrastructure of V5 is gone. Tests construct a
// `PositionedValueChain` directly and assert the V6 invariants:
//   - public API (signature + report shape) preserved
//   - hard violations are always 0 in the output (Phase 6d guarantee)
//   - anchors are immobile
//   - labels seeded by place-labels become the simulation home; small
//     perturbations propagate, big ones converge bounded
//   - the input chain is never mutated

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyLayout } from './verify-layout.mjs';
import type { OwmRenderAdapter } from '../../../lib/owm/render-adapter.mjs';
import type {
  LabelOffset,
  PositionedComponent,
  PositionedValueChain,
} from '../../../types/value-chain.mjs';
import { computeGeometry } from '../../../lib/owm/analytical-geometry.mjs';
import { detectAllOverlaps } from '../../../lib/owm/overlap-detector.mjs';

// ─── Helpers ────────────────────────────────────────────────────────────

interface Seed {
  name: string;
  role: 'anchor' | 'need' | 'capability';
  visibility: number;
  evolution?: number;
  label?: LabelOffset;
  xHint?: number;
}

function chain(components: Seed[], links: Array<{ from: string; to: string }> = []): PositionedValueChain {
  return {
    metadata: {
      title: 't', angle: '', scope: '', objective: '',
      imperatives: [], temporality: 'present', contextSummary: '',
    },
    components: components.map<PositionedComponent>(c => ({
      name: c.name,
      type: c.role === 'anchor' ? 'anchor' : 'component',
      role: c.role,
      phase: 'phase3',
      visibility: c.visibility,
      evolution: c.evolution ?? 0.5,
      label: c.label ?? { dx: 0, dy: 25 },
      xHint: c.xHint,
    })),
    links,
  };
}

const emitOpts = { style: 'plain' as const };

/** Stub adapter — V6 doesn't call it but the public signature still
 *  takes one. Returns an empty string so any accidental invocation
 *  is non-fatal. */
const noopAdapter: OwmRenderAdapter = {
  render: () => '',
};

const HARD_KINDS = new Set(['label-label', 'component-label', 'label-canvas']);

function countHardOverlaps(c: PositionedValueChain): number {
  const geometry = computeGeometry(c, emitOpts);
  return detectAllOverlaps(geometry).filter(o => HARD_KINDS.has(o.kind)).length;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('verifyLayout — public contract', () => {
  it('returns a result with the expected report shape', () => {
    const c = chain([
      { name: 'A', role: 'anchor',     visibility: 0.95, evolution: 0.5, label: { dx: -100, dy: 0 } },
      { name: 'B', role: 'capability', visibility: 0.5,  evolution: 0.5 },
    ], [{ from: 'A', to: 'B' }]);
    const out = verifyLayout(c, emitOpts, noopAdapter);
    assert.ok(out.chain);
    assert.equal(typeof out.report.iterations, 'number');
    assert.ok(Array.isArray(out.report.modifiedLabels));
    assert.ok(Array.isArray(out.report.movedComponents));
    assert.equal(typeof out.report.unresolvedHard,    'number');
    assert.equal(typeof out.report.unresolvedSpacing, 'number');
    assert.equal(typeof out.report.unresolvedEdge,    'number');
    assert.equal(typeof out.report.unresolvedAxis,    'number');
    assert.equal(out.report.skipped, false);
  });

  it('does not invoke the OwmRenderAdapter', () => {
    let calls = 0;
    const watchAdapter: OwmRenderAdapter = {
      render: () => { calls++; return ''; },
    };
    const c = chain([
      { name: 'A', role: 'anchor', visibility: 0.95, evolution: 0.5 },
    ]);
    verifyLayout(c, emitOpts, watchAdapter);
    assert.equal(calls, 0, 'V6 must not call adapter.render');
  });
});

describe('verifyLayout — hard-violation guarantee', () => {
  it('emits zero hard violations on a well-spread chain', () => {
    const c = chain(
      [
        { name: 'A', role: 'anchor',     visibility: 0.95, evolution: 0.5,  label: { dx: -100, dy: 0 } },
        { name: 'B', role: 'capability', visibility: 0.7,  evolution: 0.3,  label: { dx: 20, dy: 0 } },
        { name: 'C', role: 'capability', visibility: 0.5,  evolution: 0.7,  label: { dx: 20, dy: 0 } },
        { name: 'D', role: 'capability', visibility: 0.3,  evolution: 0.5,  label: { dx: 0,  dy: 25 } },
      ],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'B', to: 'D' },
        { from: 'C', to: 'D' },
      ],
    );
    const out = verifyLayout(c, emitOpts, noopAdapter);
    assert.equal(out.report.unresolvedHard, 0);
  });

  it('drives hard violations to 0 even on a colliding chain', () => {
    // Two components at the exact same position with overlapping labels.
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.5, evolution: 0.5, label: { dx: 0, dy: 25 } },
      { name: 'B', role: 'capability', visibility: 0.5, evolution: 0.5, label: { dx: 0, dy: 25 } },
    ]);
    assert.ok(countHardOverlaps(c) > 0, 'precondition: input has hard violations');
    const out = verifyLayout(c, emitOpts, noopAdapter);
    assert.equal(out.report.unresolvedHard, 0,
      'V6 must always produce a chain with zero hard violations');
  });
});

describe('verifyLayout — anchor immobility', () => {
  it('preserves anchor positions and labels exactly', () => {
    const c = chain([
      { name: 'A', role: 'anchor',     visibility: 0.95, evolution: 0.95, label: { dx: -100, dy: 0 } },
      { name: 'B', role: 'capability', visibility: 0.5,  evolution: 0.5 },
    ]);
    const out = verifyLayout(c, emitOpts, noopAdapter);
    const a = out.chain.components.find(x => x.name === 'A')!;
    assert.equal(a.evolution,   0.95);
    assert.equal(a.visibility,  0.95);
    assert.equal(a.label.dx,   -100);
    assert.equal(a.label.dy,    0);
    assert.ok(!out.report.modifiedLabels.includes('A'),
      'anchor never appears in modifiedLabels');
    assert.ok(!out.report.movedComponents.includes('A'),
      'anchor never appears in movedComponents');
  });
});

describe('verifyLayout — DSL invariants on output chain', () => {
  it('keeps Y(parent) > Y(child) for every link', () => {
    const c = chain(
      [
        { name: 'P', role: 'capability', visibility: 0.7, evolution: 0.5 },
        { name: 'C', role: 'capability', visibility: 0.5, evolution: 0.5 },
      ],
      [{ from: 'P', to: 'C' }],
    );
    const out = verifyLayout(c, emitOpts, noopAdapter);
    const p = out.chain.components.find(x => x.name === 'P')!;
    const ch = out.chain.components.find(x => x.name === 'C')!;
    assert.ok(p.visibility > ch.visibility,
      `P.Y (${p.visibility}) must remain > C.Y (${ch.visibility})`);
  });

  it('keeps every component within global bounds', () => {
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.5, evolution: 0.5 },
      { name: 'B', role: 'capability', visibility: 0.5, evolution: 0.5 },
    ]);
    const out = verifyLayout(c, emitOpts, noopAdapter);
    for (const comp of out.chain.components) {
      assert.ok(comp.evolution  >= 0.10 - 1e-9, `${comp.name} X < 0.10: ${comp.evolution}`);
      assert.ok(comp.evolution  <= 0.90 + 1e-9, `${comp.name} X > 0.90: ${comp.evolution}`);
      assert.ok(comp.visibility >= 0.10 - 1e-9, `${comp.name} Y < 0.10: ${comp.visibility}`);
      assert.ok(comp.visibility <= 0.95 + 1e-9, `${comp.name} Y > 0.95: ${comp.visibility}`);
    }
  });
});

describe('verifyLayout — output integrity', () => {
  it('does not mutate the input chain', () => {
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.5, evolution: 0.5, label: { dx: 0, dy: 25 } },
      { name: 'B', role: 'capability', visibility: 0.5, evolution: 0.5, label: { dx: 0, dy: 25 } },
    ]);
    const beforeA = c.components[0];
    const beforeLabel = c.components[0].label;
    verifyLayout(c, emitOpts, noopAdapter);
    assert.equal(c.components[0], beforeA);
    assert.equal(c.components[0].label, beforeLabel);
  });

  it('outputs integer label offsets only', () => {
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.5, evolution: 0.5 },
      { name: 'B', role: 'capability', visibility: 0.5, evolution: 0.5 },
    ]);
    const out = verifyLayout(c, emitOpts, noopAdapter);
    for (const comp of out.chain.components) {
      assert.equal(comp.label.dx, Math.round(comp.label.dx),
        `${comp.name}.dx is not integer: ${comp.label.dx}`);
      assert.equal(comp.label.dy, Math.round(comp.label.dy),
        `${comp.name}.dy is not integer: ${comp.label.dy}`);
    }
  });
});

describe('verifyLayout — modifiedLabels tracking', () => {
  it('lists labels that moved during simulation', () => {
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.5, evolution: 0.5, label: { dx: 0, dy: 25 } },
      { name: 'B', role: 'capability', visibility: 0.5, evolution: 0.5, label: { dx: 0, dy: 25 } },
    ]);
    const out = verifyLayout(c, emitOpts, noopAdapter);
    // At least one of the two labels must have moved to resolve the
    // collision.
    assert.ok(out.report.modifiedLabels.length >= 1,
      'expected modifiedLabels to include ≥ 1 name');
  });

  it('reports an empty modifiedLabels list when nothing changed', () => {
    // A trivial chain with one anchor — no labels to perturb.
    const c = chain([
      { name: 'A', role: 'anchor', visibility: 0.95, evolution: 0.5, label: { dx: -100, dy: 0 } },
    ]);
    const out = verifyLayout(c, emitOpts, noopAdapter);
    assert.deepEqual(out.report.modifiedLabels, []);
    assert.deepEqual(out.report.movedComponents, []);
  });
});
