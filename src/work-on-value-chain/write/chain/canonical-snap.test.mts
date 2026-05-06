// Tests for canonical-snap.mts (Phase 7).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapToCanonical,
  canonicalOffsetsFor,
  LEFT_FLUSH_BUFFER_PX,
  RIGHT_OFFSET_PX,
  TOP_OFFSET_PX,
  BOTTOM_OFFSET_PX,
  DIAGONAL_DY_OFFSET_PX,
} from './canonical-snap.mjs';
import { LABEL_CHAR_WIDTH } from '../../../lib/owm/svg-bbox-parser.mjs';
import { computeGeometry } from '../../../lib/owm/analytical-geometry.mjs';
import { detectAllOverlaps } from '../../../lib/owm/overlap-detector.mjs';
import type {
  LabelOffset,
  PositionedComponent,
  PositionedValueChain,
} from '../../../types/value-chain.mjs';

interface Seed {
  name: string;
  role: 'anchor' | 'need' | 'capability';
  visibility: number;
  evolution?: number;
  label?: LabelOffset;
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
      visibility: s.visibility,
      evolution: s.evolution ?? 0.5,
      label: s.label ?? { dx: 0, dy: 25 },
    })),
    links,
  };
}

const emitOpts = { style: 'plain' as const };

const HARD_KINDS = new Set(['label-label', 'component-label', 'label-canvas']);
function countHard(c: PositionedValueChain): number {
  const geometry = computeGeometry(c, emitOpts);
  return detectAllOverlaps(geometry).filter(o => HARD_KINDS.has(o.kind)).length;
}

// ─── Canonical candidate set ──────────────────────────────────────────

describe('canonicalOffsetsFor', () => {
  it('returns exactly 8 candidates per call', () => {
    assert.equal(canonicalOffsetsFor('Foo').length, 8);
    assert.equal(canonicalOffsetsFor('A').length, 8);
    assert.equal(canonicalOffsetsFor('Long component name').length, 8);
  });

  it('LEFT cardinal scales with label length', () => {
    const short = canonicalOffsetsFor('Foo');           // 3 chars
    const longer = canonicalOffsetsFor('Foo Bar Baz');  // 11 chars
    const dxShort = short.find(c => c.dx < 0 && c.dy === 0)!.dx;
    const dxLong  = longer.find(c => c.dx < 0 && c.dy === 0)!.dx;
    assert.equal(dxShort, -(3 * LABEL_CHAR_WIDTH + LEFT_FLUSH_BUFFER_PX));
    assert.equal(dxLong,  -(11 * LABEL_CHAR_WIDTH + LEFT_FLUSH_BUFFER_PX));
    assert.ok(dxLong < dxShort, 'longer name → more negative dx');
  });

  it('RIGHT cardinal stays at +RIGHT_OFFSET_PX regardless of length', () => {
    assert.equal(canonicalOffsetsFor('Foo').find(c => c.dx > 0 && c.dy === 0)!.dx, RIGHT_OFFSET_PX);
    assert.equal(canonicalOffsetsFor('Long Long Long').find(c => c.dx > 0 && c.dy === 0)!.dx, RIGHT_OFFSET_PX);
  });

  it('emits 4 cardinals + 4 diagonals', () => {
    const cs = canonicalOffsetsFor('A');
    const cardinals = cs.filter(c => c.dx === 0 || c.dy === 0);
    const diagonals = cs.filter(c => c.dx !== 0 && c.dy !== 0);
    assert.equal(cardinals.length, 4);
    assert.equal(diagonals.length, 4);
    assert.ok(cs.some(c => c.dx === 0 && c.dy === BOTTOM_OFFSET_PX));
    assert.ok(cs.some(c => c.dx === 0 && c.dy === TOP_OFFSET_PX));
    assert.ok(diagonals.every(c => Math.abs(c.dy) === DIAGONAL_DY_OFFSET_PX));
  });
});

// ─── snapToCanonical behaviour ────────────────────────────────────────

