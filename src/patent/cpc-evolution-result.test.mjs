// Test: CPC Evolution Strategy produces correct EvolutionResult shape
//
// Validates AC 2: Strategy produces EvolutionResult with
// evolution, confidence, method:'cpc-evolution', certitude, ubiquity, and trace fields.
//
// Uses mock PatentDataSource and CPC mapper to isolate the strategy
// from BigQuery and LLM dependencies.

import assert from 'node:assert/strict';
import { BaseStrategy } from '../strategies/base-strategy.mjs';
import { CpcEvolutionStrategy } from './cpc-evolution-strategy.mjs';
import {
  computeDataQuality,
  computeModelConfidence,
  computeConfidence,
  renormalizeWeights,
  aggregateAxis,
  mergeIndicatorConfig,
} from './cpc-evolution-strategy.mjs';

// ── Mock fixtures ──────────────────────────────────────────────────────────

/** Mock CPC mapper that returns hardcoded CPC codes */
const mockCpcMapper = {
  mapToCpc: async (component) => ['H04L', 'G06F', 'H04W'],
};

/** Mock patent data representing a mature technology (>100 patents) */
const MOCK_PATENT_DATA_RICH = {
  totalPatents: 250,
  patents: [],
  // Data for patent-indicators.mjs computeAllIndicators
  cpcDistribution: [
    { cpc: 'H04L', count: 150 },
    { cpc: 'G06F', count: 70 },
    { cpc: 'H04W', count: 30 },
  ],
  yearlyClassifications: [
    { year: 2019, cpcCodes: ['H04L', 'G06F'] },
    { year: 2020, cpcCodes: ['H04L', 'G06F', 'H04W'] },
    { year: 2021, cpcCodes: ['H04L', 'G06F', 'H04W'] },
    { year: 2022, cpcCodes: ['H04L', 'G06F', 'H04W'] },
  ],
  citationData: { totalForwardCitations: 3000, patentCount: 250 },
  claimsTimeline: [
    { year: 2018, avgIndependentClaims: 8.5 },
    { year: 2020, avgIndependentClaims: 6.0 },
    { year: 2022, avgIndependentClaims: 4.2 },
  ],
  assigneeData: { uniqueAssignees: 85, totalPatents: 250 },
  geoData: { jurisdictionCount: 5, jurisdictions: ['US', 'EP', 'CN', 'JP', 'KR'] },
  sectorData: { uniqueSections: 3, uniqueClasses: 12 },
  filingTimeline: [
    { year: 2018, count: 30 },
    { year: 2019, count: 45 },
    { year: 2020, count: 60 },
    { year: 2021, count: 70 },
    { year: 2022, count: 85 },
  ],
};

/** Mock patent data representing a nascent technology (<10 patents) */
const MOCK_PATENT_DATA_SPARSE = {
  totalPatents: 5,
  patents: [],
  cpcDistribution: [{ cpc: 'G06N', count: 5 }],
  yearlyClassifications: [
    { year: 2022, cpcCodes: ['G06N'] },
  ],
  citationData: { totalForwardCitations: 3, patentCount: 5 },
  claimsTimeline: [{ year: 2022, avgIndependentClaims: 12 }],
  assigneeData: { uniqueAssignees: 3, totalPatents: 5 },
  geoData: { jurisdictionCount: 1, jurisdictions: ['US'] },
  sectorData: { uniqueSections: 1, uniqueClasses: 1 },
  filingTimeline: [{ year: 2022, count: 5 }],
};

/** Mock patent data for empty result */
const MOCK_PATENT_DATA_EMPTY = {
  totalPatents: 0,
  patents: [],
};

/** Create a mock patent source that returns the given data */
function createMockPatentSource(data) {
  return {
    fetchByCpc: async (_cpcCodes) => data,
  };
}

// ── Test component fixtures ────────────────────────────────────────────────

const COMPONENT_FULL = {
  name: 'TCP/IP Networking',
  capability: 'network protocol stack',
  description: 'Standard internet communication protocols',
  nature: 'activite',
};

const COMPONENT_MINIMAL = {
  name: 'Quantum Computing',
};

