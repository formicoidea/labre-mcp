// Test: AC 14 — CPC Evolution Strategy exposes certitude/ubiquity for Phase B enrichment
//
// Validates that the strategy result shape is compatible with the Phase B
// enrichment pipeline in estimate-evolution.mjs (lines 246-262):
//
//   const llmResults = Object.values(evaluations).filter(
//     e => !e.error && e.certitude != null && e.ubiquity != null
//   );
//
// This is the same contract as sector-agent-strategy.mjs:
//   result = { evolution, confidence, method, certitude, ubiquity }
//
// Both the normal path and the fallback path must satisfy this contract.

import assert from 'node:assert/strict';
import { BaseStrategy } from '../strategies/capacity/base-strategy.mjs';
import { CpcEvolutionStrategy } from '../strategies/capacity/cpc-evolution-strategy.mjs';

// ── Mock fixtures ──────────────────────────────────────────────────────────

const mockCpcMapper = {
  mapToCpc: async () => ['H04L', 'G06F'],
};

const MOCK_RICH_DATA = {
  totalPatents: 200,
  patents: [],
  cpcDistribution: [
    { cpc: 'H04L', count: 130 },
    { cpc: 'G06F', count: 70 },
  ],
  yearlyClassifications: [
    { year: 2019, cpcCodes: ['H04L', 'G06F'] },
    { year: 2020, cpcCodes: ['H04L', 'G06F'] },
    { year: 2021, cpcCodes: ['H04L', 'G06F'] },
  ],
  citationData: { totalForwardCitations: 2500, patentCount: 200 },
  claimsTimeline: [
    { year: 2018, avgIndependentClaims: 9.0 },
    { year: 2021, avgIndependentClaims: 5.0 },
  ],
  assigneeData: { uniqueAssignees: 60, totalPatents: 200 },
  geoData: { jurisdictionCount: 4, jurisdictions: ['US', 'EP', 'CN', 'JP'] },
  sectorData: { uniqueSections: 2, uniqueClasses: 8 },
  filingTimeline: [
    { year: 2018, count: 40 },
    { year: 2019, count: 50 },
    { year: 2020, count: 55 },
    { year: 2021, count: 55 },
  ],
};

const MOCK_EMPTY_DATA = { totalPatents: 0, patents: [] };

function createMockSource(data) {
  return { fetchByCpc: async () => data };
}

const COMPONENT = {
  name: 'Load Balancer',
  capability: 'network traffic distribution',
  description: 'Distributes incoming requests across backend servers',
};

// ── Test runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── Phase B enrichment contract tests ─────────────────────────────────────

