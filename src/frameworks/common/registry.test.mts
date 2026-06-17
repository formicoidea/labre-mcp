import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import { registerCommonStrategies } from './registry.mjs';
import { PlaceLabelsStrategy } from './layout/write/place-labels-strategy.mjs';
import { OverlapCheckStrategy } from './layout/quality/overlap-check-strategy.mjs';

const ctx: RequestContext = {
  projectId: 'test',
  projectRoot: '/tmp/test',
  sessionId: 'session',
  domain: 'wardley',
};

function sampleMap(): WardleyMap {
  return WardleyMapSchema.parse({
    title: 'Sample map',
    components: [
      {
        id: 'anchor',
        label: { name: 'Anchor', position: { dx: 0, dy: 0 } },
        type: 'anchor',
        position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.05 } },
      },
      {
        id: 'capability-a',
        label: { name: 'A', position: { dx: 0, dy: 0 } },
        type: 'component',
        subtype: 'functional',
        position: { evolution: { scalar: 0.3 }, visibility: { scalar: 0.5 } },
      },
    ],
    relations: [{ id: 'r1', consumer: 'anchor', supplier: 'capability-a' }],
  });
}

describe('common registry — registration surface', () => {
  it('registers the layout strategies under wardley:map:value-chain:* methodIds', () => {
    const registry = new StrategyRegistry<BaseStrategy>();
    registerCommonStrategies(registry);
    assert.equal(registry.size(), 2);
    assert.equal(registry.has('wardley:map:value-chain:prevent-collision:default'), true);
    assert.equal(registry.has('wardley:map:value-chain:audit:overlap-check'), true);
  });
});

describe('common registry — PlaceLabelsStrategy', () => {
  it('assigns a label offset to every component', async () => {
    const out = await new PlaceLabelsStrategy().evaluate(sampleMap(), ctx);
    const parsed = WardleyMapSchema.parse(out.result);
    for (const c of parsed.components) {
      assert.equal(c.label.position, undefined);
    }
    assert.equal(parsed.components.length, 2);
  });

  it('degrades on missing map input', async () => {
    // any: deliberate invalid input to verify the guard
    const out = await new PlaceLabelsStrategy().evaluate({} as any, ctx);
    assert.equal(out.result.components.length, 0);
    assert.ok(out.insights.some((i) => i.text.includes('not a canonical WardleyMap')));
  });
});

describe('common registry — OverlapCheckStrategy', () => {
  it('reports unresolved overlap counts for a small chain', async () => {
    const out = await new OverlapCheckStrategy().evaluate(sampleMap(), ctx);
    assert.ok(out.result);
    assert.equal(typeof out.result.unresolvedHard, 'number');
    assert.equal(typeof out.result.unresolvedSpacing, 'number');
    assert.equal(typeof out.result.unresolvedEdge, 'number');
    assert.equal(typeof out.result.unresolvedAxis, 'number');
    assert.equal(typeof out.result.iterations, 'number');
  });

  it('degrades on missing map input', async () => {
    // any: deliberate invalid input to verify the guard
    const out = await new OverlapCheckStrategy().evaluate({} as any, ctx);
    assert.equal(out.result, null);
    assert.ok(out.insights.some((i) => i.text.includes('not a canonical WardleyMap')));
  });
});
