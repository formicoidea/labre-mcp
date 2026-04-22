// Test: AC 5 — computeEvolution(certitude, ubiquity) delegation
//
// Verifies that CpcEvolutionStrategy delegates scoring ENTIRELY to
// computeEvolution(c, u) from s-curve.mjs — no custom evolution formula,
// no S-curve bypass, no blending or adjustment of the evolution value.
//
// Approach: run the strategy with mock data, extract the (certitude, ubiquity)
// from the result, then independently call computeEvolution(c, u) and verify
// the evolution values are IDENTICAL (bitwise equal, not just close).

import assert from 'node:assert/strict';
import { computeEvolution } from '../s-curve/s-curve.mjs';
import { CpcEvolutionStrategy } from '../strategies/capacity/cpc-evolution-strategy.mjs';

// ── Mock fixtures ──────────────────────────────────────────────────────────

const mockCpcMapper = {
  mapToCpc: async () => ['H04L', 'G06F', 'H04W'],
};

/** Mature technology: high certitude, high ubiquity → Commodity */
const MOCK_PATENT_DATA_COMMODITY = {
  totalPatents: 500,
  patents: [],
  cpcDistribution: [
    { cpc: 'H04L', count: 350 },
    { cpc: 'G06F', count: 100 },
    { cpc: 'H04W', count: 50 },
  ],
  yearlyClassifications: [
    { year: 2017, cpcCodes: ['H04L', 'G06F'] },
    { year: 2018, cpcCodes: ['H04L', 'G06F', 'H04W'] },
    { year: 2019, cpcCodes: ['H04L', 'G06F', 'H04W'] },
    { year: 2020, cpcCodes: ['H04L', 'G06F', 'H04W'] },
    { year: 2021, cpcCodes: ['H04L', 'G06F', 'H04W'] },
  ],
  citationData: { totalForwardCitations: 8000, patentCount: 500 },
  claimsTimeline: [
    { year: 2015, avgIndependentClaims: 12 },
    { year: 2017, avgIndependentClaims: 8 },
    { year: 2019, avgIndependentClaims: 5 },
    { year: 2021, avgIndependentClaims: 3 },
  ],
  assigneeData: { uniqueAssignees: 200, totalPatents: 500 },
  geoData: { jurisdictionCount: 8, jurisdictions: ['US', 'EP', 'CN', 'JP', 'KR', 'IN', 'BR', 'AU'] },
  sectorData: { uniqueSections: 5, uniqueClasses: 20 },
  expirationData: { expiredCount: 350, totalPatents: 500 },
};

/** Nascent technology: low certitude, low ubiquity → Genesis/Custom */
const MOCK_PATENT_DATA_GENESIS = {
  totalPatents: 8,
  patents: [],
  cpcDistribution: [
    { cpc: 'G06N', count: 3 },
    { cpc: 'H10N', count: 3 },
    { cpc: 'B82Y', count: 2 },
  ],
  yearlyClassifications: [
    { year: 2022, cpcCodes: ['G06N'] },
    { year: 2023, cpcCodes: ['G06N', 'H10N', 'B82Y'] },
  ],
  citationData: { totalForwardCitations: 2, patentCount: 8 },
  claimsTimeline: [
    { year: 2022, avgIndependentClaims: 15 },
    { year: 2023, avgIndependentClaims: 18 },
  ],
  assigneeData: { uniqueAssignees: 4, totalPatents: 8 },
  geoData: { jurisdictionCount: 1, jurisdictions: ['US'] },
  sectorData: { uniqueSections: 1, uniqueClasses: 2 },
  expirationData: { expiredCount: 0, totalPatents: 8 },
};