describe('snapToCanonical — clean baseline', () => {
  it('hard count stays at 0 when input is already canonical-friendly', () => {
    const c = chain([
      { name: 'A', role: 'anchor',     visibility: 0.95, evolution: 0.5,  label: { dx: -100, dy: 0 } },
      { name: 'B', role: 'capability', visibility: 0.5,  evolution: 0.5,  label: { dx: 0, dy: 25 } },
    ]);
    assert.equal(countHard(c), 0, 'precondition: no hard violation');
    const out = snapToCanonical(c, emitOpts);
    assert.equal(countHard(out.chain), 0, 'hard guarantee preserved by snap');
  });
});

describe('snapToCanonical — preferences canonical at hard ties', () => {
  it('snaps a continuous label toward a canonical offset when both achieve hard=0', () => {
    // Component at (0.5, 0.5) with a slightly off-canonical label.
    // Candidates BELOW [0, 25] and ABOVE [0, -25] are both hard=0 (no
    // neighbours to clash). The continuous offset (3, 22) is also
    // hard=0, so the snap rule should pick a canonical.
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.5, evolution: 0.5, label: { dx: 3, dy: 22 } },
    ]);
    const out = snapToCanonical(c, emitOpts);
    const a = out.chain.components.find(x => x.name === 'A')!;
    // The chosen offset must be one of the canonicals.
    const canonical = canonicalOffsetsFor('A');
    const isCanonical = canonical.some(c => c.dx === a.label.dx && c.dy === a.label.dy);
    assert.ok(isCanonical, `expected canonical offset, got ${JSON.stringify(a.label)}`);
    assert.ok(out.snapped.includes('A'), 'expected A in snapped list');
  });
});

describe('snapToCanonical — anchor immobility', () => {
  it('never snaps an anchor label', () => {
    const c = chain([
      { name: 'A', role: 'anchor',     visibility: 0.95, evolution: 0.95, label: { dx: -100, dy: 0 } },
      { name: 'B', role: 'capability', visibility: 0.5,  evolution: 0.5 },
    ]);
    const out = snapToCanonical(c, emitOpts);
    const a = out.chain.components.find(x => x.name === 'A')!;
    assert.equal(a.label.dx, -100);
    assert.equal(a.label.dy, 0);
    assert.ok(!out.snapped.includes('A'),
      'anchor must not appear in snapped list');
  });
});

describe('snapToCanonical — hard-guarantee preserved', () => {
  it('hard count never increases after snap', () => {
    // Multiple components — snap evaluates each, never picks a candidate
    // that increases hard.
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.7, evolution: 0.3, label: { dx: 7, dy: 18 } },
      { name: 'B', role: 'capability', visibility: 0.5, evolution: 0.5, label: { dx: -3, dy: 22 } },
      { name: 'C', role: 'capability', visibility: 0.3, evolution: 0.7, label: { dx: 12, dy: -10 } },
    ]);
    const before = countHard(c);
    const out = snapToCanonical(c, emitOpts);
    const after = countHard(out.chain);
    assert.ok(after <= before,
      `hard count increased: before=${before} after=${after}`);
  });
});

describe('snapToCanonical — output integrity', () => {
  it('does not mutate the input chain', () => {
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.5, evolution: 0.5, label: { dx: 5, dy: 22 } },
    ]);
    const beforeLabel = c.components[0].label;
    snapToCanonical(c, emitOpts);
    const afterLabel = c.components[0].label;
    assert.equal(beforeLabel, afterLabel,
      'input chain reference should be unchanged');
  });

  it('outputs integer label offsets only', () => {
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.5, evolution: 0.5, label: { dx: 7, dy: 23 } },
      { name: 'B', role: 'capability', visibility: 0.5, evolution: 0.5, label: { dx: -3, dy: 22 } },
    ]);
    const out = snapToCanonical(c, emitOpts);
    for (const comp of out.chain.components) {
      assert.equal(comp.label.dx, Math.round(comp.label.dx));
      assert.equal(comp.label.dy, Math.round(comp.label.dy));
    }
  });
});
