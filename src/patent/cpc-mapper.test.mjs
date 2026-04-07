// Test: CPC Mapper — progressive discovery through CPC hierarchy
//
// Verifies the cascading resolution strategy:
//   1. Progressive discovery (LLM + taxonomy cache)
//   2. LLM fallback (no cache)
//   3. Ultimate default: ['G06F']

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidCpcCode,
  CPC_CODE_REGEX,
  mapCapabilityToCPC,
  mapComponentToCpc,
  llmPickClass,
  llmPickFromList,
  llmFallbackMapping,
  progressiveDiscovery,
  formatCount,
  ULTIMATE_DEFAULT_CODES,
} from './cpc-mapper.mjs';

// ─── Mock helpers ───────────────────────────────────────────────────────────

function mockLlm(response) {
  return async () => response;
}

function mockLlmSequence(responses) {
  let callIndex = 0;
  return async () => {
    const response = responses[callIndex] || responses[responses.length - 1];
    callIndex++;
    return response;
  };
}

function mockTaxonomyCache(data = {}) {
  return {
    getSubclasses: async (code) => data[code] || [],
    getGroups: async (code) => data[code] || [],
    getSubgroups: async (code) => data[code] || [],
  };
}

// ─── isValidCpcCode ─────────────────────────────────────────────────────────

describe('isValidCpcCode', () => {
  it('accepts 4-char subclass codes', () => {
    assert.ok(isValidCpcCode('G06F'));
    assert.ok(isValidCpcCode('H04L'));
    assert.ok(isValidCpcCode('A61K'));
  });

  it('accepts group codes (subclass + digits + slash)', () => {
    assert.ok(isValidCpcCode('G06F9/'));
    assert.ok(isValidCpcCode('H04L67/'));
    assert.ok(isValidCpcCode('A61K31/'));
  });

  it('accepts full subgroup codes', () => {
    assert.ok(isValidCpcCode('G06F9/455'));
    assert.ok(isValidCpcCode('G06F9/45558'));
    assert.ok(isValidCpcCode('H04L67/10'));
  });

  it('rejects invalid codes', () => {
    assert.ok(!isValidCpcCode(''));
    assert.ok(!isValidCpcCode('G06'));
    assert.ok(!isValidCpcCode('Z06F'));
    assert.ok(!isValidCpcCode('G06f'));
    assert.ok(!isValidCpcCode(null));
    assert.ok(!isValidCpcCode(42));
    assert.ok(!isValidCpcCode('G06F 9/455'));
  });
});

// ─── formatCount ────────────────────────────────────────────────────────────

describe('formatCount', () => {
  it('formats millions', () => assert.equal(formatCount(8780599), '8.8M'));
  it('formats thousands', () => assert.equal(formatCount(50000), '50K'));
  it('formats small numbers', () => assert.equal(formatCount(42), '42'));
});

// ─── llmPickClass ───────────────────────────────────────────────────────────

describe('llmPickClass', () => {
  it('extracts 3-char class code from LLM response', async () => {
    const result = await llmPickClass('container orchestration', mockLlm('G06'));
    assert.equal(result, 'G06');
  });

  it('extracts class from verbose response', async () => {
    const result = await llmPickClass('test', mockLlm('The most relevant class is G06.'));
    assert.equal(result, 'G06');
  });

  it('returns null for garbage response', async () => {
    const result = await llmPickClass('test', mockLlm('I dont know'));
    assert.equal(result, null);
  });
});

// ─── llmPickFromList ────────────────────────────────────────────────────────

describe('llmPickFromList', () => {
  it('returns selected codes that exist in the list', async () => {
    const entries = [
      { code: 'G06F', cnt: 8780599 },
      { code: 'G06N', cnt: 507836 },
      { code: 'G06Q', cnt: 2633447 },
    ];
    const result = await llmPickFromList('AI', entries, mockLlm('G06N'));
    assert.deepEqual(result, ['G06N']);
  });

  it('handles multi-select', async () => {
    const entries = [
      { code: 'G06F9/', cnt: 939043 },
      { code: 'G06F16/', cnt: 1201612 },
      { code: 'G06F3/', cnt: 2104238 },
    ];
    const result = await llmPickFromList('data processing', entries, mockLlm('G06F9/\nG06F16/'));
    assert.deepEqual(result, ['G06F9/', 'G06F16/']);
  });

  it('returns single entry list without LLM call', async () => {
    const entries = [{ code: 'G06F', cnt: 100 }];
    let called = false;
    const result = await llmPickFromList('test', entries, async () => { called = true; return ''; });
    assert.deepEqual(result, ['G06F']);
    assert.ok(!called);
  });

  it('returns empty for empty list', async () => {
    const result = await llmPickFromList('test', [], mockLlm('G06F'));
    assert.deepEqual(result, []);
  });

  it('filters out codes not in the list', async () => {
    const entries = [
      { code: 'G06F', cnt: 100 },
      { code: 'G06N', cnt: 50 },
    ];
    const result = await llmPickFromList('test', entries, mockLlm('H04L'));
    assert.deepEqual(result, []);
  });

  it('caps at 3 results', async () => {
    const entries = [
      { code: 'A', cnt: 1 }, { code: 'B', cnt: 1 },
      { code: 'C', cnt: 1 }, { code: 'D', cnt: 1 },
    ];
    const result = await llmPickFromList('test', entries, mockLlm('A\nB\nC\nD'));
    assert.ok(result.length <= 3);
  });
});

