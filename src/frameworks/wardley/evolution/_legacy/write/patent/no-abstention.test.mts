// Test: AC 11 (amended) — refusal over default
//
// The CPC Evolution Strategy used to NEVER throw: every failure (missing CPC
// codes, BigQuery errors, zero patents, indicator failures) degraded to a
// neutral (0.5, 0.5) result at low confidence. Product-owner decision: a guess
// must never pass as an answer. Guard: each failure below now rejects; had the
// old safety net come back, these tests would catch a neutral position being
// returned in place of a refusal. When data exists, a valid result is still
// returned (happy path, sparse data, malformed-but-present data).
//
// Hermetic: no real LLM (a failing llmCall is injected where the default
// mapper would run), no real BigQuery (BIGQUERY_PROJECT_ID is unset where
// the default patent source would run).

import assert from 'node:assert/strict';
import { BaseStrategy } from '../strategies/capacity/base-strategy.mjs';
import { CpcEvolutionStrategy } from '../strategies/capacity/cpc-evolution-strategy.mjs';

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

  assert.equal(result.method, 'write:capacity:cpc-evolution', `${prefix}method must be 'write:capacity:cpc-evolution'`);

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

/** An LLM that is down — keeps the default mapper away from any real model. */
const FAILING_LLM = async () => { throw new Error('LLM down'); };

/** Dependencies that produce an answer. */
const RICH_DEPS = {
  cpcMapper: { mapToCpc: async () => ['H04L'] },
  patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
};

