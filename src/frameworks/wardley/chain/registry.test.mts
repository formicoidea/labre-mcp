import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '#lib/prompts/init.mjs';
import { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { PositionedValueChain } from '#types/value-chain.mjs';
import { registerChainStrategies } from './registry.mjs';
import { TopDownChainStrategyCore } from './_legacy/write/chain/strategies/top-down/top-down-strategy.mjs';
import { OwmParserStrategy } from './read/map/owm-parser-strategy.mjs';
import { OwmEmitStrategy } from './emit/owm/owm-emit-strategy.mjs';

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

describe('chain registry — registration surface', () => {
  it('registers the chain strategies under their 5-segment methodIds', () => {
    const registry = new StrategyRegistry<BaseStrategy>();
    registerChainStrategies(registry);
    assert.equal(registry.size(), 6);
    assert.equal(registry.has('render:wardley-map:owm:parse:dsl'), true);
    assert.equal(registry.has('render:wardley-map:owm:emit:dsl'), true);
    assert.equal(registry.has('wardley:map:basemap:generate:default'), true);
    assert.equal(registry.has('wardley:map:value-chain:generate:top-down'), true);
    assert.equal(registry.has('wardley:map:value-chain:organized-y-position:default'), true);
    assert.equal(registry.has('wardley:map:value-chain:select-by-type:component'), true);
  });

  it('TopDownChainStrategyCore.method returns the 5-segment id', () => {
    assert.equal(TopDownChainStrategyCore.method, 'wardley:map:value-chain:generate:top-down');
  });
});

describe('chain registry — OwmParserStrategy', () => {
  it('parses a minimal OWM DSL and exposes title + componentCount', async () => {
    const dsl = 'title Sample\ncomponent A [0.5, 0.3]';
    const out = await new OwmParserStrategy().evaluate({ dsl }, ctx);
    assert.equal(out.result.title, 'Sample');
    assert.equal(typeof out.result.map, 'object');
    assert.ok(out.result.componentCount >= 1);
    assert.ok(out.signals.length >= 1);
  });

  it('throws on missing dsl input', async () => {
    // any: deliberate invalid input to verify the guard
    await assert.rejects(() => new OwmParserStrategy().evaluate({} as any, ctx));
  });
});

describe('chain registry — OwmEmitStrategy', () => {
  it('emits an OWM DSL string from a positioned chain', async () => {
    const out = await new OwmEmitStrategy().evaluate({ chain: sampleChain() }, ctx);
    assert.equal(typeof out.result.dsl, 'string');
    assert.ok(out.result.dsl.includes('title Sample chain'));
    assert.ok(out.signals.find((s) => s.name === 'component-count'));
  });

  it('throws on missing chain input', async () => {
    // any: deliberate invalid input to verify the guard
    await assert.rejects(() => new OwmEmitStrategy().evaluate({} as any, ctx));
  });
});
