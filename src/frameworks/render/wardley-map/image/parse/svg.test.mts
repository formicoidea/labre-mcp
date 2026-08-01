// Round-trip oracle for `render:wardley-map:image:parse:svg`.
//
// The reference test is idempotence: emit:svg → parse:svg → compare. SVG
// fixtures are generated on the fly by the real emit strategy (never checked
// in), so the test breaks the day the renderer's DOM contract drifts — which
// is exactly the signal we want for the "dataset by round-trip" pipeline.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RenderWardleyMapImageEmitSvgStrategy } from '../emit/svg.mjs';
import { RenderWardleyMapImageParseSvgStrategy } from './svg.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx: RequestContext = { projectId: 'p', projectRoot: '/tmp/p', sessionId: 's', domain: 'render' };

/** Scalar tolerance promised by the strategy contract. */
const EPSILON = 0.02;

// ── Fixture builders ───────────────────────────────────────────────────

// Plain `component` nodes carry no id in the SVG, so the parser slugifies
// their label. Fixtures use the same rule, which is what the value-chain ACL
// (`buildIdMap`) produces anyway — ids therefore round-trip exactly.
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

interface NodeSpec {
  name: string;
  evolution: number;
  visibility: number;
  anchor?: boolean;
  label?: { dx: number; dy: number };
}

function buildMap(title: string, nodes: NodeSpec[], links: Array<[number, number]>): WardleyMap {
  return WardleyMapSchema.parse({
    title,
    components: nodes.map((n) => ({
      id: slug(n.name),
      label: { name: n.name, ...(n.label ? { position: n.label } : {}) },
      type: n.anchor === true ? 'anchor' : 'component',
      position: {
        evolution: { scalar: n.evolution },
        visibility: { scalar: n.visibility },
      },
    })),
    relations: links.map(([from, to], i) => ({
      id: `rel-${i + 1}`,
      consumer: slug(nodes[from].name),
      supplier: slug(nodes[to].name),
    })),
  });
}

async function emit(map: WardleyMap): Promise<string> {
  const out = await new RenderWardleyMapImageEmitSvgStrategy().evaluate(map, ctx);
  assert.equal(out.result.rendered, true, 'fixture must render');
  return out.result.svg;
}

async function parse(svg: string) {
  return new RenderWardleyMapImageParseSvgStrategy().evaluate({ svg }, ctx);
}

/** Assert the parsed map reproduces the source map, and return the worst ε seen. */
function assertRoundTrip(source: WardleyMap, parsed: WardleyMap, label: string): number {
  assert.equal(parsed.title, source.title, `${label}: title`);
  assert.equal(parsed.components.length, source.components.length, `${label}: component count`);
  assert.equal(parsed.relations.length, source.relations.length, `${label}: relation count`);

  let worst = 0;
  for (let i = 0; i < source.components.length; i += 1) {
    const a = source.components[i];
    const b = parsed.components[i];
    assert.equal(b.id, a.id, `${label}: component #${i} id`);
    assert.equal(b.label.name, a.label.name, `${label}: component #${i} label`);
    assert.equal(b.type, a.type, `${label}: component #${i} type`);
    const de = Math.abs(b.position.evolution.scalar - a.position.evolution.scalar);
    const dv = Math.abs(b.position.visibility.scalar - a.position.visibility.scalar);
    assert.ok(de <= EPSILON, `${label}: component #${i} evolution drift ${de}`);
    assert.ok(dv <= EPSILON, `${label}: component #${i} visibility drift ${dv}`);
    worst = Math.max(worst, de, dv);
  }
  for (let i = 0; i < source.relations.length; i += 1) {
    const a = source.relations[i];
    const b = parsed.relations[i];
    assert.equal(b.id, a.id, `${label}: relation #${i} id`);
    assert.equal(b.consumer, a.consumer, `${label}: relation #${i} consumer`);
    assert.equal(b.supplier, a.supplier, `${label}: relation #${i} supplier`);
    assert.equal(b.type, a.type, `${label}: relation #${i} type`);
  }
  return worst;
}

// ── Five varied synthetic maps ─────────────────────────────────────────