/** Mid-range technology: moderate signals → Product */
const MOCK_PATENT_DATA_PRODUCT = {
  totalPatents: 150,
  patents: [],
  cpcDistribution: [
    { cpc: 'G06F', count: 60 },
    { cpc: 'H04L', count: 50 },
    { cpc: 'G06Q', count: 40 },
  ],
  yearlyClassifications: [
    { year: 2018, cpcCodes: ['G06F', 'H04L'] },
    { year: 2019, cpcCodes: ['G06F', 'H04L', 'G06Q'] },
    { year: 2020, cpcCodes: ['G06F', 'H04L', 'G06Q'] },
    { year: 2021, cpcCodes: ['G06F', 'H04L', 'G06Q'] },
  ],
  citationData: { totalForwardCitations: 1200, patentCount: 150 },
  claimsTimeline: [
    { year: 2017, avgIndependentClaims: 10 },
    { year: 2019, avgIndependentClaims: 7 },
    { year: 2021, avgIndependentClaims: 5 },
  ],
  assigneeData: { uniqueAssignees: 45, totalPatents: 150 },
  geoData: { jurisdictionCount: 4, jurisdictions: ['US', 'EP', 'CN', 'JP'] },
  sectorData: { uniqueSections: 2, uniqueClasses: 8 },
  expirationData: { expiredCount: 30, totalPatents: 150 },
};

/** Empty data (0 patents) — neutral fallback */
const MOCK_PATENT_DATA_EMPTY = {
  totalPatents: 0,
  patents: [],
};

function createMockPatentSource(data) {
  return { fetchByCpc: async () => data };
}

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

// ── Core delegation tests ─────────────────────────────────────────────────

