import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RenderWardleyMapImageEmitSvgStrategy } from './svg.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx: RequestContext = { projectId: 'p', projectRoot: '/tmp/p', sessionId: 's', domain: 'render' };

const map = WardleyMapSchema.parse({
  title: 'Online payments',
  components: [
    { id: 'customer', label: { name: 'Customer' }, type: 'anchor', position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.95 } } },
    { id: 'checkout', label: { name: 'Checkout' }, type: 'component', position: { evolution: { scalar: 0.6 }, visibility: { scalar: 0.8 } } },
  ],
  relations: [{ id: 'r1', consumer: 'customer', supplier: 'checkout' }],
});

describe('render:wardley-map:image:emit:svg (real, renderer package)', () => {
  it('renders a canonical WardleyMap to SVG directly via renderToSVG', async () => {
    const out = await new RenderWardleyMapImageEmitSvgStrategy().evaluate(map, ctx);
    assert.equal(out.result.rendered, true);
    assert.match(out.result.svg, /<svg/);
    assert.match(out.result.svg, /Checkout/); // component label rendered as text
  });

  it('honours a caller view config carried in INPUT shape (hides the evolution X axis)', async () => {
    // The value-chain producer carries renderConfig in input shape; the command
    // resolves it once (merged with avoidCollisions) and renders accordingly.
    const withView = { ...map, renderConfig: { display: { axisEvolution: false, phases: false } } };
    const out = await new RenderWardleyMapImageEmitSvgStrategy().evaluate(withView, ctx);
    assert.equal(out.result.rendered, true);
    assert.ok(!out.result.svg.includes('Genesis'), 'phase labels (evolution axis) are hidden');
    assert.ok(!out.result.svg.includes('>Evolution<'), 'evolution axis label is hidden');
    // Default render keeps the axis.
    const plain = await new RenderWardleyMapImageEmitSvgStrategy().evaluate(map, ctx);
    assert.ok(plain.result.svg.includes('Genesis'), 'axis shown by default');
  });

  it('emits no insight for a map inside the round-trippable dialect', async () => {
    const out = await new RenderWardleyMapImageEmitSvgStrategy().evaluate(map, ctx);
    assert.deepEqual(out.insights, []);
  });

  it('declares symbol-less taxonomy and label offsets as insights, one per distinct reason', async () => {
    const lossy = WardleyMapSchema.parse({
      title: 'Lossy',
      components: [
        // Two symbol-less subtypes → ONE taxonomy insight with an occurrence count.
        { id: 'a', label: { name: 'A' }, type: 'component', subtype: 'userNeed', position: { evolution: { scalar: 0.2 }, visibility: { scalar: 0.2 } } },
        { id: 'b', label: { name: 'B' }, type: 'component', subtype: 'functional', nature: 'practice', position: { evolution: { scalar: 0.4 }, visibility: { scalar: 0.4 } } },
        // Offset on an anchor: unrecoverable from the pixels, declared here.
        { id: 'c', label: { name: 'C', position: { dx: 10, dy: -8 } }, type: 'anchor', position: { evolution: { scalar: 0.6 }, visibility: { scalar: 0.6 } } },
      ],
      relations: [],
    });
    const out = await new RenderWardleyMapImageEmitSvgStrategy().evaluate(lossy, ctx);
    assert.equal(out.result.rendered, true);
    assert.deepEqual(
      out.insights.map((i) => i.text),
      [
        'component taxonomy (subtype/nature) has no distinct SVG symbol and was dropped (2 occurrences)',
        'label offsets (label.position) are not recoverable from an SVG render and were dropped',
      ],
    );
  });

  it('stays silent on market/ecosystem subtypes (their symbol is parse:svg territory)', async () => {
    const exotic = WardleyMapSchema.parse({
      title: 'Exotic',
      components: [
        { id: 'm', label: { name: 'M' }, type: 'component', subtype: 'market', position: { evolution: { scalar: 0.3 }, visibility: { scalar: 0.3 } } },
        { id: 'e', label: { name: 'E' }, type: 'component', subtype: 'ecosystem', position: { evolution: { scalar: 0.7 }, visibility: { scalar: 0.7 } } },
      ],
      relations: [],
    });
    const out = await new RenderWardleyMapImageEmitSvgStrategy().evaluate(exotic, ctx);
    assert.equal(out.result.rendered, true);
    assert.deepEqual(out.insights, []);
  });

  it('degrades gracefully on non-canonical input (mock upstream)', async () => {
    const out = await new RenderWardleyMapImageEmitSvgStrategy().evaluate(
      { mock: true, methodId: 'whatever' },
      ctx,
    );
    assert.equal(out.result.rendered, false);
    assert.equal(out.result.svg, '');
    assert.equal(out.insights.length, 1);
    assert.match(out.insights[0].text, /not a canonical WardleyMap/);
  });
});
