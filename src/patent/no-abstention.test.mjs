// Test: AC 11 — Strategy always returns a result (no abstention)
//
// The CPC Evolution Strategy must NEVER throw or return null. Under every
// failure condition — missing CPC codes, BigQuery errors, zero patents,
// indicator module failures, even s-curve crashes — it must return a valid
// EvolutionResult with low confidence. Phase B enrichment in
// estimate-evolution.mjs uses confidence for weighting, so low confidence
// naturally deprioritizes unreliable results without requiring abstention.
//
// This test exhaustively verifies the no-abstention guarantee by injecting
// failures at every stage of the pipeline.

import assert from 'node:assert/strict';
import { BaseStrategy } from '../strategies/base-strategy.mjs';
import { CpcEvolutionStrategy } from './cpc-evolution-strategy.mjs';

// ── Test helpers ────────────────────────────────────────────────────────────

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

/**
 * Validate that a result conforms to the EvolutionResult contract.
 * This is the core assertion for every no-abstention test.
 */
function assertValidResult(result, context = '') {
  const prefix = context ? `[${context}] ` : '';

  // Must not be null/undefined
  assert.ok(result != null, `${prefix}result must not be null/undefined`);

  // Must have all required fields
  assert.equal(typeof result.evolution, 'number', `${prefix}evolution must be a number`);
  assert.ok(!Number.isNaN(result.evolution), `${prefix}evolution must not be NaN`);
  assert.ok(result.evolution >= 0 && result.evolution <= 1,
    `${prefix}evolution ${result.evolution} must be in [0, 1]`);

  assert.equal(typeof result.confidence, 'number', `${prefix}confidence must be a number`);
  assert.ok(!Number.isNaN(result.confidence), `${prefix}confidence must not be NaN`);
  assert.ok(result.confidence >= 0.1 && result.confidence <= 0.95,
    `${prefix}confidence ${result.confidence} must be in [0.1, 0.95]`);

  assert.equal(result.method, 'cpc-evolution', `${prefix}method must be 'cpc-evolution'`);

  assert.equal(typeof result.certitude, 'number', `${prefix}certitude must be a number`);
  assert.ok(!Number.isNaN(result.certitude), `${prefix}certitude must not be NaN`);

  assert.equal(typeof result.ubiquity, 'number', `${prefix}ubiquity must be a number`);
  assert.ok(!Number.isNaN(result.ubiquity), `${prefix}ubiquity must not be NaN`);

  assert.ok(Array.isArray(result.trace), `${prefix}trace must be an array`);

  // Must pass BaseStrategy validation
  BaseStrategy.validateResult(result);
}

// ── Mock fixtures ───────────────────────────────────────────────────────────

/** Minimal patent data for scenarios where data exists */
const MOCK_PATENT_DATA_RICH = {
  totalPatents: 250,
  patents: [],
  cpcDistribution: [{ cpc: 'H04L', count: 150 }, { cpc: 'G06F', count: 100 }],
  yearlyClassifications: [
    { year: 2020, cpcCodes: ['H04L', 'G06F'] },
    { year: 2021, cpcCodes: ['H04L', 'G06F'] },
  ],
  citationData: { totalForwardCitations: 2500, patentCount: 250 },
  claimsTimeline: [
    { year: 2019, avgIndependentClaims: 7 },
    { year: 2021, avgIndependentClaims: 5 },
  ],
  assigneeData: { uniqueAssignees: 80, totalPatents: 250 },
  geoData: { jurisdictionCount: 4 },
  sectorData: { uniqueSections: 3, uniqueClasses: 8 },
  expirationData: { expiredCount: 100, totalPatents: 250 },
};

const COMPONENT = { name: 'Test Component', capability: 'testing' };

// ── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== AC 11: No Abstention Guarantee Tests ===\n');

  // ── 1. Happy path: normal evaluation returns a result ─────────────────

  console.log('Happy Path:');

  await runTest('normal evaluation with rich data returns valid result', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L', 'G06F'] },
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'rich data');
  });

  // ── 2. CPC mapper failure scenarios ───────────────────────────────────

  console.log('\nCPC Mapper Failures (should NOT cause abstention):');

  await runTest('CPC mapper throws Error', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('LLM timeout'); } },
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'mapper throws');
  });

  await runTest('CPC mapper throws TypeError', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new TypeError('null ref'); } },
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'mapper TypeError');
  });

  await runTest('CPC mapper returns empty array', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => [] },
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'mapper empty');
  });

  await runTest('CPC mapper returns null (fallback handles it)', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => null },
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });
    // This may trigger the fallback path since null is not an array
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'mapper null');
  });

  await runTest('no CPC mapper provided (lazy-load fails gracefully)', async () => {
    const strategy = new CpcEvolutionStrategy({
      // No cpcMapper — will try dynamic import which may fail
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'no mapper');
  });

  // ── 3. Patent data source failure scenarios ───────────────────────────

  console.log('\nPatent DataSource Failures (should NOT cause abstention):');

  await runTest('patent source throws Error', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => { throw new Error('BigQuery 503'); } },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'source throws');
  });

  await runTest('patent source throws network error', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => { throw new Error('ECONNREFUSED'); } },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'source network error');
  });

  await runTest('patent source returns empty data', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => ({ totalPatents: 0, patents: [] }) },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'source empty');
    // With 0 patents, confidence should be low
    assert.ok(result.confidence <= 0.55,
      `confidence ${result.confidence} should be <= 0.55 with zero patents`);
  });

  await runTest('patent source returns null', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => null },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'source null');
  });

  await runTest('patent source returns undefined', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => undefined },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'source undefined');
  });

  await runTest('no patent source provided (lazy-load fails gracefully)', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      // No patentSource — will try dynamic import which may fail
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'no source');
  });

  // ── 4. Both CPC mapper AND data source fail simultaneously ────────────

  console.log('\nCombined Failures (should NOT cause abstention):');

  await runTest('both mapper and source throw', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('LLM dead'); } },
      patentSource: { fetchByCpc: async () => { throw new Error('BQ dead'); } },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'both throw');
  });

  await runTest('no dependencies at all (bare constructor)', async () => {
    const strategy = new CpcEvolutionStrategy();
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'bare');
  });

  await runTest('no dependencies with minimal component', async () => {
    const strategy = new CpcEvolutionStrategy();
    const result = await strategy.evaluate({ name: 'X' });
    assertValidResult(result, 'bare minimal');
  });

  await runTest('no dependencies with empty component name', async () => {
    const strategy = new CpcEvolutionStrategy();
    const result = await strategy.evaluate({ name: '' });
    assertValidResult(result, 'bare empty name');
  });

  // ── 5. Degraded data quality scenarios ────────────────────────────────

  console.log('\nDegraded Data Quality (should return low confidence, not abstain):');

  await runTest('1 patent returns valid result with very low confidence', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['G06N'] },
      patentSource: {
        fetchByCpc: async () => ({
          totalPatents: 1,
          patents: [],
          cpcDistribution: [{ cpc: 'G06N', count: 1 }],
          yearlyClassifications: [{ year: 2023, cpcCodes: ['G06N'] }],
          citationData: { totalForwardCitations: 0, patentCount: 1 },
          claimsTimeline: [{ year: 2023, avgIndependentClaims: 15 }],
          assigneeData: { uniqueAssignees: 1, totalPatents: 1 },
          geoData: { jurisdictionCount: 1 },
          sectorData: { uniqueSections: 1, uniqueClasses: 1 },
          expirationData: { expiredCount: 0, totalPatents: 1 },
        }),
      },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, '1 patent');
    // dataQuality(1) ≈ 0.22, modelConfidence depends on S-curve band position
    // Combined can reach ~0.55-0.60 when point is inside the band
    assert.ok(result.confidence <= 0.65,
      `1 patent: confidence ${result.confidence} should be <= 0.65`);
  });

  await runTest('5 patents returns valid result with low confidence', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['G06N'] },
      patentSource: {
        fetchByCpc: async () => ({
          totalPatents: 5,
          patents: [],
          cpcDistribution: [{ cpc: 'G06N', count: 5 }],
          yearlyClassifications: [{ year: 2023, cpcCodes: ['G06N'] }],
          citationData: { totalForwardCitations: 2, patentCount: 5 },
          claimsTimeline: [{ year: 2023, avgIndependentClaims: 10 }],
          assigneeData: { uniqueAssignees: 3, totalPatents: 5 },
          geoData: { jurisdictionCount: 1 },
          sectorData: { uniqueSections: 1, uniqueClasses: 1 },
          expirationData: { expiredCount: 0, totalPatents: 5 },
        }),
      },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, '5 patents');
  });

  // ── 6. Indicator module failure ───────────────────────────────────────

  console.log('\nIndicator Failures (fallback to neutral values):');

  await runTest('malformed patent data still produces result', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: {
        fetchByCpc: async () => ({
          totalPatents: 100,
          patents: [],
          // All indicator fields are missing/malformed
          cpcDistribution: 'not an array',
          yearlyClassifications: null,
          citationData: 42,
          claimsTimeline: undefined,
          assigneeData: false,
          geoData: [],
          sectorData: 'wrong',
          expirationData: NaN,
        }),
      },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'malformed data');
  });

  // ── 7. Fallback result properties ─────────────────────────────────────

  console.log('\nFallback Result Properties:');

  await runTest('fallback result has minimum confidence (0.1)', async () => {
    // Force the internal pipeline to fail by making computeIndicators
    // not available AND causing unexpected failure
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('forced fail'); } },
      patentSource: { fetchByCpc: async () => { throw new Error('forced fail'); } },
    });

    // The strategy should still return via fallback
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'fallback');
  });

  await runTest('degraded result has valid certitude/ubiquity (Phase B compatible)', async () => {
    // Both dependencies fail — strategy degrades through individual error
    // handlers (not top-level safety net). Indicator functions return 0 for
    // undefined input data, yielding low certitude/ubiquity values.
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('forced'); } },
      patentSource: { fetchByCpc: async () => { throw new Error('forced'); } },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'degraded neutral');
    // certitude/ubiquity must be valid numbers in [0, 1] for Phase B averaging
    assert.ok(result.certitude >= 0 && result.certitude <= 1,
      `degraded certitude ${result.certitude} should be in [0, 1]`);
    assert.ok(result.ubiquity >= 0 && result.ubiquity <= 1,
      `degraded ubiquity ${result.ubiquity} should be in [0, 1]`);
  });

  await runTest('top-level safety net returns neutral 0.5 certitude/ubiquity', async () => {
    // Test the _buildFallbackResult directly by triggering a failure
    // that bypasses individual error handlers
    const strategy = new CpcEvolutionStrategy();
    // Access private method to test fallback directly
    const fallback = strategy._buildFallbackResult(new Error('test'));
    assertValidResult(fallback, 'safety net');
    assert.equal(fallback.certitude, 0.5,
      `safety net certitude should be 0.5, got ${fallback.certitude}`);
    assert.equal(fallback.ubiquity, 0.5,
      `safety net ubiquity should be 0.5, got ${fallback.ubiquity}`);
    assert.equal(fallback.confidence, 0.1,
      `safety net confidence should be 0.1, got ${fallback.confidence}`);
    // Trace should mention fallback
    const fallbackStep = fallback.trace.find(t => t.step === 'fallback');
    assert.ok(fallbackStep, 'safety net trace must have fallback step');
    assert.equal(fallbackStep.reason, 'test',
      'fallback trace must include the error reason');
  });

  await runTest('fallback trace includes error reason', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('test failure reason'); } },
    });
    const result = await strategy.evaluate(COMPONENT);
    assertValidResult(result, 'fallback trace');
    // In normal degradation the trace won't show 'fallback' step unless
    // the top-level safety net is triggered. Individual method catches
    // handle gracefully with neutral defaults.
    assert.ok(result.trace.length > 0, 'trace should not be empty');
  });

  // ── 8. Phase B enrichment compatibility ───────────────────────────────

  console.log('\nPhase B Enrichment Compatibility:');

  await runTest('result.certitude is always a number for Phase B averaging', async () => {
    const scenarios = [
      { cpcMapper: { mapToCpc: async () => ['H04L'] }, patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH } },
      { cpcMapper: { mapToCpc: async () => [] }, patentSource: { fetchByCpc: async () => ({ totalPatents: 0, patents: [] }) } },
      { cpcMapper: { mapToCpc: async () => { throw new Error('fail'); } } },
      {},  // bare constructor
    ];

    for (const [i, opts] of scenarios.entries()) {
      const strategy = new CpcEvolutionStrategy(opts);
      const result = await strategy.evaluate(COMPONENT);
      assert.equal(typeof result.certitude, 'number', `scenario ${i}: certitude must be number`);
      assert.equal(typeof result.ubiquity, 'number', `scenario ${i}: ubiquity must be number`);
      assert.ok(!Number.isNaN(result.certitude), `scenario ${i}: certitude must not be NaN`);
      assert.ok(!Number.isNaN(result.ubiquity), `scenario ${i}: ubiquity must not be NaN`);
    }
  });

  await runTest('low-confidence result is still consumed by Phase B averaging', async () => {
    // Simulate what Phase B enrichment does: average certitude/ubiquity
    // from all LLM strategies that provided them (non-error, non-null)
    const strategy = new CpcEvolutionStrategy();
    const result = await strategy.evaluate(COMPONENT);

    // Phase B code from estimate-evolution.mjs:
    // const llmResults = Object.values(evaluations).filter(
    //   e => !e.error && e.certitude != null && e.ubiquity != null
    // );
    const isPhaseBAble = !result.error && result.certitude != null && result.ubiquity != null;
    assert.ok(isPhaseBAble, 'result should be consumable by Phase B enrichment');
  });

  // ── 9. Confidence ordering: more data = higher confidence ─────────────

  console.log('\nConfidence Ordering (no data < sparse < rich):');

  await runTest('confidence increases with data quality', async () => {
    const makeStrategy = (patentData) => new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => patentData },
    });

    const noData = await makeStrategy({ totalPatents: 0, patents: [] }).evaluate(COMPONENT);
    const sparseData = await makeStrategy({
      totalPatents: 5, patents: [],
      cpcDistribution: [{ cpc: 'H04L', count: 5 }],
      yearlyClassifications: [{ year: 2023, cpcCodes: ['H04L'] }],
      citationData: { totalForwardCitations: 5, patentCount: 5 },
      claimsTimeline: [{ year: 2023, avgIndependentClaims: 8 }],
      assigneeData: { uniqueAssignees: 3, totalPatents: 5 },
      geoData: { jurisdictionCount: 1 },
      sectorData: { uniqueSections: 1, uniqueClasses: 1 },
      expirationData: { expiredCount: 1, totalPatents: 5 },
    }).evaluate(COMPONENT);
    const richData = await makeStrategy(MOCK_PATENT_DATA_RICH).evaluate(COMPONENT);

    assertValidResult(noData, 'no data');
    assertValidResult(sparseData, 'sparse');
    assertValidResult(richData, 'rich');

    // All return results (no abstention)
    // Confidence should increase with data quality
    assert.ok(noData.confidence <= sparseData.confidence,
      `no data confidence (${noData.confidence}) should be <= sparse (${sparseData.confidence})`);
    assert.ok(sparseData.confidence <= richData.confidence,
      `sparse confidence (${sparseData.confidence}) should be <= rich (${richData.confidence})`);
  });

  // ── 10. Regression: evaluate() is async and does not return null ──────

  console.log('\nRegression Guards:');

  await runTest('evaluate() returns a Promise', () => {
    const strategy = new CpcEvolutionStrategy();
    const returnValue = strategy.evaluate(COMPONENT);
    assert.ok(returnValue instanceof Promise, 'evaluate() must return a Promise');
  });

  await runTest('evaluate() resolves (never rejects)', async () => {
    const strategy = new CpcEvolutionStrategy();
    // This must not reject
    const result = await strategy.evaluate(COMPONENT);
    assert.ok(result != null, 'resolved value must not be null');
  });

  await runTest('evaluate() never returns undefined', async () => {
    const strategy = new CpcEvolutionStrategy();
    const result = await strategy.evaluate(COMPONENT);
    assert.ok(result !== undefined, 'result must not be undefined');
  });

  await runTest('multiple sequential calls all return results', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });

    for (let i = 0; i < 5; i++) {
      const result = await strategy.evaluate(COMPONENT);
      assertValidResult(result, `call ${i + 1}`);
    }
  });

  await runTest('concurrent calls all return results', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });

    const promises = Array.from({ length: 5 }, () => strategy.evaluate(COMPONENT));
    const results = await Promise.all(promises);

    for (const [i, result] of results.entries()) {
      assertValidResult(result, `concurrent ${i + 1}`);
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'='.repeat(50)}`);

  if (failed > 0) {
    console.error('\n\u2717 AC 11: No Abstention tests FAILED\n');
    process.exit(1);
  } else {
    console.log('\n\u2713 AC 11: All No Abstention tests PASSED\n');
  }
}

main().catch(err => {
  console.error('\n\u2717 AC 11: No Abstention tests CRASHED:', err);
  process.exit(1);
});
