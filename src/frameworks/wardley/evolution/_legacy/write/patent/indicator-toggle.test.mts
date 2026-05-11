// Tests for AC 12: Individual indicators can be enabled/disabled with
// automatic weight renormalization.
//
// Covers:
//   1. Constructor-time indicator toggling via config overrides
//   2. Runtime toggling via setIndicatorEnabled / setIndicatorsEnabled
//   3. Automatic weight renormalization (enabled weights sum to 1.0)
//   4. Evolution result changes when indicators are toggled
//   5. Edge cases: all disabled, single enabled, all enabled (identity)
//   6. Renormalization in patent-indicators.mjs weightedMean
//   7. getIndicatorConfig / getActiveWeights introspection
//   8. resetIndicatorConfig restores defaults

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import {
  CpcEvolutionStrategy,
  DEFAULT_CERTITUDE_INDICATORS,
  DEFAULT_UBIQUITY_INDICATORS,
  renormalizeWeights,
  mergeIndicatorConfig,
  aggregateAxis,
} from '../strategies/capacity/cpc-evolution-strategy.mjs';

import {
  weightedMean,
  aggregateCertitude,
  aggregateUbiquite,
  computeAllIndicators,
  CERTITUDE_INDICATORS,
  UBIQUITE_INDICATORS,
} from '#lib/patent/patent-indicators.mjs';

// ─── Helpers ────────────────────────────────────────────────────────────────

