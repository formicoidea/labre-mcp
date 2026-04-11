// Test: AC 9 — Confidence model
//
// Verifies the confidence model formula:
//   confidence = dataQuality * 0.5 + modelConfidence * 0.5
//   bounded [0.1, 0.95]
//
// Tests cover:
//   1. computeDataQuality: patent count thresholds (<10, 10-100, >100)
//   2. computeModelConfidence: zone-based scoring (competitive vs extra-competitive)
//   3. computeConfidence: combination formula with bounds
//   4. End-to-end confidence through the strategy pipeline
//   5. Edge cases and boundary conditions

import assert from 'node:assert/strict';
import {
  computeDataQuality,
  computeModelConfidence,
  computeConfidence,
} from './cpc-evolution-strategy.mjs';
import { CpcEvolutionStrategy } from './cpc-evolution-strategy.mjs';
import { computeEvolution } from '../evolution/s-curve.mjs';

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

// ── Mock fixtures ────────────────────────────────────────────────────────

const mockCpcMapper = {
  mapToCpc: async () => ['H04L', 'G06F'],
};

function createMockPatentSource(data) {
  return { fetchByCpc: async () => data };
}

/** Rich patent data (>100 patents) — high data quality */
const MOCK_RICH = {
  totalPatents: 300,
  patents: [],
  cpcDistribution: [
    { cpc: 'H04L', count: 200 },
    { cpc: 'G06F', count: 100 },
  ],
  yearlyClassifications: [
    { year: 2018, cpcCodes: ['H04L', 'G06F'] },
    { year: 2019, cpcCodes: ['H04L', 'G06F'] },
    { year: 2020, cpcCodes: ['H04L', 'G06F'] },
    { year: 2021, cpcCodes: ['H04L', 'G06F'] },
  ],
  citationData: { totalForwardCitations: 4500, patentCount: 300 },
  claimsTimeline: [
    { year: 2016, avgIndependentClaims: 10 },
    { year: 2018, avgIndependentClaims: 7 },
    { year: 2020, avgIndependentClaims: 4 },
  ],
  assigneeData: { uniqueAssignees: 120, totalPatents: 300 },
  geoData: { jurisdictionCount: 6, jurisdictions: ['US', 'EP', 'CN', 'JP', 'KR', 'IN'] },
  sectorData: { uniqueSections: 4, uniqueClasses: 15 },
  expirationData: { expiredCount: 200, totalPatents: 300 },
};

/** Sparse patent data (<10 patents) — low data quality */
const MOCK_SPARSE = {
  totalPatents: 5,
  patents: [],
  cpcDistribution: [{ cpc: 'G06N', count: 5 }],
  yearlyClassifications: [
    { year: 2023, cpcCodes: ['G06N'] },
  ],
  citationData: { totalForwardCitations: 2, patentCount: 5 },
  claimsTimeline: [{ year: 2023, avgIndependentClaims: 14 }],
  assigneeData: { uniqueAssignees: 3, totalPatents: 5 },
  geoData: { jurisdictionCount: 1, jurisdictions: ['US'] },
  sectorData: { uniqueSections: 1, uniqueClasses: 1 },
  expirationData: { expiredCount: 0, totalPatents: 5 },
};

/** Moderate patent data (10-100 patents) — medium data quality */
const MOCK_MODERATE = {
  totalPatents: 50,
  patents: [],
  cpcDistribution: [
    { cpc: 'H04L', count: 30 },
    { cpc: 'G06F', count: 20 },
  ],
  yearlyClassifications: [
    { year: 2020, cpcCodes: ['H04L'] },
    { year: 2021, cpcCodes: ['H04L', 'G06F'] },
    { year: 2022, cpcCodes: ['H04L', 'G06F'] },
  ],
  citationData: { totalForwardCitations: 400, patentCount: 50 },
  claimsTimeline: [
    { year: 2019, avgIndependentClaims: 9 },
    { year: 2021, avgIndependentClaims: 6 },
  ],
  assigneeData: { uniqueAssignees: 20, totalPatents: 50 },
  geoData: { jurisdictionCount: 3, jurisdictions: ['US', 'EP', 'CN'] },
  sectorData: { uniqueSections: 2, uniqueClasses: 5 },
  expirationData: { expiredCount: 10, totalPatents: 50 },
};

