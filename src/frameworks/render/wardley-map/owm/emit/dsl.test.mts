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
    // `context` is emitted as a header comment right after the title, not lost.
    assert.match(out.result.dsl, /^\/\/ context: some context$/m);
    const texts = out.insights.map((i) => i.text).join('\n');
    assert.match(texts, /anchor label offsets/);
    assert.match(texts, /subtype\/nature/);
    assert.match(texts, /descriptions/);
    assert.match(texts, /unknown component id/);
    assert.ok(!texts.includes('`context`'), texts);
  });

  it('emits market/ecosystem subtypes as inline decorators instead of declaring a loss', async () => {
    const typed = WardleyMapSchema.parse({
      title: 'Typed',
      components: [
        {
          id: 'cloud',
          label: { name: 'Cloud' },
          type: 'component',
          subtype: 'market',
          position: { evolution: { scalar: 0.7 }, visibility: { scalar: 0.4 } },
        },
        {
          id: 'store',
          label: { name: 'AppStore', position: { dx: 10, dy: -5 } },
          type: 'component',
          subtype: 'ecosystem',
          position: { evolution: { scalar: 0.65 }, visibility: { scalar: 0.35 } },
        },
        {
          id: 'need',
          label: { name: 'Need' },
          type: 'component',
          subtype: 'userNeed',
          position: { evolution: { scalar: 0.2 }, visibility: { scalar: 0.1 } },
        },
      ],
      relations: [],
    });
    const out = await emit.evaluate(typed, ctx);
    assert.deepEqual(out.result.dsl.split('\n'), [
      'title Typed',
      'component Cloud [0.6, 0.7] (market)',
      'component AppStore [0.65, 0.65] label [10, -5] (ecosystem)',
      'component Need [0.9, 0.2]',
    ]);
    // Only `userNeed` — the subtype with no OWM spelling — is declared lost.
    const texts = out.insights.map((i) => i.text).join('\n');
    assert.match(texts, /subtype\/nature/);
    assert.ok(!/occurrences/.test(texts), texts);
  });

  it('groups a subtype and a method decorator in ONE parenthesis pair', async () => {
    // The vendored detection compares indexOf('(') / indexOf(')') against the
    // keyword position, and indexOf returns the FIRST paren of each kind — so
    // `(market) (buy)` would read as market alone. One group, both keywords.
    const both = WardleyMapSchema.parse({
      title: 'Both',
      components: [
        {
          id: 'cloud',
          label: { name: 'Cloud' },
          type: 'component',
          subtype: 'market',
          method: { category: 'buying-policy', recommendation: 'buy' },
          inertia: true,
          position: { evolution: { scalar: 0.7 }, visibility: { scalar: 0.4 } },
        },
      ],
      relations: [],
    });
    const out = await emit.evaluate(both, ctx);
    assert.match(out.result.dsl, /^component Cloud \[0\.6, 0\.7\] \(market, buy\) inertia$/m);
    assert.deepEqual(out.insights, []);
  });

  it('drops a market subtype it cannot carry (anchor, pipeline) with an insight', async () => {
    const hostile = WardleyMapSchema.parse({
      title: 'Hostile',
      components: [
        {
          id: 'pipe',
          label: { name: 'Pipe' },
          // A `pipeline` companion line makes parse re-type the component, and
          // the canonical pipeline subtype set excludes market/ecosystem.
          type: 'component',
          subtype: 'market',
          pipelineGeometry: { evoStart: 0.4, evoEnd: 0.8, visStart: 0.5, visEnd: 0.5 },
          position: { evolution: { scalar: 0.6 }, visibility: { scalar: 0.5 } },
        },
      ],
      relations: [],
    });
    const out = await emit.evaluate(hostile, ctx);
    assert.ok(!out.result.dsl.includes('(market)'), out.result.dsl);
    assert.match(out.result.dsl, /^pipeline Pipe \[0\.4, 0\.8\]$/m);
    assert.ok(out.insights.some((i) => i.text.includes('subtype/nature')));
  });

  it('refuses evolve companion lines the vendored grammar would misread (B1/B2)', async () => {
    const mkMap = (name: string, evoTarget: number) => WardleyMapSchema.parse({
      title: 'Guard',
      components: [
        { id: 'http', label: { name: 'HTTP' }, type: 'component', position: { evolution: { scalar: 0.2 }, visibility: { scalar: 0.5 } } },
        {
          id: 'target', label: { name }, type: 'component',
          position: { evolution: { scalar: 0.4 }, visibility: { scalar: 0.6 } },
          evolvesTo: [{ position: { evolution: { scalar: evoTarget }, visibility: { scalar: 0.6 } } }],
        },
      ],
      relations: [],
    });

    // B1: a decimal embedded in the name would rebind the evolve to "HTTP".
    const decimal = await emit.evaluate(mkMap('HTTP 1.1 Gateway', 0.8), ctx);
    assert.ok(!decimal.result.dsl.includes('evolve'), decimal.result.dsl);
    assert.ok(decimal.insights.some((i) => i.text.includes('embeds a decimal number')));

    // Quote-wrapped names cannot be referenced by an evolve line at all.
    const wrapped = await emit.evaluate(mkMap('A very long component name indeed', 0.8), ctx);
    assert.ok(!wrapped.result.dsl.includes('evolve'), wrapped.result.dsl);
    assert.ok(wrapped.insights.some((i) => i.text.includes('quote-wrapped')));

    // B2: maturity 1 must carry a decimal point or the vendored pattern drops it.
    const one = await emit.evaluate(mkMap('Kettle', 1), ctx);
    assert.match(one.result.dsl, /^evolve Kettle 1\.0$/m);
  });

  it('never emits an empty `// context:` header (B2) and notes non-natural evolveType', async () => {
    const map = WardleyMapSchema.parse({
      title: 'T',
      context: '',
      components: [
        {
          id: 'a', label: { name: 'A' }, type: 'component',
          position: { evolution: { scalar: 0.3 }, visibility: { scalar: 0.4 } },
          evolvesTo: [{ position: { evolution: { scalar: 0.6 }, visibility: { scalar: 0.4 } }, evolveType: 'forced' }],
        },
      ],
      relations: [],
    });
    const out = await emit.evaluate(map, ctx);
    assert.ok(!out.result.dsl.includes('// context:'), out.result.dsl);
    const texts = out.insights.map((i) => i.text).join('\n');
    assert.match(texts, /empty map `context` not emitted/);
    assert.match(texts, /evolveType "forced"/);
  });

  it('drops a custom phase nomenclature that is not exactly 4 labels (B3)', async () => {
    const base = WardleyMapSchema.parse({ title: 'T', components: [], relations: [] });
    const out = await emit.evaluate(
      { ...base, renderConfig: { style: { background: { phases: { default: { labels: [{ text: 'A' }, { text: 'B' }] } } } } } },
      ctx,
    );
    assert.ok(!out.result.dsl.includes('evolution '), out.result.dsl);
    assert.ok(out.insights.some((i) => i.text.includes('round-trips only with exactly 4')));
  });

  it('flags labels containing OWM decorator keywords (substring detection hazard)', async () => {
    const map = WardleyMapSchema.parse({
      title: 'T',
      components: [
        { id: 'x', label: { name: 'inertia dampener' }, type: 'component', position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.5 } } },
      ],
      relations: [],
    });
    const out = await emit.evaluate(map, ctx);
    assert.ok(out.insights.some((i) => i.text.includes('decorator keywords')));
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
