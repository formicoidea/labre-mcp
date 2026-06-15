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
