// Unit tests for response-formatter pure functions.
// Migrated from the former self-test block in response-formatter.mts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evolutionToStage,
  formatConfidence,
  strategyReasoning,
  formatStrategyResult,
  formatResponse,
} from './response-formatter.mjs';

describe('response-formatter — evolutionToStage', () => {
  it('maps 0.0 → Genesis', () => {
    assert.equal(evolutionToStage(0).name, 'Genesis');
  });
  it('maps 0.1 → Genesis', () => {
    assert.equal(evolutionToStage(0.1).name, 'Genesis');
  });
  it('maps 0.17 → Custom-Built (range boundary is inclusive lower)', () => {
    assert.equal(evolutionToStage(0.17).name, 'Custom-Built');
  });
  it('maps 0.3 → Custom-Built', () => {
    assert.equal(evolutionToStage(0.3).name, 'Custom-Built');
  });
  it('maps 0.55 → Product (+rental)', () => {
    assert.equal(evolutionToStage(0.55).name, 'Product (+rental)');
  });
  it('maps 0.85 → Commodity (+utility)', () => {
    assert.equal(evolutionToStage(0.85).name, 'Commodity (+utility)');
  });
  it('maps 1.0 (out-of-range upper edge) → Commodity', () => {
    assert.equal(evolutionToStage(1.0).name, 'Commodity (+utility)');
  });
  it('returns a position string with 3 decimals', () => {
    assert.equal(evolutionToStage(0.55).position, '0.550');
  });
});

describe('response-formatter — formatConfidence', () => {
  it('0.1 → Very low', () => {
    assert.equal(formatConfidence(0.1).label, 'Very low');
  });
  it('0.3 → Low', () => {
    assert.equal(formatConfidence(0.3).label, 'Low');
  });
  it('0.5 → Moderate', () => {
    assert.equal(formatConfidence(0.5).label, 'Moderate');
  });
  it('0.7 → High', () => {
    assert.equal(formatConfidence(0.7).label, 'High');
  });
  it('0.85 → Very high', () => {
    assert.equal(formatConfidence(0.85).label, 'Very high');
  });
  it('bar is exactly 10 characters', () => {
    for (const c of [0.0, 0.25, 0.5, 0.85, 1.0]) {
      assert.equal(formatConfidence(c).bar.length, 10);
    }
  });
  it('percentage is rounded', () => {
    assert.equal(formatConfidence(0.853).percentage, '85%');
  });
});

describe('response-formatter — strategyReasoning', () => {
  const component = { name: 'ERP', certitude: 0.9, ubiquity: 0.85 };
  const result = { evolution: 0.75, confidence: 0.85, method: 'write:capacity:s-curve' };

  it('s-curve reasoning mentions certitude and ubiquity', () => {
    const r = strategyReasoning('write:capacity:s-curve', result, component);
    assert.ok(r.includes('0.90'));
    assert.ok(r.includes('0.85'));
    assert.ok(r.includes('Commodity'));
  });

  it('publication-analysis reasoning mentions the stage', () => {
    const r = strategyReasoning('write:capacity:publication-analysis', result, component);
    assert.ok(r.includes('Commodity'));
  });

  it('unknown strategy falls back to generic format', () => {
    const r = strategyReasoning('brand-new-strat', result, component);
    assert.ok(r.includes('brand-new-strat'));
    assert.ok(r.includes('Commodity'));
  });
});

describe('response-formatter — formatStrategyResult', () => {
  it('renders error as warning', () => {
    const out = formatStrategyResult('write:capacity:llm-direct', { error: 'not configured' });
    assert.ok(out.includes('⚠️'));
    assert.ok(out.includes('not configured'));
  });

  it('renders success with evolution, confidence, reasoning', () => {
    const out = formatStrategyResult(
      'write:capacity:s-curve',
      { evolution: 0.75, confidence: 0.85, method: 'write:capacity:s-curve' },
      { name: 'ERP', certitude: 0.9, ubiquity: 0.85 },
    );
    assert.ok(out.includes('Evolution'));
    assert.ok(out.includes('Confidence'));
    assert.ok(out.includes('Commodity'));
  });
});

describe('response-formatter — formatResponse', () => {
  it('renders economic response with evaluations', () => {
    const result = {
      classification: { space: 'economic', reason: 'economic', requiresReQuestion: false },
      evaluations: {
        'write:capacity:s-curve': { evolution: 0.75, confidence: 0.85, method: 'write:capacity:s-curve' },
      },
      parsedInput: { name: 'ERP', certitude: 0.9, ubiquity: 0.85 },
    };
    const out = formatResponse(result);
    assert.ok(out.includes('ERP'));
    assert.ok(out.includes('Economic Space'));
    assert.ok(out.includes('write:capacity:s-curve'));
  });

  it('renders re-questioning block for social_good', () => {
    const result = {
      classification: { space: 'social_good', reason: 'air', requiresReQuestion: true },
      reQuestions: ['Did you mean bottled oxygen?'],
      parsedInput: { name: 'Air' },
    };
    const out = formatResponse(result);
    assert.ok(out.includes('Outside Economic Space'));
    assert.ok(out.includes('social good'));
    assert.ok(out.includes('bottled oxygen'));
  });

  it('renders compact table when compact=true', () => {
    const result = {
      classification: { space: 'economic', reason: 'e', requiresReQuestion: false },
      evaluations: {
        'write:capacity:s-curve': { evolution: 0.75, confidence: 0.85, method: 'write:capacity:s-curve' },
      },
      parsedInput: { name: 'ERP' },
    };
    const out = formatResponse(result, { compact: true });
    assert.ok(out.includes('| Strategy |'));
  });

  it('renders error block when all strategies failed', () => {
    const result = {
      classification: { space: 'economic', reason: 'e', requiresReQuestion: false },
      evaluations: {
        'write:capacity:llm-direct': { error: 'not configured' },
      },
      parsedInput: { name: 'Widget' },
    };
    const out = formatResponse(result);
    assert.ok(out.includes('No Successful Evaluations'));
  });
});