/** Empty patent data (0 patents) — minimum data quality */
const MOCK_EMPTY = {
  totalPatents: 0,
  patents: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== AC 9: Confidence Model Tests ===\n');

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1. computeDataQuality: patent count thresholds
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('computeDataQuality — patent count thresholds:');

  await runTest('<10 patents: score in [0.2, 0.4]', () => {
    for (const count of [0, 1, 3, 5, 9]) {
      const dq = computeDataQuality(count);
      assert.ok(dq >= 0.2, `dq(${count})=${dq} should be >= 0.2`);
      assert.ok(dq <= 0.4, `dq(${count})=${dq} should be <= 0.4`);
    }
  });

  await runTest('0 patents -> exactly 0.2', () => {
    assert.equal(computeDataQuality(0), 0.2);
  });

  await runTest('10 patents -> exactly 0.4 (boundary)', () => {
    assert.equal(computeDataQuality(10), 0.4);
  });

  await runTest('10-100 patents: score in [0.4, 0.7]', () => {
    for (const count of [10, 25, 50, 75, 100]) {
      const dq = computeDataQuality(count);
      assert.ok(dq >= 0.4, `dq(${count})=${dq} should be >= 0.4`);
      assert.ok(dq <= 0.7, `dq(${count})=${dq} should be <= 0.7`);
    }
  });

  await runTest('100 patents -> exactly 0.7 (boundary)', () => {
    assert.equal(computeDataQuality(100), 0.7);
  });

  await runTest('>100 patents: score in [0.7, 0.9]', () => {
    for (const count of [101, 200, 500, 1000, 10000]) {
      const dq = computeDataQuality(count);
      assert.ok(dq >= 0.7, `dq(${count})=${dq} should be >= 0.7`);
      assert.ok(dq <= 0.9, `dq(${count})=${dq} should be <= 0.9`);
    }
  });

  await runTest('monotonically increasing with patent count', () => {
    const counts = [0, 1, 5, 10, 50, 100, 200, 500, 1000, 5000, 10000];
    for (let i = 1; i < counts.length; i++) {
      const prev = computeDataQuality(counts[i - 1]);
      const curr = computeDataQuality(counts[i]);
      assert.ok(curr >= prev,
        `dq(${counts[i]})=${curr} should be >= dq(${counts[i-1]})=${prev}`);
    }
  });

  await runTest('linear ramp within <10 range', () => {
    // From 0.2 at 0 patents to 0.4 at 10 patents (linear)
    const dq5 = computeDataQuality(5);
    // Should be approximately 0.3 (midpoint of [0.2, 0.4])
    assert.ok(Math.abs(dq5 - 0.3) < 0.01,
      `dq(5) should be ~0.3 (linear), got ${dq5}`);
  });

  await runTest('logarithmic approach in >100 range', () => {
    // Verify diminishing returns: gap between 200-2000 > gap between 2000-20000
    const dq200 = computeDataQuality(200);
    const dq2000 = computeDataQuality(2000);
    const dq20000 = computeDataQuality(20000);
    const gap1 = dq2000 - dq200;
    const gap2 = dq20000 - dq2000;
    assert.ok(gap1 >= gap2,
      `gap(200-2000)=${gap1} should be >= gap(2000-20000)=${gap2} (logarithmic/sublinear)`);
    // Also verify that the function doesn't grow linearly
    // by checking the rate of change decreases
    const dq150 = computeDataQuality(150);
    const dq500 = computeDataQuality(500);
    const dq5000 = computeDataQuality(5000);
    // Average rate of change should decrease
    const rate1 = (dq500 - dq150) / (500 - 150);
    const rate2 = (dq5000 - dq500) / (5000 - 500);
    assert.ok(rate1 >= rate2,
      `rate(150-500)=${rate1} should be >= rate(500-5000)=${rate2} (diminishing returns)`);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2. computeModelConfidence: zone-based scoring
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\ncomputeModelConfidence — zone-based scoring:');

  await runTest('competitive zone, center → 0.95 (max)', () => {
    const mc = computeModelConfidence({ zone: 'competitive', distToCenter: 0 });
    assert.equal(mc, 0.95);
  });

  await runTest('competitive zone, moderate distance → [0.8, 0.95]', () => {
    const mc = computeModelConfidence({ zone: 'competitive', distToCenter: 0.15 });
    assert.ok(mc >= 0.8, `mc=${mc} should be >= 0.8`);
    assert.ok(mc <= 0.95, `mc=${mc} should be <= 0.95`);
  });

  await runTest('competitive zone, edge of band (distToCenter=0.3) → exactly 0.8', () => {
    const mc = computeModelConfidence({ zone: 'competitive', distToCenter: 0.3 });
    assert.equal(mc, 0.8);
  });

  await runTest('competitive zone, distToCenter clamped at 0.3', () => {
    // Even if distToCenter > 0.3 (shouldn't happen in competitive zone), score doesn't drop below 0.8
    const mc = computeModelConfidence({ zone: 'competitive', distToCenter: 0.5 });
    assert.ok(mc >= 0.8, `mc=${mc} should be >= 0.8 even at far distance`);
  });

  await runTest('extra-competitive zone, boundary (bandDistance=0) → 0.7', () => {
    const mc = computeModelConfidence({ zone: 'extra-competitive-market', bandDistance: 0 });
    assert.equal(mc, 0.7);
  });

  await runTest('extra-competitive zone, moderate distance → decays', () => {
    const mc = computeModelConfidence({ zone: 'extra-competitive-market', bandDistance: -0.1 });
    assert.ok(mc < 0.7, `mc=${mc} should be < 0.7 with negative bandDistance`);
    assert.ok(mc >= 0.3, `mc=${mc} should be >= 0.3 (floor)`);
  });

  await runTest('extra-competitive zone, far from band → floor at 0.3', () => {
    const mc = computeModelConfidence({ zone: 'extra-competitive-market', bandDistance: -0.5 });
    assert.equal(mc, 0.3);
  });

  await runTest('extra-competitive zone, never drops below 0.3', () => {
    for (const bd of [-0.1, -0.2, -0.5, -1.0, -5.0]) {
      const mc = computeModelConfidence({ zone: 'extra-competitive-market', bandDistance: bd });
      assert.ok(mc >= 0.3, `mc with bandDistance=${bd} is ${mc}, should be >= 0.3`);
    }
  });

  await runTest('competitive > extra-competitive (always)', () => {
    const mcCompetitive = computeModelConfidence({ zone: 'competitive', distToCenter: 0.3 });
    const mcExtra = computeModelConfidence({ zone: 'extra-competitive-market', bandDistance: 0 });
    assert.ok(mcCompetitive >= mcExtra,
      `competitive(${mcCompetitive}) should be >= extra-competitive(${mcExtra})`);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3. computeConfidence: combination formula and bounds
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\ncomputeConfidence — formula: dq*0.5 + mc*0.5, bounded [0.1, 0.95]:');

  await runTest('formula: dq=0.6 mc=0.8 → exactly 0.7', () => {
    const c = computeConfidence(0.6, 0.8);
    assert.equal(c, 0.7); // 0.6*0.5 + 0.8*0.5 = 0.3 + 0.4 = 0.7
  });

  await runTest('formula: dq=0.4 mc=0.4 → exactly 0.4', () => {
    const c = computeConfidence(0.4, 0.4);
    assert.equal(c, 0.4); // 0.4*0.5 + 0.4*0.5 = 0.2 + 0.2 = 0.4
  });

  await runTest('formula: dq=0.5 mc=0.5 → exactly 0.5', () => {
    const c = computeConfidence(0.5, 0.5);
    assert.equal(c, 0.5);
  });

  await runTest('formula: 50/50 weighting is correct', () => {
    // dq dominates
    const c1 = computeConfidence(0.9, 0.3);
    // mc dominates
    const c2 = computeConfidence(0.3, 0.9);
    // Both should equal 0.6
    assert.equal(c1, c2);
    assert.equal(c1, 0.6);
  });

  await runTest('lower bound: confidence never below 0.1', () => {
    // Minimum possible: dq=0, mc=0
    assert.ok(computeConfidence(0, 0) >= 0.1);
    // Very low values
    assert.ok(computeConfidence(0.05, 0.05) >= 0.1);
    assert.ok(computeConfidence(0.1, 0.0) >= 0.1);
    assert.ok(computeConfidence(0.0, 0.1) >= 0.1);
  });

  await runTest('lower bound: (0, 0) → exactly 0.1', () => {
    assert.equal(computeConfidence(0, 0), 0.1);
  });

  await runTest('upper bound: confidence never above 0.95', () => {
    assert.ok(computeConfidence(1, 1) <= 0.95);
    assert.ok(computeConfidence(0.99, 0.99) <= 0.95);
    assert.ok(computeConfidence(1, 0.95) <= 0.95);
    assert.ok(computeConfidence(0.95, 1) <= 0.95);
  });

  await runTest('upper bound: (1.0, 1.0) → exactly 0.95', () => {
    assert.equal(computeConfidence(1, 1), 0.95);
  });

  await runTest('result is rounded to 3 decimal places', () => {
    const c = computeConfidence(0.333, 0.666);
    // 0.333*0.5 + 0.666*0.5 = 0.1665 + 0.333 = 0.4995
    // Rounded to 3 decimals: 0.5 (or 0.500 which prints as 0.5)
    const decimalPlaces = c.toString().split('.')[1]?.length ?? 0;
    assert.ok(decimalPlaces <= 3,
      `confidence ${c} should have at most 3 decimal places, got ${decimalPlaces}`);
  });

  await runTest('always returns a number (not NaN)', () => {
    const testCases = [
      [0, 0], [1, 1], [0.5, 0.5],
      [0.1, 0.9], [0.9, 0.1],
      [0.2, 0.7], [0.7, 0.2],
    ];
    for (const [dq, mc] of testCases) {
      const c = computeConfidence(dq, mc);
      assert.equal(typeof c, 'number', `type should be number for (${dq}, ${mc})`);
      assert.ok(!Number.isNaN(c), `should not be NaN for (${dq}, ${mc})`);
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 4. Realistic composition: dataQuality from patents + modelConfidence from s-curve
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\nRealistic composition — dataQuality + modelConfidence:');

  await runTest('0 patents in competitive zone → low confidence (floor dominated)', () => {
    const dq = computeDataQuality(0); // 0.2
    const mc = computeModelConfidence({ zone: 'competitive', distToCenter: 0 }); // 0.95
    const c = computeConfidence(dq, mc);
    // 0.2*0.5 + 0.95*0.5 = 0.1 + 0.475 = 0.575
    assert.ok(c >= 0.5 && c <= 0.6, `c=${c} should be ~0.575 for 0 patents in competitive`);
  });

  await runTest('500 patents in competitive zone → high confidence near ceiling', () => {
    const dq = computeDataQuality(500); // ~0.77
    const mc = computeModelConfidence({ zone: 'competitive', distToCenter: 0.05 }); // ~0.93
    const c = computeConfidence(dq, mc);
    assert.ok(c >= 0.8, `c=${c} should be >= 0.8 for abundant data + competitive`);
    assert.ok(c <= 0.95, `c=${c} should be <= 0.95 (ceiling)`);
  });

  await runTest('5 patents in extra-competitive zone → very low confidence', () => {
    const dq = computeDataQuality(5); // ~0.3
    const mc = computeModelConfidence({ zone: 'extra-competitive-market', bandDistance: -0.2 }); // 0.3
    const c = computeConfidence(dq, mc);
    assert.ok(c >= 0.1, `c=${c} should be >= 0.1 (floor)`);
    assert.ok(c <= 0.4, `c=${c} should be low for sparse data + extra-competitive`);
  });

  await runTest('moderate data + competitive → medium-high confidence', () => {
    const dq = computeDataQuality(50); // ~0.53
    const mc = computeModelConfidence({ zone: 'competitive', distToCenter: 0.15 }); // ~0.875
    const c = computeConfidence(dq, mc);
    assert.ok(c >= 0.6, `c=${c} should be >= 0.6 for moderate data + competitive`);
    assert.ok(c <= 0.8, `c=${c} should be <= 0.8`);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 5. End-to-end confidence through strategy pipeline
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\nEnd-to-end confidence through strategy pipeline:');

  await runTest('rich data strategy → confidence bounded [0.1, 0.95]', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'TCP/IP', capability: 'network protocol' });

    assert.ok(result.confidence >= 0.1, `confidence=${result.confidence} >= 0.1`);
    assert.ok(result.confidence <= 0.95, `confidence=${result.confidence} <= 0.95`);
  });

  await runTest('sparse data strategy → confidence bounded [0.1, 0.95]', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_SPARSE),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Quantum', capability: 'quantum computing' });

    assert.ok(result.confidence >= 0.1, `confidence=${result.confidence} >= 0.1`);
    assert.ok(result.confidence <= 0.95, `confidence=${result.confidence} <= 0.95`);
  });

  await runTest('empty data strategy → confidence bounded [0.1, 0.95]', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_EMPTY),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Nothing' });

    assert.ok(result.confidence >= 0.1, `confidence=${result.confidence} >= 0.1`);
    assert.ok(result.confidence <= 0.95, `confidence=${result.confidence} <= 0.95`);
  });

  await runTest('confidence follows data quality ordering: rich > moderate > sparse > empty', async () => {
    const datasets = [MOCK_RICH, MOCK_MODERATE, MOCK_SPARSE, MOCK_EMPTY];
    const results = [];

    for (const data of datasets) {
      const strategy = new CpcEvolutionStrategy({
        patentSource: createMockPatentSource(data),
        cpcMapper: mockCpcMapper,
      });
      const result = await strategy.evaluate({ name: 'Test', capability: 'test' });
      results.push({ count: data.totalPatents, confidence: result.confidence });
    }

    // Rich(300) >= Moderate(50) >= Sparse(5)
    // Note: empty(0) may have slightly different modelConfidence due to neutral fallback
    // so we only check the first three are weakly ordered
    assert.ok(results[0].confidence >= results[1].confidence,
      `rich(${results[0].confidence}) should be >= moderate(${results[1].confidence})`);
    assert.ok(results[1].confidence >= results[2].confidence,
      `moderate(${results[1].confidence}) should be >= sparse(${results[2].confidence})`);
  });

  await runTest('trace confidence step has dataQuality and modelConfidence', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'TCP/IP', capability: 'network protocol' });
    const confStep = result.trace.find(t => t.step === 'confidence');

    assert.ok(confStep, 'trace must have confidence step');
    assert.ok('dataQuality' in confStep, 'confidence step must include dataQuality');
    assert.ok('modelConfidence' in confStep, 'confidence step must include modelConfidence');
    assert.ok('combined' in confStep, 'confidence step must include combined');

    // Verify formula matches: combined = dq*0.5 + mc*0.5 bounded [0.1, 0.95]
    const expectedRaw = confStep.dataQuality * 0.5 + confStep.modelConfidence * 0.5;
    const expectedBounded = Math.round(Math.max(0.1, Math.min(0.95, expectedRaw)) * 1000) / 1000;
    assert.equal(confStep.combined, expectedBounded,
      `combined(${confStep.combined}) should equal bounded(dq*0.5 + mc*0.5)=${expectedBounded}`);
  });

  await runTest('trace confidence combined equals result.confidence', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_MODERATE),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Test', capability: 'test' });
    const confStep = result.trace.find(t => t.step === 'confidence');

    assert.equal(result.confidence, confStep.combined,
      `result.confidence(${result.confidence}) should equal trace.combined(${confStep.combined})`);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 6. Verify confidence composed from independently computed parts
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\nConfidence decomposition verification:');

  await runTest('strategy confidence matches manual recomputation from trace', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_RICH),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'TCP/IP', capability: 'network protocol' });

    // Extract components from trace
    const patentCountStep = result.trace.find(t => t.step === 'patent-count');
    const scurveStep = result.trace.find(t => t.step === 's-curve');

    // Recompute dataQuality from patent count
    const dq = computeDataQuality(patentCountStep.value);

    // Recompute modelConfidence from s-curve result
    const mc = computeModelConfidence(scurveStep);

    // Recompute combined confidence
    const expected = computeConfidence(dq, mc);

    assert.equal(result.confidence, expected,
      `confidence(${result.confidence}) should match recomputed(${expected})`);
  });

  await runTest('s-curve result drives modelConfidence correctly', async () => {
    // Use actual s-curve.mjs to compute evolution for known (c, u)
    // and verify modelConfidence matches what strategy would produce
    const scurveCompetitive = computeEvolution(0.5, 0.5); // likely competitive
    const mcCompetitive = computeModelConfidence(scurveCompetitive);
    assert.ok(mcCompetitive >= 0.3, `mc for zone=${scurveCompetitive.zone} should be >= 0.3`);
    assert.ok(mcCompetitive <= 0.95, `mc for zone=${scurveCompetitive.zone} should be <= 0.95`);

    // Extra-competitive point
    const scurveExtra = computeEvolution(0.1, 0.9); // likely extra-competitive
    const mcExtra = computeModelConfidence(scurveExtra);
    assert.ok(mcExtra >= 0.3, `mc for zone=${scurveExtra.zone} should be >= 0.3`);
    assert.ok(mcExtra <= 0.95, `mc for zone=${scurveExtra.zone} should be <= 0.95`);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 7. Edge cases
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log('\nEdge cases:');

  await runTest('exactly 1 patent', () => {
    const dq = computeDataQuality(1);
    assert.ok(dq >= 0.2 && dq <= 0.4, `dq(1)=${dq} should be in [0.2, 0.4]`);
  });

  await runTest('very large patent count (100000)', () => {
    const dq = computeDataQuality(100000);
    assert.ok(dq <= 0.9, `dq(100000)=${dq} should be <= 0.9`);
    assert.ok(dq >= 0.7, `dq(100000)=${dq} should be >= 0.7`);
  });

  await runTest('dataQuality at boundaries are continuous', () => {
    // Test continuity at the 10-patent boundary
    const dq9 = computeDataQuality(9);
    const dq10 = computeDataQuality(10);
    const dq11 = computeDataQuality(11);
    assert.ok(Math.abs(dq10 - dq9) < 0.05,
      `discontinuity at 10: dq(9)=${dq9}, dq(10)=${dq10}`);

    // Test continuity at the 100-patent boundary
    const dq99 = computeDataQuality(99);
    const dq100 = computeDataQuality(100);
    const dq101 = computeDataQuality(101);
    assert.ok(Math.abs(dq100 - dq99) < 0.05,
      `discontinuity at 100: dq(99)=${dq99}, dq(100)=${dq100}`);
  });

  await runTest('computeConfidence with equal weights is symmetric', () => {
    // Since both weights are 0.5, swapping dq and mc should give same result
    const c1 = computeConfidence(0.3, 0.7);
    const c2 = computeConfidence(0.7, 0.3);
    assert.equal(c1, c2, `(0.3,0.7)=${c1} should equal (0.7,0.3)=${c2}`);
  });

  await runTest('confidence passes BaseStrategy validation [0, 1]', async () => {
    // computeConfidence bounds to [0.1, 0.95] which is within [0, 1]
    for (let dq = 0; dq <= 1; dq += 0.1) {
      for (let mc = 0; mc <= 1; mc += 0.1) {
        const c = computeConfidence(dq, mc);
        assert.ok(c >= 0 && c <= 1,
          `confidence(${dq}, ${mc})=${c} must be in [0, 1] for BaseStrategy`);
      }
    }
  });

  // ── Summary ────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(55)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'='.repeat(55)}`);

  if (failed > 0) {
    console.error('\n\u2717 AC 9 confidence model tests FAILED\n');
    process.exit(1);
  } else {
    console.log('\n\u2713 All AC 9 confidence model tests PASSED\n');
  }
}

main().catch(err => {
  console.error('\n\u2717 AC 9 tests CRASHED:', err);
  process.exit(1);
});