const FIXTURES: Array<{ label: string; map: WardleyMap }> = [
  {
    label: 'minimal pair',
    map: buildMap(
      'Online payments',
      [
        { name: 'Customer', evolution: 0.5, visibility: 0.95, anchor: true },
        { name: 'Checkout', evolution: 0.6, visibility: 0.8 },
      ],
      [[0, 1]],
    ),
  },
  {
    label: 'two anchors, crossed relations',
    map: buildMap(
      'Two audiences',
      [
        { name: 'Retail Buyer', evolution: 0.25, visibility: 0.95, anchor: true },
        { name: 'Wholesale Buyer', evolution: 0.7, visibility: 0.93, anchor: true },
        { name: 'Order Capture', evolution: 0.42, visibility: 0.65 },
        { name: 'Pricing Engine', evolution: 0.58, visibility: 0.45 },
        { name: 'Ledger', evolution: 0.86, visibility: 0.2 },
      ],
      // Deliberately crossed: 0→3 and 1→2 produce intersecting edges.
      [
        [0, 2],
        [0, 3],
        [1, 2],
        [1, 3],
        [2, 4],
        [3, 4],
      ],
    ),
  },
  {
    label: 'multi-word labels with pinned offsets',
    map: buildMap(
      'Label stress test',
      [
        { name: 'End User Of The Platform', evolution: 0.3, visibility: 0.9, anchor: true },
        { name: 'Self Service Portal', evolution: 0.45, visibility: 0.72, label: { dx: -20, dy: -10 } },
        { name: 'Identity And Access Management', evolution: 0.66, visibility: 0.5, label: { dx: 14, dy: 18 } },
        { name: 'Managed Database Cluster', evolution: 0.9, visibility: 0.28, label: { dx: -12, dy: 20 } },
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    ),
  },
  {
    label: 'edge-of-canvas positions',
    map: buildMap(
      'Extremes',
      [
        { name: 'Novel Idea', evolution: 0.02, visibility: 0.02 },
        { name: 'Utility Power', evolution: 0.98, visibility: 0.98 },
        { name: 'Top Right', evolution: 0.98, visibility: 0.02 },
        { name: 'Bottom Left', evolution: 0.02, visibility: 0.98 },
        { name: 'Dead Centre', evolution: 0.5, visibility: 0.5 },
      ],
      [
        [0, 4],
        [4, 1],
        [2, 4],
        [3, 4],
      ],
    ),
  },
  {
    label: 'twelve components',
    map: buildMap(
      'Wide value chain',
      [
        { name: 'Public User', evolution: 0.2, visibility: 0.96, anchor: true },
        { name: 'Web Front End', evolution: 0.28, visibility: 0.88 },
        { name: 'Mobile App', evolution: 0.32, visibility: 0.86 },
        { name: 'API Gateway', evolution: 0.55, visibility: 0.74 },
        { name: 'Search Service', evolution: 0.4, visibility: 0.62 },
        { name: 'Recommendation Engine', evolution: 0.22, visibility: 0.6 },
        { name: 'Catalogue Store', evolution: 0.63, visibility: 0.48 },
        { name: 'Event Bus', evolution: 0.71, visibility: 0.44 },
        { name: 'Observability Stack', evolution: 0.68, visibility: 0.3 },
        { name: 'Container Platform', evolution: 0.8, visibility: 0.24 },
        { name: 'Object Storage', evolution: 0.93, visibility: 0.14 },
        { name: 'Compute', evolution: 0.97, visibility: 0.06 },
      ],
      [
        [0, 1],
        [0, 2],
        [1, 3],
        [2, 3],
        [3, 4],
        [3, 5],
        [4, 6],
        [5, 6],
        [6, 7],
        [7, 8],
        [8, 9],
        [9, 10],
        [9, 11],
        [10, 11],
      ],
    ),
  },
];

describe('render:wardley-map:image:parse:svg (real, round-trip oracle)', () => {
  for (const fixture of FIXTURES) {
    it(`round-trips "${fixture.label}" through emit:svg`, async () => {
      const svg = await emit(fixture.map);
      const out = await parse(svg);

      assert.equal(out.result.parsed, true, 'must parse');
      assert.deepEqual(out.result.warnings, [], 'a renderer-emitted map needs no warning');
      assert.ok(out.result.map !== null);
      const worst = assertRoundTrip(fixture.map, out.result.map, fixture.label);
      // The inversion is affine and the renderer prints full float precision,
      // so the real error is float noise, orders of magnitude under ε.
      assert.ok(worst < 1e-5, `${fixture.label}: observed drift ${worst} should be float noise`);
    });
  }

  it('exposes componentCount / relationCount / input-valid signals', async () => {
    const fixture = FIXTURES[1];
    const out = await parse(await emit(fixture.map));
    const byName = new Map(out.signals.map((s) => [s.name, s.value]));
    assert.equal(byName.get('input-valid'), true);
    assert.equal(byName.get('componentCount'), fixture.map.components.length);
    assert.equal(byName.get('relationCount'), fixture.map.relations.length);
    assert.equal(out.insights.length, 0, 'nothing was dropped');
  });

  it('reuses the anchor id leaked by the SVG rather than the label slug', async () => {
    // `anchor-clip-<id>` carries the ORIGINAL id, even when it does not match
    // the label at all — proof the parser prefers it over slugification.
    const map = WardleyMapSchema.parse({
      title: 'Anchor identity',
      components: [
        {
          id: 'persona-42',
          label: { name: 'Some Human Being' },
          type: 'anchor',
          position: { evolution: { scalar: 0.4 }, visibility: { scalar: 0.9 } },
        },
        {
          id: 'plain-thing',
          label: { name: 'Plain Thing' },
          type: 'component',
          position: { evolution: { scalar: 0.6 }, visibility: { scalar: 0.5 } },
        },
      ],
      relations: [{ id: 'rel-1', consumer: 'persona-42', supplier: 'plain-thing' }],
    });
    const out = await parse(await emit(map));
    assert.ok(out.result.map !== null);
    assert.equal(out.result.map.components[0].id, 'persona-42');
    assert.equal(out.result.map.components[1].id, 'plain-thing'); // slug(label) === id here
    assert.equal(out.result.map.relations[0].consumer, 'persona-42');
  });

  it('restores XML-escaped and multi-line labels verbatim', async () => {
    const name = "R&D <core>\nsecond line";
    const map = WardleyMapSchema.parse({
      title: 'Escaping & <edge> cases',
      components: [
        {
          id: 'rd-core',
          label: { name },
          type: 'component',
          position: { evolution: { scalar: 0.33 }, visibility: { scalar: 0.44 } },
        },
      ],
      relations: [],
    });
    const out = await parse(await emit(map));
    assert.ok(out.result.map !== null);
    assert.equal(out.result.map.title, 'Escaping & <edge> cases');
    assert.equal(out.result.map.components[0].label.name, name);
  });

  it('carries the relation type back from the edge stroke', async () => {
    const map = WardleyMapSchema.parse({
      title: 'Typed relations',
      components: [
        { id: 'a', label: { name: 'A' }, type: 'component', position: { evolution: { scalar: 0.2 }, visibility: { scalar: 0.8 } } },
        { id: 'b', label: { name: 'B' }, type: 'component', position: { evolution: { scalar: 0.7 }, visibility: { scalar: 0.3 } } },
        { id: 'c', label: { name: 'C' }, type: 'component', position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.5 } } },
      ],
      relations: [
        { id: 'rel-1', consumer: 'a', supplier: 'b', type: 'Flow' },
        { id: 'rel-2', consumer: 'b', supplier: 'c', type: 'Constraint' },
      ],
    });
    const out = await parse(await emit(map));
    assert.ok(out.result.map !== null);
    assert.equal(out.result.map.relations[0].type, 'Flow');
    assert.equal(out.result.map.relations[1].type, 'Constraint');
  });

  it('reports the layers it cannot reconstruct instead of crashing', async () => {
    // evolvesTo produces a layer this v1 does not invert.
    const map = WardleyMapSchema.parse({
      title: 'Movement',
      components: [
        {
          id: 'thing',
          label: { name: 'Thing' },
          type: 'component',
          position: { evolution: { scalar: 0.3 }, visibility: { scalar: 0.6 } },
          evolvesTo: [
            { position: { evolution: { scalar: 0.8 }, visibility: { scalar: 0.6 } } },
          ],
        },
      ],
      relations: [],
    });
    const out = await parse(await emit(map));
    assert.equal(out.result.parsed, true, 'still yields a map');
    assert.ok(out.result.map !== null);
    assert.equal(out.result.map.components[0].id, 'thing');
    assert.ok(
      out.result.warnings.some((w) => w.includes('evolvesTo')),
      `expected an evolvesTo warning, got ${JSON.stringify(out.result.warnings)}`,
    );
    assert.equal(out.insights.length, 1, 'dropped constructs surface as one insight');
  });

  it('degrades on an SVG that is not an SVG at all (no throw)', async () => {
    const out = await parse('this is definitely not markup');
    assert.equal(out.result.parsed, false);
    assert.equal(out.result.map, null);
    assert.deepEqual(out.result.warnings, ['input is not an SVG document']);
    assert.equal(out.insights.length, 1);
  });

  it('degrades on a valid but non-wardley SVG', async () => {
    const foreign =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">\n' +
      '<rect width="120" height="60" fill="#eeeeee" />\n' +
      '<circle cx="60" cy="30" r="12" fill="#ff0000" />\n' +
      '<text x="60" y="55" text-anchor="middle">not a map</text>\n' +
      '</svg>';
    const out = await parse(foreign);
    assert.equal(out.result.parsed, false);
    assert.equal(out.result.map, null);
    assert.match(out.result.warnings[0], /not an SVG emitted by our renderer/);
  });

  it('degrades on a non-canonical input shape (mock upstream)', async () => {
    const out = await new RenderWardleyMapImageParseSvgStrategy().evaluate(
      { mock: true, methodId: 'whatever' },
      ctx,
    );
    assert.equal(out.result.parsed, false);
    assert.equal(out.result.map, null);
    assert.equal(out.signals[0].name, 'input-valid');
    assert.equal(out.signals[0].value, false);
    assert.match(out.insights[0].text, /not \{ svg: string \}/);
  });
});
