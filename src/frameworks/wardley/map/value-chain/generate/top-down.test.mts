import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Side-effect: register the write-chain prompt parsers used by the LLM steps.
import '#lib/prompts/init.mjs';
import { WardleyMapValueChainGenerateTopDownStrategy } from './top-down.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx = {} as RequestContext;

// A stubbed two-call llmCall: call #1 (extract-metadata) returns a key=value
// block; call #2 (generate-chain) returns the raw value-chain JSON. The order
// mirrors the strategy's fixed call sequence.
function makeStubLlm(): (p: string, v?: unknown, o?: unknown) => Promise<string> {
  let call = 0;
  const metadata = [
    'title=Online tea shop',
    'angle=operational',
    'scope=the shop',
    'objective=serve tea online',
    'imperatives=none',
    'temporality=present',
    'contextSummary=An online tea shop',
  ].join('\n');
  const chain = JSON.stringify({
    components: [
      { name: 'User', type: 'anchor', role: 'anchor', xHint: 0.5 },
      { name: 'Tea ordering', type: 'component', role: 'need', xHint: 0.55 },
      { name: 'Payment', type: 'component', role: 'capability', xHint: 0.7 },
    ],
    links: [
      { from: 'User', to: 'Tea ordering' },
      { from: 'Tea ordering', to: 'Payment' },
    ],
  });
  return async () => (call++ === 0 ? metadata : chain);
}

// A basemap WardleyMap (the recipe's previous step output) carrying the prompt.
const basemap = WardleyMapSchema.parse({
  title: 'Draw the value chain of an online tea shop',
  components: [],
  relations: [],
});

describe('wardley:map:value-chain:generate:top-down', () => {
  it('fills a basemap into a canonical WardleyMap consumable by the next step', async () => {
    const strategy = new WardleyMapValueChainGenerateTopDownStrategy({ llmCall: makeStubLlm() });
    const { result } = await strategy.evaluate(basemap, ctx);

    // The output is itself a canonical WardleyMap (the interchange contract).
    const map = WardleyMapSchema.parse(result);
    assert.equal(map.components.length, 3);
    assert.equal(map.relations.length, 2);

    const anchor = map.components.find((c) => c.type === 'anchor');
    assert.ok(anchor, 'an anchor component is present');
    // Anchor sits at the TOP → small visibility scalar (renderer convention).
    assert.ok(anchor!.position.visibility.scalar < 0.2, 'anchor near the top');

    // A deeper component sits lower on the canvas than the anchor.
    const payment = map.components.find((c) => c.label.name === 'Payment');
    assert.ok(payment, 'Payment component is present');
    assert.ok(
      payment!.position.visibility.scalar > anchor!.position.visibility.scalar,
      'deeper component is below the anchor',
    );

    // X is a readability layout in [0.1, 0.9] — never 0/1 evolution extremes.
    for (const c of map.components) {
      assert.ok(c.position.evolution.scalar >= 0.1 && c.position.evolution.scalar <= 0.9);
    }

    // Relations are id-based and resolve to real components (renderer-valid).
    const ids = new Set(map.components.map((c) => c.id));
    for (const r of map.relations) {
      assert.ok(ids.has(r.consumer) && ids.has(r.supplier));
    }
  });

  it('bakes the value-chain view into the artefact: evolution X axis hidden', async () => {
    const strategy = new WardleyMapValueChainGenerateTopDownStrategy({ llmCall: makeStubLlm() });
    const { result } = await strategy.evaluate(basemap, ctx);
    // The view is carried in INPUT shape so it survives the layout steps untouched.
    const rc = (result as { renderConfig?: { display?: { axisEvolution?: boolean; phases?: boolean } } }).renderConfig;
    assert.equal(rc?.display?.axisEvolution, false, 'evolution (X) axis hidden by default');
    assert.equal(rc?.display?.phases, false, 'evolution phase bands hidden by default');
  });

  it('degrades gracefully when the input is not a canonical WardleyMap', async () => {
    const strategy = new WardleyMapValueChainGenerateTopDownStrategy({ llmCall: makeStubLlm() });
    const { result, insights } = await strategy.evaluate({ not: 'a map' }, ctx);
    assert.equal(WardleyMapSchema.parse(result).components.length, 0);
    assert.ok(insights.some((i) => i.text.includes('not a canonical WardleyMap')));
  });
});