/** Run fn with BIGQUERY_PROJECT_ID unset, so the default source cannot reach BigQuery. */
async function withoutBigQueryEnv(fn) {
  const saved = process.env.BIGQUERY_PROJECT_ID;
  delete process.env.BIGQUERY_PROJECT_ID;
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env.BIGQUERY_PROJECT_ID = saved;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== AC 11 (amended): Refusal Over Default Tests ===\n');

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

  console.log('\nCPC Mapper Failures (refuse, never guess):');

  await runTest('CPC mapper throws Error → rejects with it', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('LLM timeout'); } },
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /LLM timeout/);
  });

  await runTest('CPC mapper throws TypeError → rejects with it', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new TypeError('null ref'); } },
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), TypeError);
  });

  await runTest('CPC mapper returns empty array → rejects (no CPC code)', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => [] },
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /no CPC code could be resolved/);
  });

  await runTest('CPC mapper returns null → rejects (no CPC code)', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => null },
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /no CPC code could be resolved/);
  });

  await runTest('no CPC mapper provided, default mapper resolves nothing → rejects', async () => {
    const strategy = new CpcEvolutionStrategy({
      // No cpcMapper — the default mapper runs on a failing LLM, so it has
      // no code to offer and must not answer the old G06F default.
      llmCall: FAILING_LLM,
      patentSource: { fetchByCpc: async () => MOCK_PATENT_DATA_RICH },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /no CPC code could be resolved.*LLM down/);
  });

  // ── 3. Patent data source failure scenarios ───────────────────────────

  console.log('\nPatent DataSource Failures (refuse, never guess):');

  await runTest('patent source throws Error → rejects with it', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => { throw new Error('BigQuery 503'); } },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /BigQuery 503/);
  });

  await runTest('patent source throws network error → rejects with it', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => { throw new Error('ECONNREFUSED'); } },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /ECONNREFUSED/);
  });

  await runTest('patent source returns empty data → rejects (zero patents)', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => ({ totalPatents: 0, patents: [] }) },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /no patent found for CPC H04L/);
  });

  await runTest('patent source returns null → rejects (zero patents)', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => null },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /no patent found/);
  });

  await runTest('patent source returns undefined → rejects (zero patents)', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => undefined },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /no patent found/);
  });

  await runTest('no patent source provided, BigQuery not configured → rejects', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      // No patentSource — the default BigQuery source needs a project id.
    });
    await withoutBigQueryEnv(() =>
      assert.rejects(strategy.evaluate(COMPONENT), /BigQuery project ID is required/));
  });

  // ── 4. Both CPC mapper AND data source fail simultaneously ────────────

  console.log('\nCombined Failures (refuse, never guess):');

  await runTest('both mapper and source throw → rejects with the first failure', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('LLM dead'); } },
      patentSource: { fetchByCpc: async () => { throw new Error('BQ dead'); } },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /LLM dead/);
  });

  await runTest('no dependencies but an LLM that is down → rejects', async () => {
    const strategy = new CpcEvolutionStrategy({ llmCall: FAILING_LLM });
    await assert.rejects(strategy.evaluate(COMPONENT), /no CPC code could be resolved/);
  });

  await runTest('no dependencies with minimal component → rejects', async () => {
    const strategy = new CpcEvolutionStrategy({ llmCall: FAILING_LLM });
    await assert.rejects(strategy.evaluate({ name: 'X' }), /no CPC code could be resolved/);
  });

  await runTest('no dependencies with empty component name → rejects before any LLM call', async () => {
    const strategy = new CpcEvolutionStrategy();
    await assert.rejects(strategy.evaluate({ name: '' }), /capability is empty/);
  });

  // ── 5. Degraded data quality scenarios ────────────────────────────────

  console.log('\nDegraded Data Quality (data exists: low confidence, still an answer):');

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

  console.log('\nMalformed-but-present data (indicators score it themselves):');

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

  console.log('\nNo Fallback Result:');

  await runTest('no fallback result: a pipeline failure rejects', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('forced fail'); } },
      patentSource: { fetchByCpc: async () => { throw new Error('forced fail'); } },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /forced fail/);
  });

  await runTest('no neutral certitude/ubiquity when both dependencies fail', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('forced'); } },
      patentSource: { fetchByCpc: async () => { throw new Error('forced'); } },
    });
    const [outcome] = await Promise.allSettled([strategy.evaluate(COMPONENT)]);
    assert.equal(outcome.status, 'rejected', 'a failed pipeline must not yield a (0.5, 0.5) result');
  });

  await runTest('no top-level safety net: an internal crash propagates', async () => {
    const strategy = new CpcEvolutionStrategy(RICH_DEPS);
    assert.equal(strategy._buildFallbackResult, undefined, '_buildFallbackResult must stay removed');
    // Crash a step past the dependencies: the old safety net turned this
    // into a neutral 0.5 / 0.5 result at confidence 0.1.
    strategy._computeIndicators = async () => { throw new Error('Unexpected internal crash'); };
    await assert.rejects(strategy.evaluate(COMPONENT), /Unexpected internal crash/);
  });

  await runTest('the rejection carries the error reason', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('test failure reason'); } },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), { message: 'test failure reason' });
  });

  // ── 8. Phase B enrichment compatibility ───────────────────────────────

  console.log('\nPhase B Enrichment Compatibility:');

  await runTest('result.certitude is a number when answered, and there is no result otherwise', async () => {
    const answered = await new CpcEvolutionStrategy(RICH_DEPS).evaluate(COMPONENT);
    assert.equal(typeof answered.certitude, 'number', 'certitude must be number');
    assert.equal(typeof answered.ubiquity, 'number', 'ubiquity must be number');
    assert.ok(!Number.isNaN(answered.certitude), 'certitude must not be NaN');
    assert.ok(!Number.isNaN(answered.ubiquity), 'ubiquity must not be NaN');

    const refused = [
      { cpcMapper: { mapToCpc: async () => [] }, patentSource: { fetchByCpc: async () => ({ totalPatents: 0, patents: [] }) } },
      { cpcMapper: { mapToCpc: async () => { throw new Error('fail'); } } },
      { llmCall: FAILING_LLM },  // default mapper, LLM down
    ];
    for (const [i, opts] of refused.entries()) {
      await assert.rejects(new CpcEvolutionStrategy(opts).evaluate(COMPONENT), `scenario ${i} must reject`);
    }
  });

  await runTest('a refused evaluation gives Phase B nothing to average', async () => {
    // Phase B averages certitude/ubiquity of the strategies that answered;
    // a refusal is a rejected promise, never a neutral (0.5, 0.5) entry.
    const strategy = new CpcEvolutionStrategy({ cpcMapper: { mapToCpc: async () => [] } });
    const [outcome] = await Promise.allSettled([strategy.evaluate(COMPONENT)]);
    assert.equal(outcome.status, 'rejected');
  });

  // ── 9. Confidence ordering: more data = higher confidence ─────────────

  console.log('\nConfidence Ordering (no data refused, sparse < rich):');

  await runTest('confidence increases with data quality', async () => {
    const makeStrategy = (patentData) => new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ['H04L'] },
      patentSource: { fetchByCpc: async () => patentData },
    });

    await assert.rejects(makeStrategy({ totalPatents: 0, patents: [] }).evaluate(COMPONENT), /no patent found/);
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

    assertValidResult(sparseData, 'sparse');
    assertValidResult(richData, 'rich');

    // Confidence should increase with data quality
    assert.ok(sparseData.confidence <= richData.confidence,
      `sparse confidence (${sparseData.confidence}) should be <= rich (${richData.confidence})`);
  });

  // ── 10. Regression: evaluate() is async and does not return null ──────

  console.log('\nRegression Guards:');

  await runTest('evaluate() returns a Promise', async () => {
    const strategy = new CpcEvolutionStrategy(RICH_DEPS);
    const returnValue = strategy.evaluate(COMPONENT);
    assert.ok(returnValue instanceof Promise, 'evaluate() must return a Promise');
    await returnValue;
  });

  await runTest('evaluate() rejects rather than resolving to a guess', async () => {
    const strategy = new CpcEvolutionStrategy({ llmCall: FAILING_LLM });
    await assert.rejects(strategy.evaluate(COMPONENT));
  });

  await runTest('evaluate() never resolves to null or undefined', async () => {
    const strategy = new CpcEvolutionStrategy(RICH_DEPS);
    const result = await strategy.evaluate(COMPONENT);
    assert.ok(result != null, 'result must not be null or undefined');
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
    console.error('\n\u2717 AC 11: Refusal Over Default tests FAILED\n');
    process.exit(1);
  } else {
    console.log('\n\u2713 AC 11: All Refusal Over Default tests PASSED\n');
  }
}

main().catch(err => {
  console.error('\n\u2717 AC 11: Refusal Over Default tests CRASHED:', err);
  process.exit(1);
});
