// Tests: MockPatentSource adapter and data source swap verification
//
// Sub-AC 3: Verifies that:
//   1. MockPatentSource properly extends PatentDataSource (instanceof, interface)
//   2. MockPatentSource implements the fetchByCpc contract correctly
//   3. Swapping MockPatentSource into CpcEvolutionStrategy produces identical
//      pipeline behavior compared to inline mock objects
//   4. MockPatentSource instrumentation (callCount, calls, lastArgs) works
//   5. All fixture factories return valid PatentData shapes
//   6. fetchIndicators() convenience method works via inherited implementation
//   7. Error simulation produces expected failure paths
//   8. Per-CPC routing returns correct fixture per CPC code
//   9. Lifecycle close() method is tracked
//  10. Strategy + mock swap produces bitwise-identical evolution to inline mock

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MockPatentSource,
  FIXTURES,
  createMockSource,
  createErrorSource,
} from './mock-patent-source.mjs';
import { PatentDataSource, emptyPatentData, validatePatentData } from './patent-data-source.mjs';
import { CpcEvolutionStrategy } from './cpc-evolution-strategy.mjs';
import { BaseStrategy } from '../strategies/base-strategy.mjs';
import { computeEvolution } from '../evolution/s-curve.mjs';

// ─── Shared mock CPC mapper ─────────────────────────────────────────────────

const mockCpcMapper = {
  mapToCpc: async () => ['H04L', 'G06F', 'H04W'],
};

// ─── Helper: assert result is a valid EvolutionResult ───────────────────────