// ── Test helpers ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${err.message}`);
    if (err.stack) {
      const lines = err.stack.split('\n').slice(1, 3);
      for (const line of lines) console.error(`    ${line.trim()}`);
    }
    failed++;
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== AC 2: EvolutionResult Shape Tests ===\n');

  // ── 1. Strategy identity ───────────────────────────────────────────────

  console.log('Strategy Identity:');

  await runTest('static method returns "cpc-evolution"', () => {
    assert.equal(CpcEvolutionStrategy.method, 'cpc-evolution');
  });

  await runTest('extends BaseStrategy', () => {
    assert.ok(CpcEvolutionStrategy.prototype instanceof BaseStrategy);
  });

  await runTest('constructor accepts optional patentSource (lazy-loaded)', () => {
    // Strategy supports lazy-loading of dependencies — no throw on missing patentSource
    const strategy = new CpcEvolutionStrategy({ cpcMapper: mockCpcMapper });
    assert.ok(strategy instanceof CpcEvolutionStrategy);
  });

  await runTest('constructor accepts optional cpcMapper (lazy-loaded)', () => {
    // Strategy supports lazy-loading of dependencies — no throw on missing cpcMapper
    const strategy = new CpcEvolutionStrategy({ patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH) });
    assert.ok(strategy instanceof CpcEvolutionStrategy);
  });

  await runTest('constructor accepts no arguments (full lazy-load)', () => {
    const strategy = new CpcEvolutionStrategy();
    assert.ok(strategy instanceof CpcEvolutionStrategy);
  });

  // ── 2. EvolutionResult shape with rich data ────────────────────────────

  console.log('\nEvolutionResult Shape (rich data, >100 patents):');

  await runTest('result has all 6 required fields', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });

    const result = await strategy.evaluate(COMPONENT_FULL);

    // All 6 fields must be present
    assert.ok('evolution' in result, 'missing evolution field');
    assert.ok('confidence' in result, 'missing confidence field');
    assert.ok('method' in result, 'missing method field');
    assert.ok('certitude' in result, 'missing certitude field');
    assert.ok('ubiquity' in result, 'missing ubiquity field');
    assert.ok('trace' in result, 'missing trace field');
  });

  await runTest('evolution is a number in [0, 1]', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_FULL);

    assert.equal(typeof result.evolution, 'number');
    assert.ok(!Number.isNaN(result.evolution));
    assert.ok(result.evolution >= 0 && result.evolution <= 1,
      `evolution ${result.evolution} should be in [0, 1]`);
  });

  await runTest('confidence is a number bounded [0.1, 0.95]', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_FULL);

    assert.equal(typeof result.confidence, 'number');
    assert.ok(!Number.isNaN(result.confidence));
    assert.ok(result.confidence >= 0.1, `confidence ${result.confidence} should be >= 0.1`);
    assert.ok(result.confidence <= 0.95, `confidence ${result.confidence} should be <= 0.95`);
  });

  await runTest('method is "cpc-evolution"', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_FULL);

    assert.equal(result.method, 'cpc-evolution');
  });

  await runTest('certitude is a number in [0, 1]', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_FULL);

    assert.equal(typeof result.certitude, 'number');
    assert.ok(!Number.isNaN(result.certitude));
    assert.ok(result.certitude >= 0 && result.certitude <= 1,
      `certitude ${result.certitude} should be in [0, 1]`);
  });

  await runTest('ubiquity is a number in [0, 1]', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_FULL);

    assert.equal(typeof result.ubiquity, 'number');
    assert.ok(!Number.isNaN(result.ubiquity));
    assert.ok(result.ubiquity >= 0 && result.ubiquity <= 1,
      `ubiquity ${result.ubiquity} should be in [0, 1]`);
  });

  await runTest('trace is an array with at least 5 steps', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_FULL);

    assert.ok(Array.isArray(result.trace), 'trace should be an array');
    assert.ok(result.trace.length >= 5,
      `trace should have >= 5 steps, got ${result.trace.length}`);

    // Each trace entry should have a step field
    for (const entry of result.trace) {
      assert.ok(entry.step, `trace entry missing "step" field: ${JSON.stringify(entry)}`);
    }
  });

  await runTest('trace contains expected step types', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_FULL);
    const steps = result.trace.map(t => t.step);

    // Must include these step types for transparency
    assert.ok(steps.includes('cpc-codes'), 'trace missing cpc-codes step');
    assert.ok(steps.includes('patent-count'), 'trace missing patent-count step');
    assert.ok(steps.includes('aggregated') || steps.includes('certitude-indicators'),
      'trace missing aggregation/indicator step');
    assert.ok(steps.includes('s-curve'), 'trace missing s-curve step');
    assert.ok(steps.includes('confidence'), 'trace missing confidence step');
  });

  await runTest('passes BaseStrategy.validateResult()', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_FULL);

    // Must not throw
    const validated = BaseStrategy.validateResult(result);
    assert.ok(validated === result, 'validateResult should return the same object');
  });

  // ── 3. EvolutionResult shape with sparse data ──────────────────────────

  console.log('\nEvolutionResult Shape (sparse data, <10 patents):');

  await runTest('sparse data still produces all 6 fields', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_SPARSE),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_MINIMAL);

    assert.ok('evolution' in result);
    assert.ok('confidence' in result);
    assert.ok('method' in result);
    assert.ok('certitude' in result);
    assert.ok('ubiquity' in result);
    assert.ok('trace' in result);
    assert.equal(result.method, 'cpc-evolution');
  });

  await runTest('sparse data has lower confidence than rich data', async () => {
    const richStrategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const sparseStrategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_SPARSE),
      cpcMapper: mockCpcMapper,
    });

    const richResult = await richStrategy.evaluate(COMPONENT_FULL);
    const sparseResult = await sparseStrategy.evaluate(COMPONENT_MINIMAL);

    assert.ok(sparseResult.confidence < richResult.confidence,
      `sparse confidence (${sparseResult.confidence}) should be < rich (${richResult.confidence})`);
  });

  await runTest('sparse data passes BaseStrategy.validateResult()', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_SPARSE),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_MINIMAL);
    BaseStrategy.validateResult(result);
  });

  // ── 4. Empty data (no patents found) ───────────────────────────────────

  console.log('\nEvolutionResult Shape (empty data, 0 patents):');

  await runTest('empty data still produces valid result (no abstention)', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_EMPTY),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_MINIMAL);

    // Must still produce all fields - strategy never abstains
    assert.ok('evolution' in result);
    assert.ok('confidence' in result);
    assert.ok('method' in result);
    assert.ok('certitude' in result);
    assert.ok('ubiquity' in result);
    assert.ok('trace' in result);

    assert.equal(result.method, 'cpc-evolution');
    assert.ok(result.confidence >= 0.1, 'confidence should be >= 0.1 even with no data');
    assert.ok(result.confidence <= 0.95, 'confidence should be <= 0.95');
    BaseStrategy.validateResult(result);
  });

  // ── 5. No CPC codes (mapper returns empty) ────────────────────────────

  console.log('\nEvolutionResult with failed CPC mapping:');

  await runTest('empty CPC codes produce valid result with neutral values', async () => {
    const emptyCpcMapper = { mapToCpc: async () => [] };
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: emptyCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_MINIMAL);

    assert.equal(result.method, 'cpc-evolution');
    assert.equal(typeof result.evolution, 'number');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.certitude, 'number');
    assert.equal(typeof result.ubiquity, 'number');
    assert.ok(Array.isArray(result.trace));
    BaseStrategy.validateResult(result);
  });

  // ── 6. Trace structure detail ──────────────────────────────────────────

  console.log('\nTrace Structure Detail:');

  await runTest('s-curve trace step includes evolution, phase, zone', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_FULL);
    const scurveStep = result.trace.find(t => t.step === 's-curve');

    assert.ok(scurveStep, 'trace must have s-curve step');
    assert.ok('evolution' in scurveStep, 's-curve step missing evolution');
    assert.ok('phase' in scurveStep, 's-curve step missing phase');
    assert.ok('zone' in scurveStep, 's-curve step missing zone');
  });

  await runTest('confidence trace step includes dataQuality and modelConfidence', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_FULL);
    const confStep = result.trace.find(t => t.step === 'confidence');

    assert.ok(confStep, 'trace must have confidence step');
    assert.ok('dataQuality' in confStep, 'confidence step missing dataQuality');
    assert.ok('modelConfidence' in confStep, 'confidence step missing modelConfidence');
    assert.ok('combined' in confStep, 'confidence step missing combined');
  });

  // ── 7. Unit tests for helper functions ─────────────────────────────────

  console.log('\nHelper Function Unit Tests:');

  await runTest('computeDataQuality: <10 patents -> [0.2, 0.4]', () => {
    assert.ok(computeDataQuality(0) >= 0.2);
    assert.ok(computeDataQuality(5) >= 0.2);
    assert.ok(computeDataQuality(5) <= 0.4);
    assert.ok(computeDataQuality(9) <= 0.4);
  });

  await runTest('computeDataQuality: 10-100 patents -> [0.4, 0.7]', () => {
    assert.ok(computeDataQuality(10) >= 0.4);
    assert.ok(computeDataQuality(50) >= 0.4);
    assert.ok(computeDataQuality(50) <= 0.7);
    assert.ok(computeDataQuality(100) <= 0.7);
  });

  await runTest('computeDataQuality: >100 patents -> [0.7, 0.9]', () => {
    assert.ok(computeDataQuality(200) >= 0.7);
    assert.ok(computeDataQuality(1000) <= 0.9);
  });

  await runTest('computeConfidence: bounded [0.1, 0.95]', () => {
    // Very low inputs
    assert.ok(computeConfidence(0, 0) >= 0.1);
    // Very high inputs
    assert.ok(computeConfidence(1, 1) <= 0.95);
    // Formula: raw = dq * 0.5 + mc * 0.5
    const result = computeConfidence(0.6, 0.8);
    assert.equal(result, 0.7); // 0.6*0.5 + 0.8*0.5 = 0.7
  });

  await runTest('renormalizeWeights: disabled indicators get weight 0', () => {
    const indicators = {
      a: { weight: 0.3, enabled: true },
      b: { weight: 0.3, enabled: false },
      c: { weight: 0.4, enabled: true },
    };
    const weights = renormalizeWeights(indicators);

    assert.ok(!('b' in weights), 'disabled indicator should be excluded');
    // a and c should sum to ~1.0
    const total = Object.values(weights).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(total - 1.0) < 0.001, `weights should sum to ~1.0, got ${total}`);
  });

  await runTest('renormalizeWeights: all disabled returns empty', () => {
    const indicators = {
      a: { weight: 0.5, enabled: false },
      b: { weight: 0.5, enabled: false },
    };
    const weights = renormalizeWeights(indicators);
    assert.equal(Object.keys(weights).length, 0);
  });

  await runTest('aggregateAxis: weighted average is correct', () => {
    const values = { a: 0.8, b: 0.4 };
    const weights = { a: 0.6, b: 0.4 };
    const result = aggregateAxis(values, weights);
    // 0.8*0.6 + 0.4*0.4 = 0.48 + 0.16 = 0.64
    assert.equal(result, 0.64);
  });

  await runTest('aggregateAxis: missing values return neutral 0.5', () => {
    const values = {};
    const weights = { a: 0.5, b: 0.5 };
    const result = aggregateAxis(values, weights);
    assert.equal(result, 0.5); // neutral fallback
  });

  await runTest('mergeIndicatorConfig: preserves defaults when no overrides', () => {
    const defaults = {
      a: { weight: 0.3, enabled: true },
      b: { weight: 0.7, enabled: true },
    };
    const merged = mergeIndicatorConfig(defaults, undefined);
    assert.deepEqual(merged, defaults);
  });

  await runTest('mergeIndicatorConfig: overrides specific fields', () => {
    const defaults = {
      a: { weight: 0.3, enabled: true },
      b: { weight: 0.7, enabled: true },
    };
    const overrides = { a: { enabled: false } };
    const merged = mergeIndicatorConfig(defaults, overrides);
    assert.equal(merged.a.enabled, false);
    assert.equal(merged.a.weight, 0.3); // default preserved
    assert.equal(merged.b.enabled, true); // untouched
  });

  // ── 8. Certitude/ubiquity exposed for Phase B enrichment ───────────────

  console.log('\nPhase B Enrichment (certitude/ubiquity on result):');

  await runTest('certitude and ubiquity match sector-agent-strategy pattern', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT_FULL);

    // Same pattern as sector-agent-strategy: certitude/ubiquity as top-level fields
    assert.equal(typeof result.certitude, 'number');
    assert.equal(typeof result.ubiquity, 'number');
    assert.ok(result.certitude >= 0 && result.certitude <= 1);
    assert.ok(result.ubiquity >= 0 && result.ubiquity <= 1);

    // These should be the inputs used for computeEvolution(c, u)
    // Verify trace shows the aggregated values match result fields
    const aggStep = result.trace.find(t => t.step === 'aggregated');
    if (aggStep) {
      assert.equal(result.certitude, aggStep.certitude);
      assert.equal(result.ubiquity, aggStep.ubiquity);
    }
  });

  // ── Summary ────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'='.repeat(50)}`);

  if (failed > 0) {
    console.error('\n\u2717 EvolutionResult shape tests FAILED\n');
    process.exit(1);
  } else {
    console.log('\n\u2713 All EvolutionResult shape tests PASSED\n');
  }
}

main().catch(err => {
  console.error('\n\u2717 EvolutionResult shape tests CRASHED:', err);
  process.exit(1);
});
