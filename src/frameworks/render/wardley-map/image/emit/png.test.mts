import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RenderWardleyMapImageEmitPngStrategy } from './png.mjs';
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

// The 8-byte PNG signature (89 50 4E 47 0D 0A 1A 0A) base64-encodes to a string
// starting with `iVBORw0KGgo`.
const PNG_BASE64_MAGIC = 'iVBORw0KGgo';

describe('render:wardley-map:image:emit:png (real, renderer package)', () => {
  it('renders a canonical WardleyMap to PNG bytes via renderToPNG', async () => {
    const out = await new RenderWardleyMapImageEmitPngStrategy().evaluate(map, ctx);
    assert.equal(out.result.rendered, true);
    assert.ok(out.result.pngBase64.length > 0, 'base64 payload is not empty');
    assert.ok(
      out.result.pngBase64.startsWith(PNG_BASE64_MAGIC),
      `expected a PNG signature, got ${out.result.pngBase64.slice(0, 16)}`,
    );
    // Round-trips back to bytes carrying the raw PNG magic number.
    const bytes = Buffer.from(out.result.pngBase64, 'base64');
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const byteLength = out.signals.find((s) => s.name === 'byteLength');
    assert.equal(byteLength?.value, bytes.byteLength);
  });

  it('honours a caller view config carried in INPUT shape (hides the evolution X axis)', async () => {
    // The value-chain producer carries renderConfig in input shape; the command
    // strips it before validating the geometry (an unstripped renderConfig would
    // fail the schema and degrade to rendered:false) and resolves it once.
    const withView = { ...map, renderConfig: { display: { axisEvolution: false, phases: false } } };
    const out = await new RenderWardleyMapImageEmitPngStrategy().evaluate(withView, ctx);
    assert.equal(out.result.rendered, true);
    assert.ok(out.result.pngBase64.startsWith(PNG_BASE64_MAGIC));

    // Hiding the evolution axis + phase labels changes the raster: the bytes must
    // differ from the default render (which draws the axis).
    const plain = await new RenderWardleyMapImageEmitPngStrategy().evaluate(map, ctx);
    assert.equal(plain.result.rendered, true);
    assert.notEqual(out.result.pngBase64, plain.result.pngBase64);
  });

  it('degrades gracefully on non-canonical input (mock upstream)', async () => {
    const out = await new RenderWardleyMapImageEmitPngStrategy().evaluate(
      { mock: true, methodId: 'whatever' },
      ctx,
    );
    assert.equal(out.result.rendered, false);
    assert.equal(out.result.pngBase64, '');
    assert.equal(out.insights.length, 1);
    assert.match(out.insights[0].text, /not a canonical WardleyMap/);
  });
});
