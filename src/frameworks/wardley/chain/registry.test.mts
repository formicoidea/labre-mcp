import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '#lib/prompts/init.mjs';
import { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';
import { registerChainStrategies } from './registry.mjs';
import { TopDownChainStrategyCore } from './_legacy/write/chain/strategies/top-down/top-down-strategy.mjs';

describe('chain registry — registration surface', () => {
  it('registers the chain strategies under their 5-segment methodIds', () => {
    const registry = new StrategyRegistry<BaseStrategy>();
    registerChainStrategies(registry);
    // OWM parse/emit moved to the render registry (canonical-boundary strategies).
    assert.equal(registry.size(), 4);
    assert.equal(registry.has('wardley:map:basemap:generate:default'), true);
    assert.equal(registry.has('wardley:map:value-chain:generate:top-down'), true);
    assert.equal(registry.has('wardley:map:value-chain:organized-y-position:default'), true);
    assert.equal(registry.has('wardley:map:value-chain:select-by-type:component'), true);
  });

  it('TopDownChainStrategyCore.method returns the 5-segment id', () => {
    assert.equal(TopDownChainStrategyCore.method, 'wardley:map:value-chain:generate:top-down');
  });
});
