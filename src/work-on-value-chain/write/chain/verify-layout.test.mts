// Tests for verify-layout.mts using a deterministic mock OwmRenderAdapter.
// No cli-owm involvement here — the adapter is the seam.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyLayout, MAX_VERIFY_ITERATIONS } from './verify-layout.mjs';
import type { OwmRenderAdapter } from '../../../lib/owm/render-adapter.mjs';
import type {
  LabelOffset,
  PositionedComponent,
  PositionedValueChain,
} from '../../../types/value-chain.mjs';

// ─── Chain seed helper ──────────────────────────────────────────────────

interface Seed {
  name: string;
  role: 'anchor' | 'need' | 'capability';
  visibility: number;
  evolution?: number;
  label?: LabelOffset;
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
      label: c.label ?? { dx: -100, dy: 0 },
    })),
    links,
  };
}

// ─── Mock adapter — emits SVG whose bbox layout depends on label
// offsets so we can simulate collisions deterministically.

interface MockSvgComponent {
  name: string;
  cx: number;
  cy: number;
}

/** Build an SVG that puts each labelled component at fixed (cx, cy)
 *  with its label at (cx + label.dx, cy + label.dy). The bbox parser
 *  then extracts the same geometry. */
function makeAdapter(components: MockSvgComponent[]): OwmRenderAdapter {
  return {
    render: (dsl: string): string => {
      // Read each component's label offset from the DSL by regex.
      // The DSL line is e.g. `component Foo [0.4, 0.5] label [-100, 0]`.
      const labelRx = /^(?:component|anchor)\s+(.+?)\s+\[[^\]]+\]\s+label\s+\[(-?[\d.]+),\s*(-?[\d.]+)\]/gm;
      const offsetByName = new Map<string, { dx: number; dy: number }>();
      let m: RegExpExecArray | null;
      while ((m = labelRx.exec(dsl)) !== null) {
        offsetByName.set(m[1], { dx: parseFloat(m[2]), dy: parseFloat(m[3]) });
      }

      const parts: string[] = ['<svg>'];
      for (const c of components) {
        const off = offsetByName.get(c.name) ?? { dx: 0, dy: 0 };
        parts.push(`<circle cx="${c.cx}" cy="${c.cy}" r="5"/>`);
        parts.push(
          `<text x="${c.cx + off.dx}" y="${c.cy + off.dy}">${c.name}</text>`,
        );
      }
      parts.push('</svg>');
      return parts.join('');
    },
  };
}

const emitOpts = { style: 'plain' as const };

// ─── Tests ──────────────────────────────────────────────────────────────

describe('verifyLayout — clean baseline', () => {
  it('returns the chain unchanged when no overlaps are detected', () => {
    const c = chain([
      { name: 'Anchor', role: 'anchor',     visibility: 0.95, label: { dx: 0, dy: 25 } },
      { name: 'Need',   role: 'need',       visibility: 0.65, label: { dx: 20, dy: 0 } },
    ], [{ from: 'Anchor', to: 'Need' }]);
    const adapter = makeAdapter([
      { name: 'Anchor', cx:  50, cy: 50 },
      { name: 'Need',   cx: 200, cy: 200 },
    ]);
    const out = verifyLayout(c, emitOpts, adapter);
    assert.equal(out.report.iterations, 0);
    assert.deepEqual(out.report.modifiedLabels, []);
    assert.equal(out.report.unresolvedOverlaps, 0);
    assert.equal(out.report.skipped, false);
    assert.deepEqual(out.chain.components.map(c => c.label), c.components.map(c => c.label));
  });
});

describe('verifyLayout — single fixable collision', () => {
  it('moves the offending label to a non-colliding offset', () => {
    // Two components are placed at almost the same (cx, cy). With both
    // labels at dx=-100, dy=0 their text bboxes will overlap heavily.
    // verify-layout should pick a non-conflicting offset for one.
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.5, label: { dx: -100, dy: 0 } },
      { name: 'B', role: 'capability', visibility: 0.5, label: { dx: -100, dy: 0 } },
    ]);
    const adapter = makeAdapter([
      { name: 'A', cx: 100, cy: 100 },
      { name: 'B', cx: 100, cy: 100 }, // same circle position → labels collide
    ]);
    const out = verifyLayout(c, emitOpts, adapter);
    assert.ok(out.report.iterations >= 1, 'should iterate at least once');
    assert.ok(out.report.modifiedLabels.length >= 1, 'should modify ≥ 1 label');
    // The chosen offsets must end up distinct so the labels separate.
    const finalA = out.chain.components.find(c => c.name === 'A')!.label;
    const finalB = out.chain.components.find(c => c.name === 'B')!.label;
    assert.ok(finalA.dx !== finalB.dx || finalA.dy !== finalB.dy);
  });
});

describe('verifyLayout — adapter unavailable', () => {
  it('returns the chain unchanged with skipped=true when render throws', () => {
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.5 },
    ]);
    const adapter: OwmRenderAdapter = {
      render: () => { throw new Error('cli-owm unavailable'); },
    };
    const out = verifyLayout(c, emitOpts, adapter);
    assert.equal(out.report.skipped, true);
    assert.equal(out.report.iterations, 0);
    assert.deepEqual(out.report.modifiedLabels, []);
    // Chain reference equality with the input — unchanged.
    assert.equal(out.chain, c);
  });
});

describe('verifyLayout — convergence cap', () => {
  it('caps the iteration count at MAX_VERIFY_ITERATIONS even when overlaps persist', () => {
    // Adapter that always reports two heavily overlapping labels regardless
    // of offsets — verify-layout must not exceed the cap.
    const adapter: OwmRenderAdapter = {
      render: (): string =>
        '<svg>' +
        '<circle cx="100" cy="100" r="5"/>' +
        '<text x="100" y="100">A</text>' +
        '<circle cx="100" cy="100" r="5"/>' +
        '<text x="100" y="100">B</text>' +
        '</svg>',
    };
    const c = chain([
      { name: 'A', role: 'capability', visibility: 0.5 },
      { name: 'B', role: 'capability', visibility: 0.5 },
    ]);
    const out = verifyLayout(c, emitOpts, adapter);
    assert.ok(out.report.iterations <= MAX_VERIFY_ITERATIONS);
    // Always returns; never throws. Loop terminates even on insoluble
    // adapters.
    assert.equal(typeof out.report.unresolvedOverlaps, 'number');
  });
});

describe('verifyLayout — only label overlaps are corrected', () => {
  it('breaks out when remaining overlaps involve no labels', () => {
    // Adapter emits two anchor texts that collide — anchors aren't
    // correctable by this loop, so it should terminate fast.
    const adapter: OwmRenderAdapter = {
      render: (): string =>
        '<svg>' +
        '<text x="50" y="50" text-anchor="middle">R1</text>' +
        '<text x="50" y="50" text-anchor="middle">R2</text>' +
        '</svg>',
    };
    const c = chain([
      { name: 'R1', role: 'anchor', visibility: 0.95 },
      { name: 'R2', role: 'anchor', visibility: 0.95 },
    ]);
    const out = verifyLayout(c, emitOpts, adapter);
    assert.equal(out.report.modifiedLabels.length, 0);
    // Did at least one render to discover the situation.
    assert.ok(out.report.iterations >= 1);
  });
});