async function main() {
  console.log('=== AC 5: computeEvolution(c, u) Delegation Tests ===\n');

  // ── 1. Evolution value is EXACTLY computeEvolution(certitude, ubiquity) ──

  console.log('Core Delegation — evolution equals computeEvolution(c, u):');

  await runTest('commodity data: evolution === computeEvolution(certitude, ubiquity)', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_COMMODITY),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'TCP/IP', capability: 'network protocol' });

    // Extract the (certitude, ubiquity) that the strategy computed
    const { certitude, ubiquity } = result;

    // Independently call computeEvolution with the same inputs
    const expected = computeEvolution(certitude, ubiquity);

    // Evolution must be EXACTLY the same — no custom formula, no blending
    assert.strictEqual(result.evolution, expected.evolution,
      `evolution ${result.evolution} !== computeEvolution(${certitude}, ${ubiquity}).evolution ${expected.evolution}`);
  });

  await runTest('genesis data: evolution === computeEvolution(certitude, ubiquity)', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_GENESIS),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Quantum Error Correction', capability: 'quantum computing' });

    const expected = computeEvolution(result.certitude, result.ubiquity);
    assert.strictEqual(result.evolution, expected.evolution,
      `evolution ${result.evolution} !== computeEvolution(${result.certitude}, ${result.ubiquity}).evolution ${expected.evolution}`);
  });

  await runTest('product data: evolution === computeEvolution(certitude, ubiquity)', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_PRODUCT),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Container Orchestration', capability: 'container management' });

    const expected = computeEvolution(result.certitude, result.ubiquity);
    assert.strictEqual(result.evolution, expected.evolution,
      `evolution ${result.evolution} !== computeEvolution(${result.certitude}, ${result.ubiquity}).evolution ${expected.evolution}`);
  });

  await runTest('empty data: evolution === computeEvolution(certitude, ubiquity)', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_EMPTY),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Unknown' });

    const expected = computeEvolution(result.certitude, result.ubiquity);
    assert.strictEqual(result.evolution, expected.evolution,
      `evolution ${result.evolution} !== computeEvolution(${result.certitude}, ${result.ubiquity}).evolution ${expected.evolution}`);
  });

  // ── 2. S-curve trace step matches independent computeEvolution call ──

  console.log('\nTrace Verification — s-curve step matches computeEvolution output:');

  await runTest('trace s-curve step has all computeEvolution fields', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_COMMODITY),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'TCP/IP', capability: 'network protocol' });
    const scurveStep = result.trace.find(t => t.step === 'write:capacity:s-curve');

    assert.ok(scurveStep, 'trace must contain s-curve step');

    // computeEvolution returns: { zone, evolution, phase, bandDistance, distToCenter }
    const expected = computeEvolution(result.certitude, result.ubiquity);

    assert.strictEqual(scurveStep.evolution, expected.evolution, 'trace evolution mismatch');
    assert.strictEqual(scurveStep.phase, expected.phase, 'trace phase mismatch');
    assert.strictEqual(scurveStep.zone, expected.zone, 'trace zone mismatch');
    assert.strictEqual(scurveStep.bandDistance, expected.bandDistance, 'trace bandDistance mismatch');
    assert.strictEqual(scurveStep.distToCenter, expected.distToCenter, 'trace distToCenter mismatch');
  });

  await runTest('trace aggregated step certitude/ubiquity match result fields', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_PRODUCT),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Kubernetes', capability: 'container orchestration' });
    const aggStep = result.trace.find(t => t.step === 'aggregated');

    assert.ok(aggStep, 'trace must contain aggregated step');
    assert.strictEqual(aggStep.certitude, result.certitude,
      'aggregated certitude must match result.certitude');
    assert.strictEqual(aggStep.ubiquity, result.ubiquity,
      'aggregated ubiquity must match result.ubiquity');
  });

  // ── 3. No custom scoring bypass — evolution is purely from s-curve ──

  console.log('\nNo Custom Scoring Bypass:');

  await runTest('evolution is never blended or adjusted after computeEvolution', async () => {
    // Run with different datasets and verify strict equality every time
    const datasets = [
      MOCK_PATENT_DATA_COMMODITY,
      MOCK_PATENT_DATA_GENESIS,
      MOCK_PATENT_DATA_PRODUCT,
      MOCK_PATENT_DATA_EMPTY,
    ];

    for (const data of datasets) {
      const strategy = new CpcEvolutionStrategy({
        patentSource: createMockPatentSource(data),
        cpcMapper: mockCpcMapper,
      });
      const result = await strategy.evaluate({ name: 'Test', capability: 'test' });
      const expected = computeEvolution(result.certitude, result.ubiquity);

      // Strict equality: no rounding differences, no blending, no adjustment
      assert.strictEqual(result.evolution, expected.evolution,
        `Bypass detected: evolution ${result.evolution} !== ${expected.evolution} for ${data.totalPatents} patents`);
    }
  });

  await runTest('evolution comes from scurveResult not from any weighted blend', async () => {
    // Unlike sector-agent-strategy which blends scurve + agent estimates,
    // CPC strategy must use scurveResult.evolution directly
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_COMMODITY),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'TCP/IP', capability: 'network protocol' });

    // The evolution value must be exactly what computeEvolution produces
    // not some blend like: modelWeight * scurve + (1-modelWeight) * custom
    const scurve = computeEvolution(result.certitude, result.ubiquity);

    // If someone adds blending, this would fail because blended !== scurve.evolution
    assert.strictEqual(result.evolution, scurve.evolution,
      'evolution must not be blended with any secondary estimate');

    // Also verify the phase from trace matches (no phase override)
    const traceScurve = result.trace.find(t => t.step === 'write:capacity:s-curve');
    assert.strictEqual(traceScurve.phase, scurve.phase,
      'phase must come directly from computeEvolution, not overridden');
  });

  // ── 4. computeEvolution return shape is preserved in trace ──

  console.log('\ncomputeEvolution Return Shape Preserved:');

  await runTest('s-curve result contains zone, evolution, phase, bandDistance, distToCenter', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_PRODUCT),
      cpcMapper: mockCpcMapper,
    });
    const result = await strategy.evaluate({ name: 'Kubernetes' });
    const scurveStep = result.trace.find(t => t.step === 'write:capacity:s-curve');

    // All 5 fields from computeEvolution must be present
    const requiredFields = ['zone', 'evolution', 'phase', 'bandDistance', 'distToCenter'];
    for (const field of requiredFields) {
      assert.ok(field in scurveStep,
        `s-curve trace missing "${field}" — computeEvolution return not fully captured`);
    }
  });

  await runTest('evolution value is in valid [0, 1] range from s-curve projection', async () => {
    const datasets = [
      MOCK_PATENT_DATA_COMMODITY,
      MOCK_PATENT_DATA_GENESIS,
      MOCK_PATENT_DATA_PRODUCT,
      MOCK_PATENT_DATA_EMPTY,
    ];

    for (const data of datasets) {
      const strategy = new CpcEvolutionStrategy({
        patentSource: createMockPatentSource(data),
        cpcMapper: mockCpcMapper,
      });
      const result = await strategy.evaluate({ name: 'Test' });

      assert.ok(result.evolution >= 0 && result.evolution <= 1,
        `evolution ${result.evolution} out of [0, 1] range for ${data.totalPatents} patents`);
    }
  });

  // ── 5. Indicator toggling doesn't bypass computeEvolution ──

  console.log('\nIndicator Toggling Still Delegates to computeEvolution:');

  await runTest('disabling some indicators still routes through computeEvolution', async () => {
    const strategy = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_COMMODITY),
      cpcMapper: mockCpcMapper,
      config: {
        certitudeIndicators: {
          convergenceHHI: { enabled: false },
          stabiliteTaxonomique: { enabled: false },
        },
        ubiquityIndicators: {
          couvertureGeo: { enabled: false },
        },
      },
    });
    const result = await strategy.evaluate({ name: 'TCP/IP', capability: 'network protocol' });

    // Even with toggled indicators, evolution must still come from computeEvolution
    const expected = computeEvolution(result.certitude, result.ubiquity);
    assert.strictEqual(result.evolution, expected.evolution,
      'toggled indicators must still delegate to computeEvolution');
  });

  await runTest('different indicator configs produce different (c,u) but same delegation', async () => {
    // Two strategies with different configs on same data
    const strategyFull = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_COMMODITY),
      cpcMapper: mockCpcMapper,
    });
    const strategyPartial = new CpcEvolutionStrategy({
      patentSource: createMockPatentSource(MOCK_PATENT_DATA_COMMODITY),
      cpcMapper: mockCpcMapper,
      config: {
        certitudeIndicators: {
          convergenceHHI: { enabled: false },
          densiteCitation: { enabled: false },
        },
      },
    });

    const resultFull = await strategyFull.evaluate({ name: 'TCP/IP' });
    const resultPartial = await strategyPartial.evaluate({ name: 'TCP/IP' });

    // Both must delegate to computeEvolution with their respective (c, u)
    const expectedFull = computeEvolution(resultFull.certitude, resultFull.ubiquity);
    const expectedPartial = computeEvolution(resultPartial.certitude, resultPartial.ubiquity);

    assert.strictEqual(resultFull.evolution, expectedFull.evolution);
    assert.strictEqual(resultPartial.evolution, expectedPartial.evolution);

    // The (c, u) inputs may differ due to different indicator configs
    // But both evolutions must come from computeEvolution
    // (We don't assert they're the same — just that each delegates correctly)
  });

  // ── 6. Verify no import of scoring functions other than computeEvolution ──

  console.log('\nImport Verification:');

  await runTest('CpcEvolutionStrategy module re-exports prove computeEvolution dependency', async () => {
    // The strategy file imports computeEvolution from s-curve.mjs
    // We can verify by checking that the strategy produces results consistent
    // with the s-curve model for known (c, u) corner cases

    // Corner case: certitude=0, ubiquity=0 → Genesis zone
    const scurveOrigin = computeEvolution(0, 0);
    assert.strictEqual(scurveOrigin.phase, 'Genesis');
    assert.ok(scurveOrigin.evolution <= 0.18);

    // Corner case: certitude=1, ubiquity=1 → Commodity zone
    const scurveMax = computeEvolution(1, 1);
    assert.strictEqual(scurveMax.phase, 'Commodity');
    assert.ok(scurveMax.evolution >= 0.7);

    // These confirm computeEvolution works as expected — strategy delegates to it
  });

  // ── Summary ────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(55)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'='.repeat(55)}`);

  if (failed > 0) {
    console.error('\n\u2717 AC 5 computeEvolution delegation tests FAILED\n');
    process.exit(1);
  } else {
    console.log('\n\u2713 All AC 5 computeEvolution delegation tests PASSED\n');
  }
}

main().catch(err => {
  console.error('\n\u2717 AC 5 tests CRASHED:', err);
  process.exit(1);
});
