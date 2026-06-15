import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WardleyMapBasemapGenerateDefaultStrategy } from './default.mjs';
import { RenderWardleyMapImageEmitSvgStrategy } from '#frameworks/render/wardley-map/image/emit/svg.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx: RequestContext = { projectId: 'p', projectRoot: '/tmp/p', sessionId: 's', domain: 'wardley' };

describe('wardley:map:basemap:generate:default (real, renderer schema)', () => {
  it('produces a canonical WardleyMap skeleton from a prompt + context', async () => {
    const out = await new WardleyMapBasemapGenerateDefaultStrategy().evaluate(
      { prompt: 'CSRD reporting for mid-caps', context: { purpose: 'risk analysis' } },
      ctx,
    );
    WardleyMapSchema.parse(out.result); // valid canonical map
    assert.equal(out.result.title, 'CSRD reporting for mid-caps');
    assert.equal(out.result.context, 'risk analysis'); // map.context is a string
    assert.deepEqual(out.result.components, []);
  });

  it('falls back to a default title when nothing usable is given', async () => {
    const out = await new WardleyMapBasemapGenerateDefaultStrategy().evaluate({}, ctx);
    assert.equal(out.result.title, 'Untitled map');
  });

  it('chains into image:emit:svg through the canonical type (two real strategies)', async () => {
    const basemap = await new WardleyMapBasemapGenerateDefaultStrategy().evaluate(
      { prompt: 'Online payments' },
      ctx,
    );
    const render = await new RenderWardleyMapImageEmitSvgStrategy().evaluate(basemap.result, ctx);
    assert.equal(render.result.rendered, true);
    assert.match(render.result.svg, /<svg/);
  });
});
