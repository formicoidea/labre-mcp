// Mock strategy for `wardley:gameplay:wiki:list:list-view` (ast-schema.md v0.1.0 § 3.4 — status: "mock").
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

const METHOD_ID = 'wardley:gameplay:wiki:list:list-view';

export interface WardleyGameplayWikiListListViewInput {
  // Open shape — the real strategy will narrow this when implemented.
  // any: mock-strategy input is intentionally open
  [key: string]: unknown;
}

export interface WardleyGameplayWikiListListViewResult {
  mock: true;
  methodId: string;
  // any: mock-strategy output is intentionally open
  [key: string]: unknown;
}

export class MockWardleyGameplayWikiListListViewStrategy extends CoreBaseStrategy<WardleyGameplayWikiListListViewInput, WardleyGameplayWikiListListViewResult> {
  static get method(): string { return METHOD_ID; }

  async evaluate(
    _input: WardleyGameplayWikiListListViewInput,
    _context: RequestContext,
  ): Promise<StrategyResult<WardleyGameplayWikiListListViewResult>> {
    const capturedAt = new Date().toISOString();
    return {
      signals:   [{ name: 'mock', value: true, source: 'computed', capturedAt }],
      reasoning: [],
      insights:  [{ text: `mock strategy for ${METHOD_ID}`, by: METHOD_ID, type: 'other' }],
      result:    { mock: true, methodId: METHOD_ID },
    };
  }
}