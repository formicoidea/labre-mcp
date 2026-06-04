// Mock strategy for `wardley:climate:simon-wardley:inertia:list` (ast-schema.md v0.1.0 § 3.4 — status: "mock").
//
// Returns deterministic test data so recipes that depend on this command
// can run end-to-end without a real implementation. The Input/Result
// shapes declared here are the I/O contract a future real strategy must
// honour when it replaces this mock.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const METHOD_ID = 'wardley:climate:simon-wardley:inertia:list';

export interface WardleyClimateSimonWardleyInertiaListInput {
  // Open shape — the real strategy will narrow this when implemented.
  // any: mock-strategy input is intentionally open
  [key: string]: unknown;
}

export interface WardleyClimateSimonWardleyInertiaListResult {
  mock: true;
  methodId: string;
  // any: mock-strategy output is intentionally open
  [key: string]: unknown;
}

export class MockWardleyClimateSimonWardleyInertiaListStrategy extends CoreBaseStrategy<WardleyClimateSimonWardleyInertiaListInput, WardleyClimateSimonWardleyInertiaListResult> {
  static get method(): string { return METHOD_ID; }

  async evaluate(
    _input: WardleyClimateSimonWardleyInertiaListInput,
    _context: RequestContext,
  ): Promise<StrategyResult<WardleyClimateSimonWardleyInertiaListResult>> {
    const capturedAt = new Date().toISOString();
    return {
      signals:   [{ name: 'mock', value: true, source: 'computed', capturedAt }],
      reasoning: [],
      insights:  [{ text: `mock strategy for ${METHOD_ID}`, by: METHOD_ID, type: 'other' }],
      result:    { mock: true, methodId: METHOD_ID },
    };
  }
}