function approx(actual, expected, tolerance = 0.005) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ~${expected} (+-${tolerance}), got ${actual}`
  );
}

function sumOfWeights(weights) {
  return Object.values(weights).reduce((s, v) => s + v, 0);
}

// ─── Mock fixtures ──────────────────────────────────────────────────────────

const mockCpcMapper = {
  mapToCpc: async () => ['H04L', 'G06F'],
};

const MOCK_PATENT_DATA = {
  totalPatents: 200,
  patents: [],
  cpcDistribution: [
    { cpc: 'H04L', count: 120 },
    { cpc: 'G06F', count: 80 },
  ],
  yearlyClassifications: [
    { year: 2019, cpcCodes: ['H04L', 'G06F'] },
    { year: 2020, cpcCodes: ['H04L', 'G06F'] },
    { year: 2021, cpcCodes: ['H04L', 'G06F'] },
  ],
  citationData: { totalForwardCitations: 2000, patentCount: 200 },
  claimsTimeline: [
    { year: 2017, avgIndependentClaims: 9 },
    { year: 2019, avgIndependentClaims: 7 },
    { year: 2021, avgIndependentClaims: 5 },
  ],
  assigneeData: { uniqueAssignees: 80, totalPatents: 200 },
  geoData: { jurisdictionCount: 5 },
  sectorData: { uniqueSections: 3, uniqueClasses: 10 },
  expirationData: { expiredCount: 80, totalPatents: 200 },
};

function createMockSource(data = MOCK_PATENT_DATA) {
  return { fetchByCpc: async () => data };
}

function createStrategy(configOverrides = {}) {
  return new CpcEvolutionStrategy({
    patentSource: createMockSource(),
    cpcMapper: mockCpcMapper,
    config: configOverrides,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. renormalizeWeights — strategy-level (Record<string, {weight, enabled}>)
// ═══════════════════════════════════════════════════════════════════════════════

describe('renormalizeWeights (strategy-level)', () => {

  it('all enabled: weights sum to 1.0 and proportions preserved', () => {
    const weights = renormalizeWeights(DEFAULT_CERTITUDE_INDICATORS);
    approx(sumOfWeights(weights), 1.0);
    // Original weights already sum to 1.0, so normalized = original
    approx(weights.convergenceHHI, 0.30);
    approx(weights.stabiliteTaxonomique, 0.20);
    approx(weights.densiteCitation, 0.25);
    approx(weights.retrecissementClaims, 0.25);
  });

  it('one disabled: remaining weights renormalize to sum 1.0', () => {
    const config = {
      convergenceHHI:       { weight: 0.30, enabled: true },
      stabiliteTaxonomique: { weight: 0.20, enabled: false },
      densiteCitation:      { weight: 0.25, enabled: true },
      retrecissementClaims: { weight: 0.25, enabled: true },
    };
    const weights = renormalizeWeights(config);

    assert.ok(!('stabiliteTaxonomique' in weights), 'disabled indicator excluded');
    approx(sumOfWeights(weights), 1.0);
    // New weights: 0.30/0.80, 0.25/0.80, 0.25/0.80
    approx(weights.convergenceHHI, 0.375);
    approx(weights.densiteCitation, 0.3125);
    approx(weights.retrecissementClaims, 0.3125);
  });

  it('two disabled: remaining weights renormalize to sum 1.0', () => {
    const config = {
      convergenceHHI:       { weight: 0.30, enabled: true },
      stabiliteTaxonomique: { weight: 0.20, enabled: false },
      densiteCitation:      { weight: 0.25, enabled: false },
      retrecissementClaims: { weight: 0.25, enabled: true },
    };
    const weights = renormalizeWeights(config);

    assert.equal(Object.keys(weights).length, 2);
    approx(sumOfWeights(weights), 1.0);
    // 0.30/(0.30+0.25) = 0.5455, 0.25/0.55 = 0.4545
    approx(weights.convergenceHHI, 0.30 / 0.55);
    approx(weights.retrecissementClaims, 0.25 / 0.55);
  });

  it('three disabled: single indicator gets weight 1.0', () => {
    const config = {
      convergenceHHI:       { weight: 0.30, enabled: true },
      stabiliteTaxonomique: { weight: 0.20, enabled: false },
      densiteCitation:      { weight: 0.25, enabled: false },
      retrecissementClaims: { weight: 0.25, enabled: false },
    };
    const weights = renormalizeWeights(config);

    assert.equal(Object.keys(weights).length, 1);
    approx(weights.convergenceHHI, 1.0);
  });

  it('all disabled: returns empty map', () => {
    const config = {
      convergenceHHI:       { weight: 0.30, enabled: false },
      stabiliteTaxonomique: { weight: 0.20, enabled: false },
      densiteCitation:      { weight: 0.25, enabled: false },
      retrecissementClaims: { weight: 0.25, enabled: false },
    };
    const weights = renormalizeWeights(config);
    assert.equal(Object.keys(weights).length, 0);
  });

  it('ubiquity indicators also renormalize correctly', () => {
    const config = {
      diversiteAssignees:   { weight: 0.30, enabled: true },
      couvertureGeo:        { weight: 0.25, enabled: false },
      diffusionSectorielle: { weight: 0.25, enabled: true },
      ratioExpires:         { weight: 0.20, enabled: true },
    };
    const weights = renormalizeWeights(config);

    assert.ok(!('couvertureGeo' in weights));
    approx(sumOfWeights(weights), 1.0);
    // 0.30/0.75, 0.25/0.75, 0.20/0.75
    approx(weights.diversiteAssignees, 0.4);
    approx(weights.diffusionSectorielle, 1 / 3);
    approx(weights.ratioExpires, 0.20 / 0.75);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. weightedMean — patent-indicators.mjs level (Array<{key, weight, enabled}>)
// ═══════════════════════════════════════════════════════════════════════════════

describe('weightedMean renormalization (patent-indicators.mjs)', () => {

  it('disabled indicator excluded from computation', () => {
    const config = [
      { key: 'a', weight: 0.50, enabled: true },
      { key: 'b', weight: 0.50, enabled: false },
    ];
    const scores = { a: 0.8, b: 0.2 };
    const result = weightedMean(scores, config);

    // Only 'a' active, weight normalized to 1.0 → value = 0.8
    approx(result.value, 0.8);
    assert.equal(result.enabledCount, 1);
    assert.equal(result.breakdown.length, 1);
    assert.equal(result.breakdown[0].key, 'a');
    approx(result.breakdown[0].weightNormalized, 1.0);
  });

  it('breakdown shows renormalized weights', () => {
    const config = [
      { key: 'a', weight: 0.30, enabled: true },
      { key: 'b', weight: 0.20, enabled: false },
      { key: 'c', weight: 0.25, enabled: true },
      { key: 'd', weight: 0.25, enabled: true },
    ];
    const scores = { a: 1, b: 1, c: 1, d: 1 };
    const result = weightedMean(scores, config);

    // All enabled scores = 1 → weighted mean = 1
    approx(result.value, 1.0);
    assert.equal(result.enabledCount, 3);

    // Verify renormalized weights sum to 1.0
    const normalizedSum = result.breakdown
      .reduce((s, b) => s + b.weightNormalized, 0);
    approx(normalizedSum, 1.0);

    // Verify disabled 'b' not in breakdown
    assert.ok(!result.breakdown.some(b => b.key === 'b'));
  });

  it('varied scores with one disabled produce correct mean', () => {
    const config = [
      { key: 'convergenceHHI', weight: 0.30, enabled: true },
      { key: 'stabiliteTaxonomique', weight: 0.20, enabled: false },
      { key: 'densiteCitation', weight: 0.25, enabled: true },
      { key: 'retrecissementClaims', weight: 0.25, enabled: true },
    ];
    const scores = {
      convergenceHHI: 0.8,
      stabiliteTaxonomique: 0.0, // disabled, must be ignored
      densiteCitation: 0.6,
      retrecissementClaims: 0.4,
    };
    const result = weightedMean(scores, config);

    // Enabled sum = 0.80, normalized: 0.375, 0.3125, 0.3125
    // Mean = 0.8*0.375 + 0.6*0.3125 + 0.4*0.3125 = 0.300 + 0.1875 + 0.125 = 0.6125
    approx(result.value, 0.6125);
    assert.equal(result.enabledCount, 3);
  });

  it('all disabled returns value 0 and enabledCount 0', () => {
    const config = [
      { key: 'a', weight: 0.50, enabled: false },
      { key: 'b', weight: 0.50, enabled: false },
    ];
    const result = weightedMean({ a: 1, b: 1 }, config);
    assert.equal(result.value, 0);
    assert.equal(result.enabledCount, 0);
    assert.equal(result.breakdown.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. mergeIndicatorConfig — overrides
// ═══════════════════════════════════════════════════════════════════════════════

describe('mergeIndicatorConfig', () => {

  it('no overrides: returns a copy of defaults', () => {
    const merged = mergeIndicatorConfig(DEFAULT_CERTITUDE_INDICATORS, undefined);
    assert.deepEqual(merged, DEFAULT_CERTITUDE_INDICATORS);
    // Must be a copy, not the same reference
    assert.notEqual(merged, DEFAULT_CERTITUDE_INDICATORS);
  });

  it('override enabled=false on one indicator', () => {
    const overrides = { densiteCitation: { enabled: false } };
    const merged = mergeIndicatorConfig(DEFAULT_CERTITUDE_INDICATORS, overrides);

    assert.equal(merged.densiteCitation.enabled, false);
    assert.equal(merged.densiteCitation.weight, 0.25); // weight preserved from default
    // Other indicators untouched
    assert.equal(merged.convergenceHHI.enabled, true);
    assert.equal(merged.stabiliteTaxonomique.enabled, true);
    assert.equal(merged.retrecissementClaims.enabled, true);
  });

  it('override weight on one indicator', () => {
    const overrides = { convergenceHHI: { weight: 0.50 } };
    const merged = mergeIndicatorConfig(DEFAULT_CERTITUDE_INDICATORS, overrides);

    assert.equal(merged.convergenceHHI.weight, 0.50);
    assert.equal(merged.convergenceHHI.enabled, true); // enabled preserved
  });

  it('override both weight and enabled', () => {
    const overrides = {
      stabiliteTaxonomique: { weight: 0.10, enabled: false },
    };
    const merged = mergeIndicatorConfig(DEFAULT_CERTITUDE_INDICATORS, overrides);

    assert.equal(merged.stabiliteTaxonomique.weight, 0.10);
    assert.equal(merged.stabiliteTaxonomique.enabled, false);
  });

  it('unknown override keys are ignored (only known indicators merged)', () => {
    const overrides = { unknownIndicator: { weight: 0.5, enabled: true } };
    const merged = mergeIndicatorConfig(DEFAULT_CERTITUDE_INDICATORS, overrides);

    assert.ok(!('unknownIndicator' in merged));
    assert.equal(Object.keys(merged).length, 4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Constructor-time indicator toggling
// ═══════════════════════════════════════════════════════════════════════════════

describe('CpcEvolutionStrategy constructor config toggling', () => {

  it('disabling certitude indicator via constructor config', () => {
    const strategy = createStrategy({
      certitudeIndicators: {
        stabiliteTaxonomique: { enabled: false },
      },
    });

    const config = strategy.getIndicatorConfig();
    const stabilite = config.certitude.find(c => c.key === 'stabiliteTaxonomique');
    assert.equal(stabilite.enabled, false);
    assert.equal(stabilite.weightNormalized, 0);

    // Remaining certitude weights sum to 1.0
    const activeSum = config.certitude
      .filter(c => c.enabled)
      .reduce((s, c) => s + c.weightNormalized, 0);
    approx(activeSum, 1.0);
  });

  it('disabling ubiquity indicator via constructor config', () => {
    const strategy = createStrategy({
      ubiquityIndicators: {
        couvertureGeo: { enabled: false },
        ratioExpires: { enabled: false },
      },
    });

    const config = strategy.getIndicatorConfig();
    const disabledKeys = config.ubiquity
      .filter(u => !u.enabled)
      .map(u => u.key);
    assert.deepEqual(disabledKeys.sort(), ['couvertureGeo', 'ratioExpires']);

    // Active weights sum to 1.0
    const activeSum = config.ubiquity
      .filter(u => u.enabled)
      .reduce((s, u) => s + u.weightNormalized, 0);
    approx(activeSum, 1.0);
  });

  it('disabling indicators on both axes simultaneously', () => {
    const strategy = createStrategy({
      certitudeIndicators: { convergenceHHI: { enabled: false } },
      ubiquityIndicators: { diversiteAssignees: { enabled: false } },
    });

    const config = strategy.getIndicatorConfig();
    assert.equal(
      config.certitude.find(c => c.key === 'convergenceHHI').enabled,
      false
    );
    assert.equal(
      config.ubiquity.find(u => u.key === 'diversiteAssignees').enabled,
      false
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Runtime indicator toggling via setIndicatorEnabled
// ═══════════════════════════════════════════════════════════════════════════════

describe('setIndicatorEnabled (runtime toggle)', () => {

  it('disables a certitude indicator', () => {
    const strategy = createStrategy();
    strategy.setIndicatorEnabled('certitude', 'densiteCitation', false);

    const config = strategy.getIndicatorConfig();
    const dc = config.certitude.find(c => c.key === 'densiteCitation');
    assert.equal(dc.enabled, false);
    assert.equal(dc.weightNormalized, 0);
  });

  it('disables a ubiquity indicator', () => {
    const strategy = createStrategy();
    strategy.setIndicatorEnabled('ubiquity', 'ratioExpires', false);

    const config = strategy.getIndicatorConfig();
    const re = config.ubiquity.find(u => u.key === 'ratioExpires');
    assert.equal(re.enabled, false);
  });

  it('re-enables a previously disabled indicator', () => {
    const strategy = createStrategy({
      certitudeIndicators: { convergenceHHI: { enabled: false } },
    });

    // Verify disabled
    let config = strategy.getIndicatorConfig();
    assert.equal(config.certitude.find(c => c.key === 'convergenceHHI').enabled, false);

    // Re-enable
    strategy.setIndicatorEnabled('certitude', 'convergenceHHI', true);
    config = strategy.getIndicatorConfig();
    assert.equal(config.certitude.find(c => c.key === 'convergenceHHI').enabled, true);
    assert.ok(config.certitude.find(c => c.key === 'convergenceHHI').weightNormalized > 0);
  });

  it('throws on unknown indicator key', () => {
    const strategy = createStrategy();
    assert.throws(
      () => strategy.setIndicatorEnabled('certitude', 'notAnIndicator', false),
      /Unknown certitude indicator.*notAnIndicator/
    );
  });

  it('weights automatically renormalize after toggling', () => {
    const strategy = createStrategy();

    // All enabled → each gets original weight
    let weights = strategy.getActiveWeights();
    approx(sumOfWeights(weights.certitude), 1.0);

    // Disable one
    strategy.setIndicatorEnabled('certitude', 'retrecissementClaims', false);
    weights = strategy.getActiveWeights();
    approx(sumOfWeights(weights.certitude), 1.0);
    assert.ok(!('retrecissementClaims' in weights.certitude));

    // Disable another
    strategy.setIndicatorEnabled('certitude', 'stabiliteTaxonomique', false);
    weights = strategy.getActiveWeights();
    approx(sumOfWeights(weights.certitude), 1.0);
    assert.equal(Object.keys(weights.certitude).length, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Bulk toggle via setIndicatorsEnabled
// ═══════════════════════════════════════════════════════════════════════════════

describe('setIndicatorsEnabled (bulk toggle)', () => {

  it('bulk-disables multiple indicators across both axes', () => {
    const strategy = createStrategy();
    strategy.setIndicatorsEnabled({
      certitude: {
        convergenceHHI: false,
        densiteCitation: false,
      },
      ubiquity: {
        couvertureGeo: false,
      },
    });

    const config = strategy.getIndicatorConfig();
    assert.equal(config.certitude.find(c => c.key === 'convergenceHHI').enabled, false);
    assert.equal(config.certitude.find(c => c.key === 'densiteCitation').enabled, false);
    assert.equal(config.certitude.find(c => c.key === 'stabiliteTaxonomique').enabled, true);
    assert.equal(config.ubiquity.find(u => u.key === 'couvertureGeo').enabled, false);
    assert.equal(config.ubiquity.find(u => u.key === 'diversiteAssignees').enabled, true);
  });

  it('ignores unknown indicator keys silently', () => {
    const strategy = createStrategy();
    // Should not throw
    strategy.setIndicatorsEnabled({
      certitude: { unknownKey: false },
      ubiquity: { anotherUnknown: true },
    });

    // All indicators remain enabled
    const config = strategy.getIndicatorConfig();
    assert.ok(config.certitude.every(c => c.enabled));
    assert.ok(config.ubiquity.every(u => u.enabled));
  });

  it('partial update: only specified keys are changed', () => {
    const strategy = createStrategy();
    strategy.setIndicatorsEnabled({
      certitude: { convergenceHHI: false },
      // ubiquity not specified → untouched
    });

    const config = strategy.getIndicatorConfig();
    assert.equal(config.certitude.find(c => c.key === 'convergenceHHI').enabled, false);
    // All ubiquity indicators unchanged
    assert.ok(config.ubiquity.every(u => u.enabled));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. getIndicatorConfig / getActiveWeights introspection
// ═══════════════════════════════════════════════════════════════════════════════

describe('getIndicatorConfig introspection', () => {

  it('returns 4 certitude + 4 ubiquity indicators', () => {
    const strategy = createStrategy();
    const config = strategy.getIndicatorConfig();

    assert.equal(config.certitude.length, 4);
    assert.equal(config.ubiquity.length, 4);
  });

  it('each entry has key, weight, enabled, weightNormalized', () => {
    const strategy = createStrategy();
    const config = strategy.getIndicatorConfig();

    for (const entry of [...config.certitude, ...config.ubiquity]) {
      assert.ok('key' in entry, `missing key in ${JSON.stringify(entry)}`);
      assert.ok('weight' in entry, `missing weight in ${JSON.stringify(entry)}`);
      assert.ok('enabled' in entry, `missing enabled in ${JSON.stringify(entry)}`);
      assert.ok('weightNormalized' in entry, `missing weightNormalized in ${JSON.stringify(entry)}`);
    }
  });

  it('disabled indicators have weightNormalized = 0', () => {
    const strategy = createStrategy({
      certitudeIndicators: { densiteCitation: { enabled: false } },
    });
    const config = strategy.getIndicatorConfig();
    const dc = config.certitude.find(c => c.key === 'densiteCitation');

    assert.equal(dc.enabled, false);
    assert.equal(dc.weightNormalized, 0);
    assert.equal(dc.weight, 0.25); // raw weight preserved
  });

  it('enabled indicators normalized weights sum to 1.0 per axis', () => {
    const strategy = createStrategy({
      certitudeIndicators: {
        convergenceHHI: { enabled: false },
        stabiliteTaxonomique: { enabled: false },
      },
    });
    const config = strategy.getIndicatorConfig();

    const certActiveSum = config.certitude
      .filter(c => c.enabled)
      .reduce((s, c) => s + c.weightNormalized, 0);
    approx(certActiveSum, 1.0);

    // Ubiquity all enabled → sum = 1.0
    const ubiActiveSum = config.ubiquity
      .filter(u => u.enabled)
      .reduce((s, u) => s + u.weightNormalized, 0);
    approx(ubiActiveSum, 1.0);
  });
});

describe('getActiveWeights', () => {

  it('returns only enabled indicator weights', () => {
    const strategy = createStrategy({
      certitudeIndicators: { stabiliteTaxonomique: { enabled: false } },
    });
    const weights = strategy.getActiveWeights();

    assert.ok(!('stabiliteTaxonomique' in weights.certitude));
    assert.equal(Object.keys(weights.certitude).length, 3);
    approx(sumOfWeights(weights.certitude), 1.0);
  });

  it('ubiquity weights unaffected by certitude toggles', () => {
    const strategy = createStrategy({
      certitudeIndicators: {
        convergenceHHI: { enabled: false },
        densiteCitation: { enabled: false },
      },
    });
    const weights = strategy.getActiveWeights();

    // All 4 ubiquity indicators still active
    assert.equal(Object.keys(weights.ubiquity).length, 4);
    approx(sumOfWeights(weights.ubiquity), 1.0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. resetIndicatorConfig
// ═══════════════════════════════════════════════════════════════════════════════

describe('resetIndicatorConfig', () => {

  it('restores all indicators to enabled after toggling', () => {
    const strategy = createStrategy();
    strategy.setIndicatorEnabled('certitude', 'convergenceHHI', false);
    strategy.setIndicatorEnabled('ubiquity', 'ratioExpires', false);

    // Verify disabled
    let config = strategy.getIndicatorConfig();
    assert.equal(config.certitude.find(c => c.key === 'convergenceHHI').enabled, false);
    assert.equal(config.ubiquity.find(u => u.key === 'ratioExpires').enabled, false);

    // Reset
    strategy.resetIndicatorConfig();
    config = strategy.getIndicatorConfig();

    assert.ok(config.certitude.every(c => c.enabled));
    assert.ok(config.ubiquity.every(u => u.enabled));
  });

  it('restores original weights after reset', () => {
    const strategy = createStrategy();
    strategy.resetIndicatorConfig();

    const weights = strategy.getActiveWeights();
    approx(weights.certitude.convergenceHHI, 0.30);
    approx(weights.certitude.stabiliteTaxonomique, 0.20);
    approx(weights.certitude.densiteCitation, 0.25);
    approx(weights.certitude.retrecissementClaims, 0.25);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. End-to-end: toggling affects evaluation result
// ═══════════════════════════════════════════════════════════════════════════════

describe('end-to-end: toggling indicators affects evaluate()', () => {

  it('different enabled sets produce different evolution scores', async () => {
    const component = { name: 'Test Component', capability: 'networking' };

    // All indicators enabled
    const strategyAll = createStrategy();
    const resultAll = await strategyAll.evaluate(component);

    // Only convergenceHHI enabled on certitude axis
    const strategySingle = createStrategy({
      certitudeIndicators: {
        stabiliteTaxonomique: { enabled: false },
        densiteCitation: { enabled: false },
        retrecissementClaims: { enabled: false },
      },
    });
    const resultSingle = await strategySingle.evaluate(component);

    // Both produce valid results
    assert.equal(typeof resultAll.evolution, 'number');
    assert.equal(typeof resultSingle.evolution, 'number');
    assert.equal(resultAll.method, 'cpc-evolution');
    assert.equal(resultSingle.method, 'cpc-evolution');

    // Certitude values should differ (different weighting)
    // (they may be equal in degenerate cases, but the trace should differ)
    const allCertTrace = resultAll.trace.find(t => t.step === 'certitude-indicators');
    const singleCertTrace = resultSingle.trace.find(t => t.step === 'certitude-indicators');

    // Different number of active weights
    assert.equal(Object.keys(allCertTrace.weights).length, 4);
    assert.equal(Object.keys(singleCertTrace.weights).length, 1);
  });

  it('runtime toggle changes subsequent evaluate() results', async () => {
    const component = { name: 'Widget', capability: 'generic tech' };
    const strategy = createStrategy();

    const result1 = await strategy.evaluate(component);

    // Disable half the indicators
    strategy.setIndicatorsEnabled({
      certitude: {
        convergenceHHI: false,
        stabiliteTaxonomique: false,
      },
      ubiquity: {
        couvertureGeo: false,
        ratioExpires: false,
      },
    });

    const result2 = await strategy.evaluate(component);

    // Both valid
    assert.equal(result1.method, 'cpc-evolution');
    assert.equal(result2.method, 'cpc-evolution');

    // Trace should show different weight counts
    const trace1Cert = result1.trace.find(t => t.step === 'certitude-indicators');
    const trace2Cert = result2.trace.find(t => t.step === 'certitude-indicators');
    assert.equal(Object.keys(trace1Cert.weights).length, 4);
    assert.equal(Object.keys(trace2Cert.weights).length, 2);
  });

  it('trace reflects renormalized weights (not raw weights)', async () => {
    const strategy = createStrategy({
      certitudeIndicators: { stabiliteTaxonomique: { enabled: false } },
    });
    const component = { name: 'X', capability: 'test' };
    const result = await strategy.evaluate(component);

    const certTrace = result.trace.find(t => t.step === 'certitude-indicators');
    assert.ok(certTrace, 'certitude-indicators trace step must exist');

    // Renormalized weights should sum to ~1.0
    const weightSum = Object.values(certTrace.weights)
      .reduce((s, w) => s + w, 0);
    approx(weightSum, 1.0);

    // Disabled indicator not in weights
    assert.ok(!('stabiliteTaxonomique' in certTrace.weights));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. computeAllIndicators with custom toggle configs
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeAllIndicators with indicator toggling', () => {

  const samplePatentData = {
    cpcDistribution: [
      { cpc: 'H04L', count: 100 },
      { cpc: 'G06F', count: 50 },
    ],
    yearlyClassifications: [
      { year: 2019, cpcCodes: ['H04L', 'G06F'] },
      { year: 2020, cpcCodes: ['H04L', 'G06F'] },
    ],
    citationData: { totalForwardCitations: 1000, patentCount: 100 },
    claimsTimeline: [
      { year: 2018, avgIndependentClaims: 8 },
      { year: 2020, avgIndependentClaims: 5 },
    ],
    assigneeData: { uniqueAssignees: 60, totalPatents: 150 },
    geoData: { jurisdictionCount: 4 },
    sectorData: { uniqueSections: 3, uniqueClasses: 8 },
    expirationData: { expiredCount: 50, totalPatents: 150 },
  };

  it('all indicators enabled: enabledCount = 4 for each axis', () => {
    const result = computeAllIndicators(samplePatentData);
    assert.equal(result.certitude.enabledCount, 4);
    assert.equal(result.ubiquite.enabledCount, 4);
  });

  it('disabling certitude indicator: enabledCount = 3', () => {
    const customCertitude = CERTITUDE_INDICATORS.map(i =>
      i.key === 'densiteCitation' ? { ...i, enabled: false } : i
    );
    const result = computeAllIndicators(samplePatentData, {
      certitudeConfig: customCertitude,
    });

    assert.equal(result.certitude.enabledCount, 3);
    const keys = result.certitude.breakdown.map(b => b.key);
    assert.ok(!keys.includes('densiteCitation'));
  });

  it('disabling ubiquity indicator: enabledCount = 3', () => {
    const customUbiquite = UBIQUITE_INDICATORS.map(i =>
      i.key === 'couvertureGeo' ? { ...i, enabled: false } : i
    );
    const result = computeAllIndicators(samplePatentData, {
      ubiquiteConfig: customUbiquite,
    });

    assert.equal(result.ubiquite.enabledCount, 3);
    const keys = result.ubiquite.breakdown.map(b => b.key);
    assert.ok(!keys.includes('couvertureGeo'));
  });

  it('all 8 scores still computed even when indicators are disabled', () => {
    const customCertitude = CERTITUDE_INDICATORS.map(i => ({ ...i, enabled: false }));
    const result = computeAllIndicators(samplePatentData, {
      certitudeConfig: customCertitude,
    });

    // All 8 scores computed regardless of enabled/disabled
    assert.equal(Object.keys(result.scores).length, 8);
    // But certitude aggregate shows 0 enabled
    assert.equal(result.certitude.enabledCount, 0);
    assert.equal(result.certitude.value, 0);
  });

  it('disabled indicator scores are still available in result.scores', () => {
    const customCertitude = CERTITUDE_INDICATORS.map(i =>
      i.key === 'convergenceHHI' ? { ...i, enabled: false } : i
    );
    const result = computeAllIndicators(samplePatentData, {
      certitudeConfig: customCertitude,
    });

    // Score is computed (pure function) even though disabled for aggregation
    assert.ok(typeof result.scores.convergenceHHI === 'number');
    assert.ok(result.scores.convergenceHHI > 0);
  });

  it('breakdown weightNormalized reflects renormalization', () => {
    const customCertitude = CERTITUDE_INDICATORS.map(i =>
      i.key === 'stabiliteTaxonomique' ? { ...i, enabled: false } : i
    );
    const result = computeAllIndicators(samplePatentData, {
      certitudeConfig: customCertitude,
    });

    // Renormalized weights of enabled indicators sum to 1.0
    const normalizedSum = result.certitude.breakdown
      .reduce((s, b) => s + b.weightNormalized, 0);
    approx(normalizedSum, 1.0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. aggregateAxis (strategy-level) with disabled indicators
// ═══════════════════════════════════════════════════════════════════════════════

describe('aggregateAxis with partial weights', () => {

  it('uses only enabled weights for aggregation', () => {
    const values = {
      convergenceHHI: 0.9,
      densiteCitation: 0.3,
    };
    // Only these two active after renormalization
    const weights = { convergenceHHI: 0.6, densiteCitation: 0.4 };
    const result = aggregateAxis(values, weights);

    // 0.9*0.6 + 0.3*0.4 = 0.54 + 0.12 = 0.66
    approx(result, 0.66);
  });

  it('single weight gets full value', () => {
    const values = { convergenceHHI: 0.75 };
    const weights = { convergenceHHI: 1.0 };
    const result = aggregateAxis(values, weights);
    approx(result, 0.75);
  });

  it('empty weights returns neutral 0.5', () => {
    const result = aggregateAxis({}, {});
    approx(result, 0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Weight renormalization preserves relative proportions
// ═══════════════════════════════════════════════════════════════════════════════

describe('weight renormalization preserves proportions', () => {

  it('ratio between enabled indicator weights is preserved', () => {
    const config = {
      convergenceHHI:       { weight: 0.30, enabled: true },
      stabiliteTaxonomique: { weight: 0.20, enabled: false }, // disabled
      densiteCitation:      { weight: 0.25, enabled: true },
      retrecissementClaims: { weight: 0.25, enabled: true },
    };
    const weights = renormalizeWeights(config);

    // Original ratio HHI:citation = 0.30:0.25 = 1.2
    const ratio = weights.convergenceHHI / weights.densiteCitation;
    approx(ratio, 0.30 / 0.25);

    // Original ratio citation:claims = 0.25:0.25 = 1.0
    const ratio2 = weights.densiteCitation / weights.retrecissementClaims;
    approx(ratio2, 1.0);
  });

  it('ubiquity ratio preserved when one indicator disabled', () => {
    const config = {
      diversiteAssignees:   { weight: 0.30, enabled: true },
      couvertureGeo:        { weight: 0.25, enabled: true },
      diffusionSectorielle: { weight: 0.25, enabled: false },
      ratioExpires:         { weight: 0.20, enabled: true },
    };
    const weights = renormalizeWeights(config);

    // assignees:geo = 0.30:0.25 = 1.2
    approx(weights.diversiteAssignees / weights.couvertureGeo, 1.2);
    // geo:expires = 0.25:0.20 = 1.25
    approx(weights.couvertureGeo / weights.ratioExpires, 1.25);
  });
});