async function main() {
  console.log('=== AC 14: Phase B Enrichment Compatibility ===\n');

  // ── 1. Same pattern as sector-agent-strategy.mjs ─────────────────────

  console.log('Pattern Equivalence with sector-agent-strategy:');

  await test('result has certitude as a top-level numeric field', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    // sector-agent-strategy pattern: certitude: parsed.certitude (top-level)
    assert.ok('certitude' in result, 'certitude must be a top-level field');
    assert.equal(typeof result.certitude, 'number');
    assert.ok(!Number.isNaN(result.certitude), 'certitude must not be NaN');
  });

  await test('result has ubiquity as a top-level numeric field', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    // sector-agent-strategy pattern: ubiquity: parsed.ubiquity (top-level)
    assert.ok('ubiquity' in result, 'ubiquity must be a top-level field');
    assert.equal(typeof result.ubiquity, 'number');
    assert.ok(!Number.isNaN(result.ubiquity), 'ubiquity must not be NaN');
  });

  await test('certitude is in [0, 1] range', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);
    assert.ok(result.certitude >= 0, `certitude ${result.certitude} must be >= 0`);
    assert.ok(result.certitude <= 1, `certitude ${result.certitude} must be <= 1`);
  });

  await test('ubiquity is in [0, 1] range', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);
    assert.ok(result.ubiquity >= 0, `ubiquity ${result.ubiquity} must be >= 0`);
    assert.ok(result.ubiquity <= 1, `ubiquity ${result.ubiquity} must be <= 1`);
  });

  await test('result also has evolution, confidence, method (full BaseStrategy contract)', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    assert.ok('evolution' in result);
    assert.ok('confidence' in result);
    assert.ok('method' in result);
    assert.equal(result.method, 'write:capacity:cpc-evolution');
  });

  // ── 2. Phase B filter compatibility ──────────────────────────────────

  console.log('\nPhase B Filter Compatibility:');

  await test('result passes Phase B filter: !e.error && e.certitude != null && e.ubiquity != null', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    // Exact filter from estimate-evolution.mjs line 249-250
    const passesFilter = !result.error && result.certitude != null && result.ubiquity != null;
    assert.ok(passesFilter, 'result must pass the Phase B enrichment filter');
  });

  await test('result has no error field (or error is falsy)', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    // Phase B checks !e.error — result should not have an error field
    assert.ok(!result.error, 'result.error must be absent or falsy');
  });

  await test('certitude is not null/undefined (survives != null check)', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    // != null checks for both null and undefined
    assert.ok(result.certitude != null, 'certitude must not be null or undefined');
  });

  await test('ubiquity is not null/undefined (survives != null check)', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    assert.ok(result.ubiquity != null, 'ubiquity must not be null or undefined');
  });

  // ── 3. Phase B averaging compatibility ───────────────────────────────

  console.log('\nPhase B Averaging Compatibility:');

  await test('certitude/ubiquity are valid for arithmetic averaging', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    // Phase B does: reduce((s, r) => s + r.certitude, 0) / llmResults.length
    // Values must be finite numbers for this to work
    assert.ok(Number.isFinite(result.certitude), 'certitude must be finite for averaging');
    assert.ok(Number.isFinite(result.ubiquity), 'ubiquity must be finite for averaging');
  });

  await test('certitude and ubiquity are the inputs used for computeEvolution', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    // The trace step 'aggregated' records the exact certitude/ubiquity used
    const aggStep = result.trace.find(t => t.step === 'aggregated');
    assert.ok(aggStep, 'trace must have an aggregated step');
    assert.equal(result.certitude, aggStep.certitude,
      'result.certitude must match the value used in computeEvolution');
    assert.equal(result.ubiquity, aggStep.ubiquity,
      'result.ubiquity must match the value used in computeEvolution');
  });

  // ── 4. Fallback path also exposes certitude/ubiquity ─────────────────

  console.log('\nFallback Path (Phase B still sees certitude/ubiquity):');

  await test('degraded path (broken mapper+source) passes Phase B filter', async () => {
    // Broken mapper/source are caught internally — strategy degrades gracefully
    const brokenSource = {
      fetchByCpc: async () => { throw new Error('BigQuery timeout'); },
    };
    const brokenMapper = {
      mapToCpc: async () => { throw new Error('CPC mapping failed'); },
    };
    const strategy = new CpcEvolutionStrategy({
      patentSource: brokenSource,
      cpcMapper: brokenMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    // Even degraded, Phase B must see certitude/ubiquity
    const passesFilter = !result.error && result.certitude != null && result.ubiquity != null;
    assert.ok(passesFilter, 'degraded result must pass Phase B filter');
    assert.ok(Number.isFinite(result.certitude));
    assert.ok(Number.isFinite(result.ubiquity));
  });

  await test('true fallback (_buildFallbackResult) passes Phase B filter', async () => {
    // Force the safety net by subclassing and making _evaluateInternal throw
    class CrashingStrategy extends CpcEvolutionStrategy {
      async _evaluateInternal() {
        throw new Error('Unexpected internal crash');
      }
    }
    // Copy static method since subclass inherits it
    const strategy = new CrashingStrategy();
    const result = await strategy.evaluate(COMPONENT);

    const passesFilter = !result.error && result.certitude != null && result.ubiquity != null;
    assert.ok(passesFilter, 'fallback result must pass Phase B filter');
  });

  await test('true fallback certitude/ubiquity are neutral (0.5)', async () => {
    class CrashingStrategy extends CpcEvolutionStrategy {
      async _evaluateInternal() {
        throw new Error('Unexpected internal crash');
      }
    }
    const strategy = new CrashingStrategy();
    const result = await strategy.evaluate(COMPONENT);

    assert.equal(result.certitude, 0.5, 'fallback certitude should be neutral 0.5');
    assert.equal(result.ubiquity, 0.5, 'fallback ubiquity should be neutral 0.5');
  });

  await test('true fallback has minimum confidence (0.1) so Phase B deprioritizes it', async () => {
    class CrashingStrategy extends CpcEvolutionStrategy {
      async _evaluateInternal() {
        throw new Error('Unexpected internal crash');
      }
    }
    const strategy = new CrashingStrategy();
    const result = await strategy.evaluate(COMPONENT);

    assert.equal(result.confidence, 0.1, 'fallback confidence should be minimum 0.1');
  });

  // ── 5. Empty data path also exposes certitude/ubiquity ───────────────

  console.log('\nEmpty Data Path (Phase B still sees certitude/ubiquity):');

  await test('empty data result passes Phase B filter', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_EMPTY_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    const passesFilter = !result.error && result.certitude != null && result.ubiquity != null;
    assert.ok(passesFilter, 'empty data result must pass Phase B filter');
  });

  await test('empty data certitude/ubiquity are finite numbers', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_EMPTY_DATA),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate(COMPONENT);

    assert.ok(Number.isFinite(result.certitude));
    assert.ok(Number.isFinite(result.ubiquity));
  });

  // ── 6. Simulated Phase B enrichment integration ──────────────────────

  console.log('\nSimulated Phase B Integration:');

  await test('CPC result contributes correctly to Phase B averaging with sector-agent mock', async () => {
    // Simulate what estimate-evolution.mjs does in Phase B (lines 246-262)
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });
    const cpcResult = await strategy.evaluate(COMPONENT);

    // Mock a sector-agent result (same pattern)
    const sectorResult = {
      evolution: 0.65,
      confidence: 0.8,
      method: 'sector-agent',
      certitude: 0.7,
      ubiquity: 0.75,
    };

    // Simulate Phase B filter
    const evaluations = {
      'cpc-evolution': cpcResult,
      'sector-agent': sectorResult,
    };
    const llmResults = Object.values(evaluations).filter(
      e => !e.error && e.certitude != null && e.ubiquity != null
    );

    assert.equal(llmResults.length, 2, 'both strategies should pass Phase B filter');

    // Simulate Phase B averaging
    const avgCertitude = Math.round(
      llmResults.reduce((s, r) => s + r.certitude, 0) / llmResults.length * 1000
    ) / 1000;
    const avgUbiquity = Math.round(
      llmResults.reduce((s, r) => s + r.ubiquity, 0) / llmResults.length * 1000
    ) / 1000;

    assert.ok(Number.isFinite(avgCertitude), 'averaged certitude must be finite');
    assert.ok(Number.isFinite(avgUbiquity), 'averaged ubiquity must be finite');
    assert.ok(avgCertitude >= 0 && avgCertitude <= 1, 'averaged certitude in [0,1]');
    assert.ok(avgUbiquity >= 0 && avgUbiquity <= 1, 'averaged ubiquity in [0,1]');
  });

  await test('disabled indicators still produce valid certitude/ubiquity for Phase B', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockSource(MOCK_RICH_DATA),
      cpcMapper: mockCpcMapper,
    });

    // Disable some indicators
    strategy.setIndicatorEnabled('certitude', 'convergenceHHI', false);
    strategy.setIndicatorEnabled('ubiquity', 'ratioExpires', false);

    const result = await strategy.evaluate(COMPONENT);

    // Phase B filter must still work
    const passesFilter = !result.error && result.certitude != null && result.ubiquity != null;
    assert.ok(passesFilter, 'result with disabled indicators must still pass Phase B filter');
    assert.ok(Number.isFinite(result.certitude));
    assert.ok(Number.isFinite(result.ubiquity));
    assert.ok(result.certitude >= 0 && result.certitude <= 1);
    assert.ok(result.ubiquity >= 0 && result.ubiquity <= 1);
  });

  // ── Summary ──────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(55)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'='.repeat(55)}`);

  if (failed > 0) {
    console.error('\n\u2717 AC 14 Phase B enrichment tests FAILED\n');
    process.exit(1);
  } else {
    console.log('\n\u2713 All AC 14 Phase B enrichment tests PASSED\n');
  }
}

main().catch(err => {
  console.error('\n\u2717 AC 14 tests CRASHED:', err);
  process.exit(1);
});
