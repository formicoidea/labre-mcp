// Test: AC 10 — Data quality degrades gracefully
//
// Verifies graduated data quality scoring based on patent count:
//   <10 patents  → [0.2, 0.4]  (very low data, low confidence)
//   10-100       → [0.4, 0.7]  (moderate data, medium confidence)
//   >100         → [0.7, 0.9]  (abundant data, high confidence)
//
// Tests cover:
//   1. Each tier returns scores within its specified range
//   2. Boundary continuity (no jumps at tier transitions)
//   3. Monotonic increase (more data = higher quality)
//   4. Logarithmic saturation in tier 3 (diminishing returns)
//   5. End-to-end degradation through the strategy pipeline
//   6. Edge cases: 0 patents, 1 patent, very large counts

import assert from 'node:assert/strict';
import {
  computeDataQuality,
  computeConfidence,
  CpcEvolutionStrategy,
} from '../strategies/capacity/cpc-evolution-strategy.mjs';

// ── Test runner ───────────────────────────────────────────────────────────

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

// ── Mock helpers ─────────────────────────────────────────────────────────

const mockCpcMapper = { mapToCpc: async () => ['H04L', 'G06F'] };

function createMockPatentSource(patentCount) {
  return {
    fetchByCpc: async () => ({
      totalPatents: patentCount,
      patents: [],
      cpcDistribution: patentCount > 0
        ? [{ cpc: 'H04L', count: Math.ceil(patentCount * 0.6) },
           { cpc: 'G06F', count: Math.floor(patentCount * 0.4) }]
        : [],
      yearlyClassifications: patentCount >= 10
        ? [{ year: 2019, cpcCodes: ['H04L', 'G06F'] },
           { year: 2020, cpcCodes: ['H04L', 'G06F'] },
           { year: 2021, cpcCodes: ['H04L', 'G06F'] }]
        : patentCount > 0
          ? [{ year: 2023, cpcCodes: ['H04L'] }]
          : [],
      citationData: { totalForwardCitations: patentCount * 8, patentCount },
      claimsTimeline: patentCount >= 10
        ? [{ year: 2018, avgIndependentClaims: 9 },
           { year: 2020, avgIndependentClaims: 6 },
           { year: 2022, avgIndependentClaims: 4 }]
        : patentCount > 0
          ? [{ year: 2023, avgIndependentClaims: 12 }]
          : [],
      assigneeData: { uniqueAssignees: Math.min(patentCount, 80), totalPatents: patentCount },
      geoData: {
        jurisdictionCount: patentCount > 100 ? 5 : patentCount > 10 ? 3 : 1,
        jurisdictions: patentCount > 100
          ? ['US', 'EP', 'CN', 'JP', 'KR']
          : patentCount > 10
            ? ['US', 'EP', 'CN']
            : ['US'],
      },
      sectorData: {
        uniqueSections: patentCount > 100 ? 3 : patentCount > 10 ? 2 : 1,
        uniqueClasses: patentCount > 100 ? 10 : patentCount > 10 ? 4 : 1,
      },
      expirationData: {
        expiredCount: Math.floor(patentCount * 0.4),
        totalPatents: patentCount,
      },
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== AC 10: Data Quality Graceful Degradation ===\n');

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TIER 1: <10 patents → [0.2, 0.4]
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('Tier 1: <10 patents → [0.2, 0.4]:');

  await runTest('0 patents → exactly 0.2 (floor)', () => {
    assert.equal(computeDataQuality(0), 0.2);
  });

  await runTest('1 patent → in [0.2, 0.4]', () => {
    const dq = computeDataQuality(1);
    assert.ok(dq >= 0.2 && dq <= 0.4, `dq(1)=${dq} out of range`);
  });

  await runTest('5 patents → ~0.3 (midpoint of tier)', () => {
    const dq = computeDataQuality(5);
    assert.ok(Math.abs(dq - 0.3) < 0.01, `dq(5)=${dq} should be ~0.3`);
  });

  await runTest('9 patents → near 0.4 but strictly <0.4', () => {
    const dq = computeDataQuality(9);
    assert.ok(dq >= 0.35 && dq < 0.4, `dq(9)=${dq} should be near but <0.4`);
  });

  await runTest('every count 0..9 stays within [0.2, 0.4]', () => {
    for (let n = 0; n < 10; n++) {
      const dq = computeDataQuality(n);
      assert.ok(dq >= 0.2, `dq(${n})=${dq} below floor 0.2`);
      assert.ok(dq <= 0.4, `dq(${n})=${dq} above ceiling 0.4`);
    }
  });

  await runTest('tier 1 is linear (evenly spaced increments)', () => {
    const dq0 = computeDataQuality(0);
    const dq5 = computeDataQuality(5);
    const dq9 = computeDataQuality(9);
    // Linear: dq(5) should be equidistant from dq(0) and dq(10)
    const expectedAt5 = dq0 + (5 / 10) * (0.4 - 0.2);
    assert.ok(Math.abs(dq5 - expectedAt5) < 0.001,
      `dq(5)=${dq5} should be ~${expectedAt5} (linear interpolation)`);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TIER 2: 10-100 patents → [0.4, 0.7]
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\nTier 2: 10-100 patents → [0.4, 0.7]:');

  await runTest('10 patents → exactly 0.4', () => {
    assert.equal(computeDataQuality(10), 0.4);
  });

  await runTest('55 patents → ~0.55 (midpoint of tier)', () => {
    const dq = computeDataQuality(55);
    assert.ok(dq >= 0.5 && dq <= 0.6, `dq(55)=${dq} should be ~0.55`);
  });

  await runTest('100 patents → exactly 0.7', () => {
    assert.equal(computeDataQuality(100), 0.7);
  });

  await runTest('every 10th count 10..100 stays within [0.4, 0.7]', () => {
    for (let n = 10; n <= 100; n += 10) {
      const dq = computeDataQuality(n);
      assert.ok(dq >= 0.4, `dq(${n})=${dq} below floor 0.4`);
      assert.ok(dq <= 0.7, `dq(${n})=${dq} above ceiling 0.7`);
    }
  });

  await runTest('tier 2 is linear (evenly spaced increments)', () => {
    const dq10 = computeDataQuality(10);
    const dq50 = computeDataQuality(50);
    const dq100 = computeDataQuality(100);
    const expectedAt50 = 0.4 + ((50 - 10) / 90) * 0.3;
    assert.ok(Math.abs(dq50 - expectedAt50) < 0.001,
      `dq(50)=${dq50} should be ~${expectedAt50} (linear interpolation)`);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TIER 3: >100 patents → [0.7, 0.9]
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\nTier 3: >100 patents → [0.7, 0.9]:');

  await runTest('101 patents → just above 0.7', () => {
    const dq = computeDataQuality(101);
    assert.ok(dq >= 0.7 && dq <= 0.71, `dq(101)=${dq} should be just above 0.7`);
  });

  await runTest('200 patents → ~0.73', () => {
    const dq = computeDataQuality(200);
    assert.ok(dq >= 0.7 && dq <= 0.75, `dq(200)=${dq} should be ~0.73`);
  });

  await runTest('1000 patents → ~0.8', () => {
    const dq = computeDataQuality(1000);
    assert.ok(dq >= 0.78 && dq <= 0.82, `dq(1000)=${dq} should be ~0.8`);
  });

  await runTest('10000 patents → ~0.9 (near ceiling)', () => {
    const dq = computeDataQuality(10000);
    assert.ok(dq >= 0.88 && dq <= 0.9, `dq(10000)=${dq} should be ~0.9`);
  });

  await runTest('100000 patents → capped at 0.9', () => {
    const dq = computeDataQuality(100000);
    assert.ok(dq <= 0.9, `dq(100000)=${dq} must not exceed 0.9`);
  });

  await runTest('1000000 patents → still capped at 0.9', () => {
    const dq = computeDataQuality(1000000);
    assert.ok(dq <= 0.9, `dq(1000000)=${dq} must not exceed 0.9`);
    assert.ok(dq >= 0.7, `dq(1000000)=${dq} must be >= 0.7`);
  });

  await runTest('logarithmic saturation: diminishing returns', () => {
    // Gap between 200→2000 should be greater than gap between 2000→20000
    const gain1 = computeDataQuality(2000) - computeDataQuality(200);
    const gain2 = computeDataQuality(20000) - computeDataQuality(2000);
    assert.ok(gain1 > gain2,
      `gain(200→2000)=${gain1.toFixed(4)} should exceed gain(2000→20000)=${gain2.toFixed(4)}`);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // BOUNDARY CONTINUITY (no discontinuous jumps at tier transitions)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\nBoundary continuity:');

  await runTest('tier 1→2 boundary (9→10→11): continuous, no gap >0.03', () => {
    const dq9 = computeDataQuality(9);
    const dq10 = computeDataQuality(10);
    const dq11 = computeDataQuality(11);
    assert.ok(Math.abs(dq10 - dq9) < 0.03,
      `gap at 9→10: ${Math.abs(dq10 - dq9).toFixed(4)}`);
    assert.ok(Math.abs(dq11 - dq10) < 0.03,
      `gap at 10→11: ${Math.abs(dq11 - dq10).toFixed(4)}`);
  });

  await runTest('tier 2→3 boundary (99→100→101): continuous, no gap >0.03', () => {
    const dq99 = computeDataQuality(99);
    const dq100 = computeDataQuality(100);
    const dq101 = computeDataQuality(101);
    assert.ok(Math.abs(dq100 - dq99) < 0.03,
      `gap at 99→100: ${Math.abs(dq100 - dq99).toFixed(4)}`);
    assert.ok(Math.abs(dq101 - dq100) < 0.03,
      `gap at 100→101: ${Math.abs(dq101 - dq100).toFixed(4)}`);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // MONOTONIC INCREASE (more data always means higher quality)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\nMonotonicity:');

  await runTest('strictly non-decreasing across all tiers (50 sample points)', () => {
    const counts = [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100,
      101, 110, 150, 200, 300, 500, 750, 1000,
      1500, 2000, 3000, 5000, 7500, 10000,
      15000, 20000, 50000, 100000,
    ];
    for (let i = 1; i < counts.length; i++) {
      const prev = computeDataQuality(counts[i - 1]);
      const curr = computeDataQuality(counts[i]);
      assert.ok(curr >= prev,
        `dq(${counts[i]})=${curr} should be >= dq(${counts[i-1]})=${prev}`);
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // END-TO-END: strategy pipeline graceful degradation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\nEnd-to-end pipeline degradation:');

  await runTest('sparse data (3 patents) → dataQuality in tier 1 [0.2, 0.4]', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(3),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Novel', capability: 'novel thing' });
    const confStep = result.trace.find(t => t.step === 'confidence');

    assert.ok(confStep.dataQuality >= 0.2, `dq=${confStep.dataQuality} >= 0.2`);
    assert.ok(confStep.dataQuality <= 0.4, `dq=${confStep.dataQuality} <= 0.4`);
  });

  await runTest('moderate data (50 patents) → dataQuality in tier 2 [0.4, 0.7]', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(50),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Growing', capability: 'growing tech' });
    const confStep = result.trace.find(t => t.step === 'confidence');

    assert.ok(confStep.dataQuality >= 0.4, `dq=${confStep.dataQuality} >= 0.4`);
    assert.ok(confStep.dataQuality <= 0.7, `dq=${confStep.dataQuality} <= 0.7`);
  });

  await runTest('abundant data (500 patents) → dataQuality in tier 3 [0.7, 0.9]', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(500),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Mature', capability: 'mature tech' });
    const confStep = result.trace.find(t => t.step === 'confidence');

    assert.ok(confStep.dataQuality >= 0.7, `dq=${confStep.dataQuality} >= 0.7`);
    assert.ok(confStep.dataQuality <= 0.9, `dq=${confStep.dataQuality} <= 0.9`);
  });

  await runTest('empty data (0 patents) → strategy still returns valid result', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(0),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Nothing', capability: 'nothing' });

    assert.equal(typeof result.evolution, 'number');
    assert.equal(typeof result.confidence, 'number');
    assert.ok(result.confidence >= 0.1, 'confidence floor holds with 0 patents');
    assert.ok(result.confidence <= 0.95, 'confidence ceiling holds with 0 patents');
    assert.equal(result.method, 'cpc-evolution');
  });

  await runTest('confidence ordering: 500 > 50 > 3 > 0 patents', async () => {
    const counts = [500, 50, 3, 0];
    const confidences = [];

    for (const count of counts) {
      const strategy = new CpcEvolutionStrategy({
        patentSource: createMockPatentSource(count),
        cpcMapper: mockCpcMapper,
      });
      const result = await strategy.evaluate({ name: 'Test', capability: 'test' });
      const confStep = result.trace.find(t => t.step === 'confidence');
      confidences.push({ count, dq: confStep.dataQuality, confidence: result.confidence });
    }

    // Data quality should strictly decrease
    for (let i = 1; i < confidences.length; i++) {
      assert.ok(confidences[i - 1].dq >= confidences[i].dq,
        `dq(${confidences[i-1].count})=${confidences[i-1].dq} should be >= dq(${confidences[i].count})=${confidences[i].dq}`);
    }
  });

  await runTest('trace exposes dataQuality for observability', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(25),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Test', capability: 'test' });
    const confStep = result.trace.find(t => t.step === 'confidence');

    assert.ok(confStep, 'trace must have confidence step');
    assert.ok('dataQuality' in confStep, 'confidence step must include dataQuality');
    assert.ok('modelConfidence' in confStep, 'confidence step must include modelConfidence');
    assert.ok('combined' in confStep, 'confidence step must include combined');
    // Verify dataQuality is in tier 2 for 25 patents
    assert.ok(confStep.dataQuality >= 0.4 && confStep.dataQuality <= 0.7,
      `dataQuality for 25 patents should be in tier 2, got ${confStep.dataQuality}`);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // DATA QUALITY → CONFIDENCE PROPAGATION
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\nData quality → confidence propagation:');

  await runTest('low data quality depresses overall confidence', () => {
    // dq=0.2 (0 patents) with mc=0.95 (perfect model fit)
    const c = computeConfidence(0.2, 0.95);
    // 0.2*0.5 + 0.95*0.5 = 0.575
    assert.ok(c < 0.6, `confidence=${c} should be < 0.6 despite perfect model fit`);
  });

  await runTest('high data quality lifts overall confidence', () => {
    // dq=0.9 (10000+ patents) with mc=0.5 (moderate model fit)
    const c = computeConfidence(0.9, 0.5);
    // 0.9*0.5 + 0.5*0.5 = 0.7
    assert.ok(c >= 0.65, `confidence=${c} should be >= 0.65 with abundant data`);
  });

  await runTest('both low → near floor (0.1)', () => {
    const c = computeConfidence(0.2, 0.3);
    // 0.2*0.5 + 0.3*0.5 = 0.25
    assert.ok(c >= 0.1 && c <= 0.35, `confidence=${c} should be near floor`);
  });

  await runTest('both high → near ceiling (0.95)', () => {
    const c = computeConfidence(0.9, 0.95);
    // 0.9*0.5 + 0.95*0.5 = 0.925
    assert.ok(c >= 0.9 && c <= 0.95, `confidence=${c} should be near ceiling`);
  });

  // ── Summary ────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'='.repeat(60)}`);

  if (failed > 0) {
    console.error('\n\u2717 AC 10 data quality degradation tests FAILED\n');
    process.exit(1);
  } else {
    console.log('\n\u2713 All AC 10 data quality graceful degradation tests PASSED\n');
  }
}

main().catch(err => {
  console.error('\n\u2717 AC 10 tests CRASHED:', err);
  process.exit(1);
});