// ─── progressiveDiscovery ───────────────────────────────────────────────────

describe('progressiveDiscovery', () => {
  it('discovers codes through full hierarchy', async () => {
    const cache = mockTaxonomyCache({
      'G06': [{ code: 'G06F', cnt: 8780599 }, { code: 'G06N', cnt: 507836 }],
      'G06F': [{ code: 'G06F9/', cnt: 939043 }, { code: 'G06F3/', cnt: 2104238 }],
      'G06F9/': [{ code: 'G06F9/455', cnt: 64647 }, { code: 'G06F9/50', cnt: 24327 }],
    });

    const llm = mockLlmSequence(['G06', 'G06F', 'G06F9/', 'G06F9/455']);
    const result = await progressiveDiscovery('container orchestration', llm, cache);
    assert.ok(result.length > 0);
    assert.ok(result.includes('G06F9/455'));
  });

  it('stops at subclass level when no groups available', async () => {
    const cache = mockTaxonomyCache({
      'G06': [{ code: 'G06F', cnt: 100 }],
      'G06F': [],
    });

    const llm = mockLlmSequence(['G06', 'G06F']);
    const result = await progressiveDiscovery('test', llm, cache);
    assert.deepEqual(result, ['G06F']);
  });

  it('stops at group level when no subgroups available', async () => {
    const cache = mockTaxonomyCache({
      'G06': [{ code: 'G06F', cnt: 100 }],
      'G06F': [{ code: 'G06F9/', cnt: 50 }],
      'G06F9/': [],
    });

    const llm = mockLlmSequence(['G06', 'G06F', 'G06F9/']);
    const result = await progressiveDiscovery('test', llm, cache);
    assert.deepEqual(result, ['G06F9/']);
  });

  it('returns empty when LLM fails to pick class', async () => {
    const cache = mockTaxonomyCache({});
    const result = await progressiveDiscovery('test', mockLlm('dunno'), cache);
    assert.deepEqual(result, []);
  });

  it('returns empty when no subclasses exist', async () => {
    const cache = mockTaxonomyCache({ 'G06': [] });
    const result = await progressiveDiscovery('test', mockLlm('G06'), cache);
    assert.deepEqual(result, []);
  });
});

// ─── mapCapabilityToCPC (main API) ──────────────────────────────────────────

describe('mapCapabilityToCPC', () => {
  it('returns 1-5 codes (never empty)', async () => {
    const result = await mapCapabilityToCPC('container orchestration', {
      llmCall: mockLlm('G06F'),
    });
    assert.ok(result.length >= 1);
    assert.ok(result.length <= 5);
  });

  it('uses progressive discovery when cache provided', async () => {
    const cache = mockTaxonomyCache({
      'G06': [{ code: 'G06F', cnt: 100 }],
      'G06F': [{ code: 'G06F9/', cnt: 50 }],
      'G06F9/': [{ code: 'G06F9/455', cnt: 30 }],
    });

    const result = await mapCapabilityToCPC('container orchestration', {
      llmCall: mockLlmSequence(['G06', 'G06F', 'G06F9/', 'G06F9/455']),
      taxonomyCache: cache,
    });
    assert.ok(result.includes('G06F9/455'));
  });

  it('falls back to LLM-only when no cache', async () => {
    const result = await mapCapabilityToCPC('container orchestration', {
      llmCall: mockLlm('G06F\nH04L'),
    });
    assert.ok(result.includes('G06F'));
  });

  it('returns ultimate default for empty input', async () => {
    const result = await mapCapabilityToCPC('', {
      llmCall: mockLlm('G06F'),
    });
    assert.deepEqual(result, ['G06F']);
  });

  it('returns ultimate default when everything fails', async () => {
    const result = await mapCapabilityToCPC('test', {
      llmCall: async () => { throw new Error('LLM down'); },
    });
    assert.deepEqual(result, ULTIMATE_DEFAULT_CODES);
  });

  it('never throws', async () => {
    const result = await mapCapabilityToCPC('test', {
      llmCall: async () => { throw new Error('fail'); },
      taxonomyCache: {
        getSubclasses: async () => { throw new Error('cache fail'); },
        getGroups: async () => { throw new Error('cache fail'); },
        getSubgroups: async () => { throw new Error('cache fail'); },
      },
    });
    assert.ok(Array.isArray(result));
    assert.ok(result.length >= 1);
  });
});

// ─── mapComponentToCpc ──────────────────────────────────────────────────────

describe('mapComponentToCpc', () => {
  it('uses component.capability when available', async () => {
    const result = await mapComponentToCpc(
      { name: 'K8s', capability: 'container orchestration' },
      mockLlm('G06F'),
    );
    assert.ok(result.length >= 1);
  });

  it('falls back to component.name', async () => {
    const result = await mapComponentToCpc(
      { name: 'Kubernetes' },
      mockLlm('G06F'),
    );
    assert.ok(result.length >= 1);
  });

  it('passes taxonomyCache through options', async () => {
    const cache = mockTaxonomyCache({
      'G06': [{ code: 'G06F', cnt: 100 }],
      'G06F': [],
    });

    const result = await mapComponentToCpc(
      { name: 'test', capability: 'test' },
      mockLlmSequence(['G06', 'G06F']),
      { taxonomyCache: cache },
    );
    assert.deepEqual(result, ['G06F']);
  });
});
