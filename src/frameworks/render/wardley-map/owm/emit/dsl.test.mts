import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RenderWardleyMapOwmEmitDslStrategy } from './dsl.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx: RequestContext = { projectId: 'p', projectRoot: '/tmp/p', sessionId: 's', domain: 'render' };

const emit = new RenderWardleyMapOwmEmitDslStrategy();

const map = WardleyMapSchema.parse({
  title: 'Online payments',
  components: [
    {
      id: 'merchant',
      label: { name: 'Merchant' },
      type: 'anchor',
      position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.05 } },
    },
    {
      id: 'checkout',
      label: { name: 'Checkout', position: { dx: -40, dy: 5 } },
      type: 'component',
      position: { evolution: { scalar: 0.6 }, visibility: { scalar: 0.3 } },
    },
  ],
  relations: [{ id: 'rel-1', consumer: 'merchant', supplier: 'checkout' }],
});

describe('render:wardley-map:owm:emit:dsl (real, deterministic)', () => {
  it('emits title, anchor, component and link lines in declaration order', async () => {
    const out = await emit.evaluate(map, ctx);
    assert.equal(out.result.emitted, true);
    assert.deepEqual(out.result.dsl.split('\n'), [
      'title Online payments',
      // visibility is FLIPPED: canonical 0.05 (near the top) → OWM 0.95.
      'anchor Merchant [0.95, 0.5]',
      'component Checkout [0.7, 0.6] label [-40, 5]',
      'Merchant->Checkout',
    ]);
  });

  it('flips the visibility axis at both extremes and keeps evolution verbatim', async () => {
    const extremes = WardleyMapSchema.parse({
      title: 'Extremes',
      components: [
        { id: 'top', label: { name: 'Top' }, type: 'component', position: { evolution: { scalar: 0 }, visibility: { scalar: 0 } } },
        { id: 'bottom', label: { name: 'Bottom' }, type: 'component', position: { evolution: { scalar: 1 }, visibility: { scalar: 1 } } },
      ],
      relations: [],
    });
    const out = await emit.evaluate(extremes, ctx);
    assert.match(out.result.dsl, /^component Top \[1, 0\]$/m);
    assert.match(out.result.dsl, /^component Bottom \[0, 1\]$/m);
  });

  it('wraps names longer than 4 words in quotes with a `\\n` break, consistently in declarations and links', async () => {
    const wordy = WardleyMapSchema.parse({
      title: 'Wordy',
      components: [
        { id: 'a', label: { name: 'Accept card payments on the checkout page' }, type: 'anchor', position: { evolution: { scalar: 0.2 }, visibility: { scalar: 0.1 } } },
        { id: 'b', label: { name: 'Card Network' }, type: 'component', position: { evolution: { scalar: 0.9 }, visibility: { scalar: 0.8 } } },
      ],
      relations: [{ id: 'rel-1', consumer: 'a', supplier: 'b' }],
    });
    const out = await emit.evaluate(wordy, ctx);
    // 7 words → break after ceil(7/2) = 4.
    const formatted = '"Accept card payments on \\n the checkout page"';
    assert.ok(out.result.dsl.includes(`anchor ${formatted} [0.9, 0.2]`), out.result.dsl);
    // The link MUST reuse the exact same spelling or the OWM parser cannot match it.
    assert.ok(out.result.dsl.includes(`${formatted}->Card Network`), out.result.dsl);
  });

  it('reports non-projectable canonical data as insights but still emits', async () => {
    const rich = WardleyMapSchema.parse({
      title: 'Rich',
      components: [
        {
          id: 'anchor-with-offset',
          label: { name: 'User', position: { dx: 3, dy: 4 } },
          type: 'anchor',
          position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0 } },
        },
        {
          id: 'cap',
          label: { name: 'Capability' },
          type: 'component',
          subtype: 'functional',
          nature: 'activity',
          description: 'does things',
          position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.5 } },
        },
      ],
      relations: [{ id: 'rel-1', consumer: 'anchor-with-offset', supplier: 'ghost' }],
      context: 'some context',
    });
    const out = await emit.evaluate(rich, ctx);
    assert.equal(out.result.emitted, true);
    // The anchor keeps NO label directive (the OWM anchor grammar has none).
    assert.match(out.result.dsl, /^anchor User \[1, 0\.5\]$/m);
    // The dangling relation is dropped, not emitted.
    assert.ok(!out.result.dsl.includes('->'), out.result.dsl);
    const texts = out.insights.map((i) => i.text).join('\n');
    assert.match(texts, /anchor label offsets/);
    assert.match(texts, /subtype\/nature/);
    assert.match(texts, /descriptions/);
    assert.match(texts, /unknown component id/);
    assert.match(texts, /`context`/);
  });

  it('degrades gracefully on non-canonical input (mock upstream)', async () => {
    const out = await emit.evaluate({ mock: true, methodId: 'whatever' }, ctx);
    assert.equal(out.result.emitted, false);
    assert.equal(out.result.dsl, '');
    assert.equal(out.insights.length, 1);
    assert.match(out.insights[0].text, /not a canonical WardleyMap/);
  });

  it('degrades gracefully on a label OWM cannot carry (> 500 chars)', async () => {
    const huge = WardleyMapSchema.parse({
      title: 'Huge',
      components: [
        { id: 'x', label: { name: 'x'.repeat(501) }, type: 'component', position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.5 } } },
      ],
      relations: [],
    });
    const out = await emit.evaluate(huge, ctx);
    assert.equal(out.result.emitted, false);
    assert.equal(out.result.dsl, '');
    assert.match(out.insights[0].text, /exceeds 500 characters/);
  });
});
