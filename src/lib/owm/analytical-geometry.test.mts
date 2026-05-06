// Regression test for analytical-geometry.mts.
//
// For each fixture chain we compute the geometry two ways:
//   1. Analytically  : computeGeometry(chain, emitOpts).
//   2. Via cli-owm   : parseSvgGeometry(adapter.render(emit(chain))).
// We then assert that every bbox matches within ±1 px tolerance and
// that the items / edges / canvas / mapArea / phaseAxes fields agree
// element-by-element.
//
// This test is the contract that pins our analytical model to
// cli-owm's actual SVG output. If it fails after a future cli-owm
// vendor bump, the constants in `analytical-geometry.mts` need
// re-validation.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeGeometry } from './analytical-geometry.mjs';
import { parseSvgGeometry, type Bbox, type GeometryItem, type EdgeSegment } from './svg-bbox-parser.mjs';
import { CliOwmAdapter } from './cli-owm-adapter.mjs';
import { generateChainOwmSyntax, type EmitOwmOptions } from '../../work-on-value-chain/write/chain/emit-owm.mjs';
import type { PositionedValueChain, PositionedComponent } from '../../types/value-chain.mjs';

// ─── Fixture builder ───────────────────────────────────────────────────

interface Seed {
  name: string;
  role: 'anchor' | 'need' | 'capability';
  evolution: number;
  visibility: number;
  dx?: number; dy?: number;
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

// ─── Comparison helpers ────────────────────────────────────────────────

const PIXEL_TOLERANCE = 1;

function close(a: number, b: number, label: string): void {
  const diff = Math.abs(a - b);
  assert.ok(
    diff <= PIXEL_TOLERANCE,
    `${label}: ${a} vs ${b} (diff ${diff} > tolerance ${PIXEL_TOLERANCE})`,
  );
}

function sameBbox(a: Bbox, b: Bbox, prefix: string): void {
  close(a.x,      b.x,      `${prefix}.x`);
  close(a.y,      b.y,      `${prefix}.y`);
  close(a.width,  b.width,  `${prefix}.width`);
  close(a.height, b.height, `${prefix}.height`);
}

function indexByKey(items: ReadonlyArray<GeometryItem>): Map<string, GeometryItem> {
  return new Map(items.map(it => [`${it.name}:${it.kind}`, it]));
}

function indexEdges(edges: ReadonlyArray<EdgeSegment>): Map<string, EdgeSegment> {
  return new Map(edges.map(e => [`${e.from}->${e.to}`, e]));
}

function knownNames(c: PositionedValueChain): Set<string> {
  return new Set(c.components.map(c => c.name));
}

// ─── Fixtures ─────────────────────────────────────────────────────────

function fixtureMonoAnchorTwoComponents(): PositionedValueChain {
  return chain(
    [
      { name: 'User', role: 'anchor',     evolution: 0.5, visibility: 0.95, dx: -100, dy: 0 },
      { name: 'Need', role: 'need',       evolution: 0.6, visibility: 0.7,  dx: 0,    dy: 25 },
      { name: 'Cap',  role: 'capability', evolution: 0.4, visibility: 0.4,  dx: 20,   dy: 0 },
    ],
    [
      { from: 'User', to: 'Need' },
      { from: 'Need', to: 'Cap'  },
    ],
  );
}

function fixtureCustomSize(): PositionedValueChain {
  return chain(
    [
      { name: 'A', role: 'anchor',     evolution: 0.5, visibility: 0.95, dx: -100, dy: 0 },
      { name: 'B', role: 'capability', evolution: 0.7, visibility: 0.5 },
    ],
    [{ from: 'A', to: 'B' }],
  );
}

function fixtureLongChain(): PositionedValueChain {
  return chain(
    [
      { name: 'Root',                  role: 'anchor',     evolution: 0.5,  visibility: 0.95, dx: -100, dy: 0 },
      { name: 'Need One',              role: 'need',       evolution: 0.55, visibility: 0.75, dx: 20,   dy: 0 },
      { name: 'Capability A',          role: 'capability', evolution: 0.45, visibility: 0.55, dx: -100, dy: 0 },
      { name: 'Sub Capability',        role: 'capability', evolution: 0.35, visibility: 0.35, dx: 0,    dy: 25 },
      { name: 'Long Component Name X', role: 'capability', evolution: 0.6,  visibility: 0.3,  dx: 0,    dy: -25 },
    ],
    [
      { from: 'Root',                  to: 'Need One' },
      { from: 'Need One',              to: 'Capability A' },
      { from: 'Capability A',          to: 'Sub Capability' },
      { from: 'Sub Capability',        to: 'Long Component Name X' },
    ],
  );
}

const adapter = new CliOwmAdapter();

function comparePair(label: string, c: PositionedValueChain, opts: EmitOwmOptions): void {
  const analytical = computeGeometry(c, opts);
  const dsl = generateChainOwmSyntax(c, opts);
  const svg = adapter.render(dsl);
  const fromCli = parseSvgGeometry(svg, knownNames(c));

  // Canvas
  close(analytical.canvas.width,  fromCli.canvas.width,  `${label} canvas.width`);
  close(analytical.canvas.height, fromCli.canvas.height, `${label} canvas.height`);

  // mapArea — cli-owm output has `<rect id="fillArea" x=0 y=0
  // width=mapWidth height=mapHeight>` matching our analytical mapArea.
  sameBbox(analytical.mapArea, fromCli.mapArea, `${label} mapArea`);

  // Phase axes
  assert.equal(analytical.phaseAxes.length, fromCli.phaseAxes.length, `${label} phaseAxes count`);
  for (let i = 0; i < analytical.phaseAxes.length; i++) {
    close(analytical.phaseAxes[i], fromCli.phaseAxes[i], `${label} phaseAxes[${i}]`);
  }

  // Items: match by (name, kind), order-agnostic.
  const aIdx = indexByKey(analytical.items);
  const cIdx = indexByKey(fromCli.items);
  assert.equal(aIdx.size, cIdx.size,
    `${label} items count: analytical ${aIdx.size} vs cli ${cIdx.size}`);
  for (const [key, aItem] of aIdx) {
    const cItem = cIdx.get(key);
    assert.ok(cItem, `${label} cli missing item ${key}`);
    sameBbox(aItem.bbox, cItem.bbox, `${label} ${key} bbox`);
  }

  // Edges: match by from->to.
  const aEdgeIdx = indexEdges(analytical.edges);
  const cEdgeIdx = indexEdges(fromCli.edges);
  assert.equal(aEdgeIdx.size, cEdgeIdx.size, `${label} edges count`);
  for (const [key, aEdge] of aEdgeIdx) {
    const cEdge = cEdgeIdx.get(key);
    assert.ok(cEdge, `${label} cli missing edge ${key}`);
    close(aEdge.x1, cEdge.x1, `${label} ${key} x1`);
    close(aEdge.y1, cEdge.y1, `${label} ${key} y1`);
    close(aEdge.x2, cEdge.x2, `${label} ${key} x2`);
    close(aEdge.y2, cEdge.y2, `${label} ${key} y2`);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('computeGeometry — round-trip vs cli-owm', () => {
  it('agrees on a mono-anchor 2-component chain at default size', () => {
    comparePair('mono-anchor-default',
      fixtureMonoAnchorTwoComponents(),
      { style: 'plain' });
  });

  it('agrees when the DSL specifies a custom size [800, 1000]', () => {
    comparePair('custom-size',
      fixtureCustomSize(),
      { style: 'plain', size: { width: 800, height: 1000 } });
  });

  it('agrees on a longer chain with five components and varied label offsets', () => {
    comparePair('long-chain',
      fixtureLongChain(),
      { style: 'plain', size: { width: 1216, height: 650 } });
  });
});

describe('computeGeometry — fast path properties', () => {
  it('does not call into cli-owm (pure JS — verified by zero adapter mocks here)', () => {
    // Sanity: even without an OwmRenderAdapter, the computer works.
    const result = computeGeometry(
      fixtureCustomSize(),
      { style: 'plain' },
    );
    assert.ok(result.items.length > 0);
    assert.ok(result.canvas.width > 0);
  });

  it('handles a chain with zero links by emitting an empty edges array', () => {
    const c = chain([
      { name: 'Solo', role: 'anchor', evolution: 0.5, visibility: 0.95 },
    ]);
    const result = computeGeometry(c, { style: 'plain' });
    assert.deepEqual(result.edges, []);
  });

  it('drops links whose endpoints are unknown components (defensive)', () => {
    const c = chain(
      [{ name: 'Real', role: 'anchor', evolution: 0.5, visibility: 0.95 }],
      [{ from: 'Real', to: 'Ghost' }],   // 'Ghost' not in components
    );
    const result = computeGeometry(c, { style: 'plain' });
    assert.deepEqual(result.edges, []);
  });
});
