// Mocks shape conformance test (CP10).
//
// Verifies that every mock strategy registered via registerMocks() returns
// a well-formed StrategyResult with the canonical mock signal and the
// expected result envelope.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy, StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { registerMocks } from './mocks-registry.mjs';

const ctx: RequestContext = {
  projectId: 'test',
  projectRoot: '/tmp/test',
  sessionId: 'session',
  domain: 'wardley',
};

describe('mocks-registry', () => {
  it('registers the full v0.1.0 mock catalogue (66 entries)', () => {
    const registry = new StrategyRegistry<BaseStrategy>();
    registerMocks(registry);
    assert.equal(registry.size(), 66);
  });

  it('every registered mock returns a conformant StrategyResult', async () => {
    const registry = new StrategyRegistry<BaseStrategy>();
    registerMocks(registry);
    for (const methodId of registry.list()) {
      const StrategyClass = registry.get(methodId);
      const strategy = new (StrategyClass as unknown as new () => BaseStrategy)();
      // any: mocks have open input shape
      const out = (await strategy.evaluate({}, ctx)) as StrategyResult<{ mock: true; methodId: string }>;

      assert.ok(Array.isArray(out.signals),   `${methodId}: signals must be an array`);
      assert.ok(Array.isArray(out.reasoning), `${methodId}: reasoning must be an array`);
      assert.ok(Array.isArray(out.insights),  `${methodId}: insights must be an array`);
      assert.ok(out.result,                   `${methodId}: result must be present`);

      // The mock signal is the marker that disambiguates mock output from real.
      const mockSignal = out.signals.find((s) => s.name === 'mock');
      assert.ok(mockSignal, `${methodId}: signals must include the mock=true marker`);
      assert.equal(mockSignal.value, true, `${methodId}: mock signal value must be true`);

      // The result envelope echoes the methodId so callers can attribute output.
      assert.equal(out.result.mock,     true,     `${methodId}: result.mock must be true`);
      assert.equal(out.result.methodId, methodId, `${methodId}: result.methodId mismatch`);
    }
  });
});