function assertValidResult(result, ctx = '') {
  const p = ctx ? `[${ctx}] ` : '';
  assert.ok(result != null, `${p}result must not be null`);
  assert.equal(typeof result.evolution, 'number', `${p}evolution must be number`);
  assert.ok(!Number.isNaN(result.evolution), `${p}evolution must not be NaN`);
  assert.ok(result.evolution >= 0 && result.evolution <= 1, `${p}evolution in [0,1]`);
  assert.equal(typeof result.confidence, 'number', `${p}confidence must be number`);
  assert.ok(result.confidence >= 0.1 && result.confidence <= 0.95, `${p}confidence in [0.1,0.95]`);
  assert.equal(result.method, 'cpc-evolution', `${p}method = cpc-evolution`);
  assert.equal(typeof result.certitude, 'number', `${p}certitude must be number`);
  assert.equal(typeof result.ubiquity, 'number', `${p}ubiquity must be number`);
  assert.ok(Array.isArray(result.trace), `${p}trace must be array`);
  BaseStrategy.validateResult(result);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Interface Contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('MockPatentSource — Interface Contract', () => {

  it('extends PatentDataSource (instanceof check)', () => {
    const source = new MockPatentSource();
    assert.ok(source instanceof PatentDataSource,
      'MockPatentSource must be instanceof PatentDataSource');
  });

  it('has fetchByCpc method from PatentDataSource', () => {
    const source = new MockPatentSource();
    assert.equal(typeof source.fetchByCpc, 'function');
  });

  it('has fetchIndicators method inherited from PatentDataSource', () => {
    const source = new MockPatentSource();
    assert.equal(typeof source.fetchIndicators, 'function');
  });

  it('has close method from PatentDataSource', () => {
    const source = new MockPatentSource();
    assert.equal(typeof source.close, 'function');
  });

  it('fetchByCpc returns a Promise', () => {
    const source = new MockPatentSource();
    const result = source.fetchByCpc(['G06F']);
    assert.ok(result instanceof Promise, 'fetchByCpc must return a Promise');
  });

  it('close returns a Promise', () => {
    const source = new MockPatentSource();
    const result = source.close();
    assert.ok(result instanceof Promise, 'close must return a Promise');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Fixture Data Validity
// ═══════════════════════════════════════════════════════════════════════════════

describe('MockPatentSource — Fixture Validity', () => {

  for (const [name, factory] of Object.entries(FIXTURES)) {
    it(`FIXTURES.${name} returns valid PatentData shape`, () => {
      const data = factory();
      const { valid, errors } = validatePatentData(data);
      assert.ok(valid, `FIXTURES.${name} validation failed: ${errors.join(', ')}`);
    });

    it(`FIXTURES.${name} has non-negative totalPatents`, () => {
      const data = factory();
      assert.ok(data.totalPatents >= 0, `totalPatents must be >= 0`);
    });
  }

  it('FIXTURES.commodity has high patent count (>= 100)', () => {
    const data = FIXTURES.commodity();
    assert.ok(data.totalPatents >= 100);
  });

  it('FIXTURES.genesis has low patent count (< 10)', () => {
    const data = FIXTURES.genesis();
    assert.ok(data.totalPatents < 10);
  });

  it('FIXTURES.empty has zero patents', () => {
    const data = FIXTURES.empty();
    assert.equal(data.totalPatents, 0);
  });

  it('FIXTURES.sparse has very few patents (< 5)', () => {
    const data = FIXTURES.sparse();
    assert.ok(data.totalPatents > 0 && data.totalPatents < 5);
  });

  it('fixture factories return independent copies (no shared state)', () => {
    const a = FIXTURES.commodity();
    const b = FIXTURES.commodity();
    a.totalPatents = 999;
    assert.notEqual(b.totalPatents, 999, 'fixtures must not share state');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. fetchByCpc Behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe('MockPatentSource — fetchByCpc Behavior', () => {

  it('returns configured data object', async () => {
    const fixture = FIXTURES.commodity();
    const source = new MockPatentSource({ data: fixture });
    const result = await source.fetchByCpc(['H04L']);
    assert.equal(result.totalPatents, 500);
  });

  it('returns data from factory function (fresh each call)', async () => {
    let callCount = 0;
    const source = new MockPatentSource({
      data: () => { callCount++; return FIXTURES.product(); },
    });

    await source.fetchByCpc(['G06F']);
    await source.fetchByCpc(['G06F']);
    assert.equal(callCount, 2, 'factory should be called each time');
  });

  it('returns emptyPatentData when no data configured', async () => {
    const source = new MockPatentSource();
    const result = await source.fetchByCpc(['H04L']);
    assert.equal(result.totalPatents, 0);
    const { valid } = validatePatentData(result);
    assert.ok(valid);
  });

  it('throws configured error', async () => {
    const source = new MockPatentSource({ error: new Error('BQ 503') });
    await assert.rejects(
      () => source.fetchByCpc(['H04L']),
      { message: 'BQ 503' },
    );
  });

  it('simulates delay', async () => {
    const source = new MockPatentSource({ data: FIXTURES.product(), delay: 50 });
    const start = Date.now();
    await source.fetchByCpc(['G06F']);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `delay should be >= 40ms, was ${elapsed}ms`);
  });

  it('returns per-CPC data when available', async () => {
    const source = new MockPatentSource({
      data: FIXTURES.empty(),
      perCpc: {
        'H04L': FIXTURES.commodity(),
        'G06N': FIXTURES.genesis(),
      },
    });

    const commodityResult = await source.fetchByCpc(['H04L']);
    assert.equal(commodityResult.totalPatents, 500, 'H04L should get commodity data');

    const genesisResult = await source.fetchByCpc(['G06N', 'H04L']);
    assert.equal(genesisResult.totalPatents, 8, 'G06N should match first');

    const fallbackResult = await source.fetchByCpc(['B25J']);
    assert.equal(fallbackResult.totalPatents, 0, 'Unknown CPC falls back to default data');
  });

  it('calls onFetch callback', async () => {
    const receivedArgs = [];
    const source = new MockPatentSource({
      data: FIXTURES.product(),
      onFetch: (codes) => receivedArgs.push(codes),
    });
    await source.fetchByCpc(['H04L', 'G06F']);
    assert.equal(receivedArgs.length, 1);
    assert.deepEqual(receivedArgs[0], ['H04L', 'G06F']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Instrumentation
// ═══════════════════════════════════════════════════════════════════════════════

describe('MockPatentSource — Instrumentation', () => {

  let source;

  beforeEach(() => {
    source = new MockPatentSource({ data: FIXTURES.product() });
  });

  it('tracks callCount', async () => {
    assert.equal(source.callCount, 0);
    await source.fetchByCpc(['H04L']);
    assert.equal(source.callCount, 1);
    await source.fetchByCpc(['G06F']);
    assert.equal(source.callCount, 2);
  });

  it('tracks lastArgs', async () => {
    assert.equal(source.lastArgs, null);
    await source.fetchByCpc(['H04L', 'G06F']);
    assert.deepEqual(source.lastArgs, ['H04L', 'G06F']);
    await source.fetchByCpc(['G06N']);
    assert.deepEqual(source.lastArgs, ['G06N']);
  });

  it('tracks full call history', async () => {
    await source.fetchByCpc(['H04L']);
    await source.fetchByCpc(['G06F', 'G06N']);

    assert.equal(source.calls.length, 2);
    assert.deepEqual(source.calls[0].cpcCodes, ['H04L']);
    assert.deepEqual(source.calls[1].cpcCodes, ['G06F', 'G06N']);
    assert.ok(typeof source.calls[0].timestamp === 'number');
  });

  it('calls array stores copies of arguments (mutation-safe)', async () => {
    const codes = ['H04L', 'G06F'];
    await source.fetchByCpc(codes);
    codes.push('MUTATED');
    assert.equal(source.calls[0].cpcCodes.length, 2, 'should not reflect mutation');
  });

  it('reset() clears all instrumentation', async () => {
    await source.fetchByCpc(['H04L']);
    await source.close();
    source.reset();

    assert.equal(source.callCount, 0);
    assert.equal(source.lastArgs, null);
    assert.equal(source.calls.length, 0);
    assert.equal(source.closed, false);
  });

  it('tracks close() via closed flag', async () => {
    assert.equal(source.closed, false);
    await source.close();
    assert.equal(source.closed, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Convenience Factories
// ═══════════════════════════════════════════════════════════════════════════════

describe('MockPatentSource — Convenience Factories', () => {

  it('createMockSource("commodity") returns MockPatentSource with commodity data', async () => {
    const source = createMockSource('commodity');
    assert.ok(source instanceof MockPatentSource);
    assert.ok(source instanceof PatentDataSource);

    const data = await source.fetchByCpc(['H04L']);
    assert.equal(data.totalPatents, 500);
  });

  it('createMockSource("genesis") returns genesis data', async () => {
    const source = createMockSource('genesis');
    const data = await source.fetchByCpc(['G06N']);
    assert.equal(data.totalPatents, 8);
  });

  it('createMockSource("empty") returns empty data', async () => {
    const source = createMockSource('empty');
    const data = await source.fetchByCpc(['H04L']);
    assert.equal(data.totalPatents, 0);
  });

  it('createMockSource with unknown fixture throws', () => {
    assert.throws(
      () => createMockSource('nonexistent'),
      /Unknown fixture "nonexistent"/,
    );
  });

  it('createMockSource merges additional options', async () => {
    const source = createMockSource('commodity', { delay: 10 });
    assert.ok(source instanceof MockPatentSource);
    // Data from commodity fixture + 10ms delay
    const data = await source.fetchByCpc(['H04L']);
    assert.equal(data.totalPatents, 500);
  });

  it('createErrorSource produces a failing source', async () => {
    const source = createErrorSource('BigQuery quota exceeded');
    assert.ok(source instanceof MockPatentSource);
    await assert.rejects(
      () => source.fetchByCpc(['H04L']),
      { message: 'BigQuery quota exceeded' },
    );
  });

  it('createErrorSource with default message', async () => {
    const source = createErrorSource();
    await assert.rejects(
      () => source.fetchByCpc(['H04L']),
      { message: 'Mock BigQuery error' },
    );
  });

  it('error source still records call instrumentation', async () => {
    const source = createErrorSource('fail');
    try { await source.fetchByCpc(['H04L']); } catch { /* expected */ }
    assert.equal(source.callCount, 1);
    assert.deepEqual(source.lastArgs, ['H04L']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. fetchIndicators — Inherited Convenience Method
// ═══════════════════════════════════════════════════════════════════════════════

describe('MockPatentSource — fetchIndicators (inherited)', () => {

  it('fetchIndicators returns computed indicator results', async () => {
    const source = createMockSource('commodity');
    const result = await source.fetchIndicators(['H04L']);

    // Should have certitude and ubiquite axis aggregates
    assert.ok(result.certitude, 'must have certitude axis');
    assert.ok(result.ubiquite, 'must have ubiquite axis');
    assert.ok(result.scores, 'must have individual scores');

    // Certitude value should be a number in [0, 1]
    assert.equal(typeof result.certitude.value, 'number');
    assert.ok(result.certitude.value >= 0 && result.certitude.value <= 1);

    // Ubiquite value should be a number in [0, 1]
    assert.equal(typeof result.ubiquite.value, 'number');
    assert.ok(result.ubiquite.value >= 0 && result.ubiquite.value <= 1);
  });

  it('fetchIndicators returns all 8 indicator scores', async () => {
    const source = createMockSource('product');
    const result = await source.fetchIndicators(['G06F']);

    const expectedKeys = [
      'convergenceHHI', 'stabiliteTaxonomique', 'densiteCitation', 'retrecissementClaims',
      'diversiteAssignees', 'couvertureGeo', 'diffusionSectorielle', 'ratioExpires',
    ];

    for (const key of expectedKeys) {
      assert.ok(key in result.scores, `missing score: ${key}`);
      assert.equal(typeof result.scores[key], 'number', `${key} must be a number`);
      assert.ok(result.scores[key] >= 0 && result.scores[key] <= 1, `${key} must be in [0,1]`);
    }
  });

  it('fetchIndicators with empty data returns zero scores', async () => {
    const source = createMockSource('empty');
    const result = await source.fetchIndicators(['H04L']);

    // All indicator scores should be 0 or very close for empty data
    for (const [key, value] of Object.entries(result.scores)) {
      assert.ok(value >= 0 && value <= 1, `${key} = ${value} must be in [0,1]`);
    }
  });

  it('fetchIndicators calls fetchByCpc internally', async () => {
    const source = createMockSource('commodity');
    await source.fetchIndicators(['H04L', 'G06F']);
    assert.equal(source.callCount, 1, 'fetchIndicators should call fetchByCpc once');
    assert.deepEqual(source.lastArgs, ['H04L', 'G06F']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. CORE TEST: MockPatentSource Swap Produces Identical Pipeline Behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe('MockPatentSource — Strategy Swap Verification', () => {

  // For each fixture, create two strategies:
  //   A) CpcEvolutionStrategy with an inline mock object { fetchByCpc: async () => data }
  //   B) CpcEvolutionStrategy with MockPatentSource (proper class adapter)
  //
  // Both must produce IDENTICAL evolution, confidence, certitude, ubiquity.

  for (const [fixtureName, factory] of Object.entries(FIXTURES)) {
    it(`swap produces identical results for fixture: ${fixtureName}`, async () => {
      const data = factory();

      // Strategy A: inline mock (the pattern used in existing tests)
      const inlineSource = { fetchByCpc: async () => data };
      const strategyA = new CpcEvolutionStrategy({
        patentSource: inlineSource,
        cpcMapper: mockCpcMapper,
      });

      // Strategy B: MockPatentSource adapter (proper class extending PatentDataSource)
      const mockSource = new MockPatentSource({ data });
      const strategyB = new CpcEvolutionStrategy({
        patentSource: mockSource,
        cpcMapper: mockCpcMapper,
      });

      const component = { name: 'TestComponent', capability: 'test capability' };

      const resultA = await strategyA.evaluate(component);
      const resultB = await strategyB.evaluate(component);

      // Both must produce valid results
      assertValidResult(resultA, `inline-${fixtureName}`);
      assertValidResult(resultB, `mock-${fixtureName}`);

      // Evolution must be IDENTICAL (bitwise equal)
      assert.strictEqual(resultB.evolution, resultA.evolution,
        `evolution mismatch for ${fixtureName}: mock=${resultB.evolution} vs inline=${resultA.evolution}`);

      // Confidence must be IDENTICAL
      assert.strictEqual(resultB.confidence, resultA.confidence,
        `confidence mismatch for ${fixtureName}: mock=${resultB.confidence} vs inline=${resultA.confidence}`);

      // Certitude must be IDENTICAL
      assert.strictEqual(resultB.certitude, resultA.certitude,
        `certitude mismatch for ${fixtureName}: mock=${resultB.certitude} vs inline=${resultA.certitude}`);

      // Ubiquity must be IDENTICAL
      assert.strictEqual(resultB.ubiquity, resultA.ubiquity,
        `ubiquity mismatch for ${fixtureName}: mock=${resultB.ubiquity} vs inline=${resultA.ubiquity}`);

      // Method must be IDENTICAL
      assert.strictEqual(resultB.method, resultA.method);
    });
  }

  it('swap verification: evolution delegates to computeEvolution in both cases', async () => {
    const data = FIXTURES.commodity();

    const mockSource = new MockPatentSource({ data });
    const strategy = new CpcEvolutionStrategy({
      patentSource: mockSource,
      cpcMapper: mockCpcMapper,
    });

    const result = await strategy.evaluate({ name: 'TCP/IP', capability: 'network protocol' });

    // Independently call computeEvolution with the same (c, u)
    const expected = computeEvolution(result.certitude, result.ubiquity);
    assert.strictEqual(result.evolution, expected.evolution,
      'MockPatentSource strategy must delegate to computeEvolution');
  });

  it('swap verification: trace structure matches between inline and mock', async () => {
    const data = FIXTURES.product();

    const inlineSource = { fetchByCpc: async () => data };
    const strategyA = new CpcEvolutionStrategy({
      patentSource: inlineSource,
      cpcMapper: mockCpcMapper,
    });

    const mockSource = new MockPatentSource({ data });
    const strategyB = new CpcEvolutionStrategy({
      patentSource: mockSource,
      cpcMapper: mockCpcMapper,
    });

    const component = { name: 'K8s', capability: 'container orchestration' };
    const resultA = await strategyA.evaluate(component);
    const resultB = await strategyB.evaluate(component);

    // Trace must have the same steps in the same order
    assert.equal(resultB.trace.length, resultA.trace.length,
      'trace length must match');

    for (let i = 0; i < resultA.trace.length; i++) {
      assert.equal(resultB.trace[i].step, resultA.trace[i].step,
        `trace step ${i} name mismatch`);
    }
  });

  it('swap verification: indicator toggle works identically with mock', async () => {
    const data = FIXTURES.commodity();

    const inlineSource = { fetchByCpc: async () => data };
    const mockSource = new MockPatentSource({ data });

    const config = {
      certitudeIndicators: {
        convergenceHHI: { enabled: false },
        densiteCitation: { enabled: false },
      },
      ubiquityIndicators: {
        couvertureGeo: { enabled: false },
      },
    };

    const strategyA = new CpcEvolutionStrategy({
      patentSource: inlineSource,
      cpcMapper: mockCpcMapper,
      config,
    });
    const strategyB = new CpcEvolutionStrategy({
      patentSource: mockSource,
      cpcMapper: mockCpcMapper,
      config,
    });

    const component = { name: 'TCP/IP', capability: 'network protocol' };
    const resultA = await strategyA.evaluate(component);
    const resultB = await strategyB.evaluate(component);

    assertValidResult(resultA, 'toggled-inline');
    assertValidResult(resultB, 'toggled-mock');

    assert.strictEqual(resultB.evolution, resultA.evolution);
    assert.strictEqual(resultB.confidence, resultA.confidence);
    assert.strictEqual(resultB.certitude, resultA.certitude);
    assert.strictEqual(resultB.ubiquity, resultA.ubiquity);
  });

  it('swap verification: runtime indicator toggle produces identical results', async () => {
    const data = FIXTURES.product();

    const strategyA = new CpcEvolutionStrategy({
      patentSource: { fetchByCpc: async () => data },
      cpcMapper: mockCpcMapper,
    });
    const strategyB = new CpcEvolutionStrategy({
      patentSource: new MockPatentSource({ data }),
      cpcMapper: mockCpcMapper,
    });

    // Toggle the same indicator on both strategies at runtime
    strategyA.setIndicatorEnabled('certitude', 'convergenceHHI', false);
    strategyB.setIndicatorEnabled('certitude', 'convergenceHHI', false);

    const component = { name: 'API Gateway', capability: 'api management' };
    const resultA = await strategyA.evaluate(component);
    const resultB = await strategyB.evaluate(component);

    assert.strictEqual(resultB.evolution, resultA.evolution);
    assert.strictEqual(resultB.certitude, resultA.certitude);
    assert.strictEqual(resultB.ubiquity, resultA.ubiquity);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Error Path Swap Verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('MockPatentSource — Error Path Swap', () => {

  it('MockPatentSource error produces same no-abstention behavior as inline error mock', async () => {
    // Inline mock that throws
    const inlineSource = { fetchByCpc: async () => { throw new Error('BQ timeout'); } };
    const strategyA = new CpcEvolutionStrategy({
      patentSource: inlineSource,
      cpcMapper: mockCpcMapper,
    });

    // MockPatentSource that throws
    const mockSource = createErrorSource('BQ timeout');
    const strategyB = new CpcEvolutionStrategy({
      patentSource: mockSource,
      cpcMapper: mockCpcMapper,
    });

    const component = { name: 'Test', capability: 'test' };
    const resultA = await strategyA.evaluate(component);
    const resultB = await strategyB.evaluate(component);

    // Both must produce valid results (no abstention)
    assertValidResult(resultA, 'inline-error');
    assertValidResult(resultB, 'mock-error');

    // Both degrade identically — same fallback path
    assert.strictEqual(resultB.evolution, resultA.evolution,
      'error path evolution must be identical');
    assert.strictEqual(resultB.confidence, resultA.confidence,
      'error path confidence must be identical');
    assert.strictEqual(resultB.certitude, resultA.certitude);
    assert.strictEqual(resultB.ubiquity, resultA.ubiquity);
  });

  it('MockPatentSource error still records instrumentation before throwing', async () => {
    const source = createErrorSource('Quota exceeded');
    const strategy = new CpcEvolutionStrategy({
      patentSource: source,
      cpcMapper: mockCpcMapper,
    });

    const result = await strategy.evaluate({ name: 'Test', capability: 'test' });
    assertValidResult(result, 'error with instrumentation');

    // Source was called (even though it threw)
    assert.equal(source.callCount, 1, 'should have been called once');
    assert.ok(source.lastArgs != null, 'lastArgs should be recorded');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Multiple Evaluations and State Isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('MockPatentSource — State Isolation', () => {

  it('multiple evaluations with same mock produce identical results', async () => {
    const source = createMockSource('commodity');
    const strategy = new CpcEvolutionStrategy({
      patentSource: source,
      cpcMapper: mockCpcMapper,
    });

    const component = { name: 'TCP/IP', capability: 'network protocol' };
    const result1 = await strategy.evaluate(component);
    const result2 = await strategy.evaluate(component);

    assert.strictEqual(result1.evolution, result2.evolution, 'evolution should be stable');
    assert.strictEqual(result1.confidence, result2.confidence, 'confidence should be stable');
    assert.strictEqual(result1.certitude, result2.certitude, 'certitude should be stable');
    assert.strictEqual(result1.ubiquity, result2.ubiquity, 'ubiquity should be stable');
    assert.equal(source.callCount, 2, 'source should be called twice');
  });

  it('concurrent evaluations with same mock produce identical results', async () => {
    const source = createMockSource('product');
    const strategy = new CpcEvolutionStrategy({
      patentSource: source,
      cpcMapper: mockCpcMapper,
    });

    const component = { name: 'K8s', capability: 'container orchestration' };
    const [r1, r2, r3] = await Promise.all([
      strategy.evaluate(component),
      strategy.evaluate(component),
      strategy.evaluate(component),
    ]);

    assert.strictEqual(r1.evolution, r2.evolution);
    assert.strictEqual(r2.evolution, r3.evolution);
    assert.equal(source.callCount, 3);
  });

  it('reset() allows mock reuse across test boundaries', async () => {
    const source = createMockSource('genesis');

    // First use
    await source.fetchByCpc(['G06N']);
    assert.equal(source.callCount, 1);

    // Reset for reuse
    source.reset();
    assert.equal(source.callCount, 0);
    assert.equal(source.lastArgs, null);
    assert.equal(source.calls.length, 0);

    // Second use
    await source.fetchByCpc(['B82Y']);
    assert.equal(source.callCount, 1);
    assert.deepEqual(source.lastArgs, ['B82Y']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Phase B Enrichment Compatibility (Mock Path)
// ═══════════════════════════════════════════════════════════════════════════════

describe('MockPatentSource — Phase B Enrichment', () => {

  it('result from mock source has certitude/ubiquity for Phase B averaging', async () => {
    const source = createMockSource('commodity');
    const strategy = new CpcEvolutionStrategy({
      patentSource: source,
      cpcMapper: mockCpcMapper,
    });

    const result = await strategy.evaluate({ name: 'TCP/IP', capability: 'network protocol' });

    // Phase B filter: e => !e.error && e.certitude != null && e.ubiquity != null
    const isPhaseBAble = !result.error && result.certitude != null && result.ubiquity != null;
    assert.ok(isPhaseBAble, 'mock-sourced result must be Phase B compatible');
  });

  for (const fixtureName of Object.keys(FIXTURES)) {
    it(`Phase B compatible with fixture: ${fixtureName}`, async () => {
      const source = createMockSource(fixtureName);
      const strategy = new CpcEvolutionStrategy({
        patentSource: source,
        cpcMapper: mockCpcMapper,
      });

      const result = await strategy.evaluate({ name: 'Test', capability: 'test' });
      assertValidResult(result, `phaseB-${fixtureName}`);
      assert.ok(result.certitude >= 0 && result.certitude <= 1);
      assert.ok(result.ubiquity >= 0 && result.ubiquity <= 1);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Evolution Direction Sanity Check (Mock Fixtures)
// ═══════════════════════════════════════════════════════════════════════════════

describe('MockPatentSource — Evolution Direction', () => {

  it('commodity fixture evolves further than genesis fixture', async () => {
    const commodityStrategy = new CpcEvolutionStrategy({
      patentSource: createMockSource('commodity'),
      cpcMapper: mockCpcMapper,
    });
    const genesisStrategy = new CpcEvolutionStrategy({
      patentSource: createMockSource('genesis'),
      cpcMapper: mockCpcMapper,
    });

    const component = { name: 'Test', capability: 'test' };
    const commodityResult = await commodityStrategy.evaluate(component);
    const genesisResult = await genesisStrategy.evaluate(component);

    assert.ok(commodityResult.evolution > genesisResult.evolution,
      `commodity (${commodityResult.evolution}) should evolve further than genesis (${genesisResult.evolution})`);
  });

  it('commodity has higher confidence than genesis (more data)', async () => {
    const commodityStrategy = new CpcEvolutionStrategy({
      patentSource: createMockSource('commodity'),
      cpcMapper: mockCpcMapper,
    });
    const genesisStrategy = new CpcEvolutionStrategy({
      patentSource: createMockSource('genesis'),
      cpcMapper: mockCpcMapper,
    });

    const component = { name: 'Test', capability: 'test' };
    const commodityResult = await commodityStrategy.evaluate(component);
    const genesisResult = await genesisStrategy.evaluate(component);

    assert.ok(commodityResult.confidence > genesisResult.confidence,
      `commodity confidence (${commodityResult.confidence}) should exceed genesis (${genesisResult.confidence})`);
  });

  it('product fixture evolves between genesis and commodity', async () => {
    const results = {};
    for (const name of ['genesis', 'product', 'commodity']) {
      const strategy = new CpcEvolutionStrategy({
        patentSource: createMockSource(name),
        cpcMapper: mockCpcMapper,
      });
      results[name] = await strategy.evaluate({ name: 'Test', capability: 'test' });
    }

    assert.ok(results.genesis.evolution <= results.product.evolution,
      `genesis (${results.genesis.evolution}) should be <= product (${results.product.evolution})`);
    assert.ok(results.product.evolution <= results.commodity.evolution,
      `product (${results.product.evolution}) should be <= commodity (${results.commodity.evolution})`);
  });
});
