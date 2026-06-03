import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { PositionedValueChain } from '#types/value-chain.mjs';
import { registerCommonStrategies } from './registry.mjs';
import { PlaceLabelsStrategy } from './layout/write/place-labels-strategy.mjs';
import { OverlapCheckStrategy } from './layout/quality/overlap-check-strategy.mjs';

const ctx: RequestContext = {
  projectId: 'test',
  projectRoot: '/tmp/test',
  sessionId: 'session',
  domain: 'wardley',
};

function sampleChain(): PositionedValueChain {
  return {
    metadata: {
      title: 'Sample chain',
      angle: '',
      scope: '',
      objective: '',
      imperatives: [],
      temporality: 'present',
      contextSummary: '',
    },
    components: [
      {
        name: 'Anchor',
        type: 'component',
        role: 'anchor',
        visibility: 0.95,
        evolution: 0.5,
        label: { dx: 0, dy: 0 },
      },
      {
        name: 'A',
        type: 'component',
        role: 'capability',
        visibility: 0.5,
        evolution: 0.3,
        label: { dx: 0, dy: 0 },
      },
    ],
    links: [{ from: 'Anchor', to: 'A' }],
  };
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
    const out = await new PlaceLabelsStrategy().evaluate({ chain: sampleChain() }, ctx);
    for (const c of out.result.chain.components) {
      assert.ok(typeof c.label.dx === 'number');
      assert.ok(typeof c.label.dy === 'number');
    }
    assert.equal(out.result.chain.components.length, 2);
  });

  it('throws on missing chain input', async () => {
    // any: deliberate invalid input to verify the guard
    await assert.rejects(() => new PlaceLabelsStrategy().evaluate({} as any, ctx));
  });
});

describe('common registry — OverlapCheckStrategy', () => {
  it('reports unresolved overlap counts for a small chain', async () => {
    const out = await new OverlapCheckStrategy().evaluate({ chain: sampleChain() }, ctx);
    assert.equal(typeof out.result.unresolvedHard, 'number');
    assert.equal(typeof out.result.unresolvedSpacing, 'number');
    assert.equal(typeof out.result.unresolvedEdge, 'number');
    assert.equal(typeof out.result.unresolvedAxis, 'number');
    assert.equal(typeof out.result.iterations, 'number');
  });

  it('throws on missing chain input', async () => {
    // any: deliberate invalid input to verify the guard
    await assert.rejects(() => new OverlapCheckStrategy().evaluate({} as any, ctx));
  });
});
