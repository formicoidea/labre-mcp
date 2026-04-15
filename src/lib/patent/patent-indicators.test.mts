// Tests for patent-indicators.mjs — pure functions, no I/O mocks needed.
// Focuses on certitude indicators (AC 3) and aggregation with weight renormalization.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  convergenceHHI,
  stabiliteTaxonomique,
  densiteCitation,
  retrecissementClaims,
  diversiteAssignees,
  couvertureGeo,
  diffusionSectorielle,
  ratioExpires,
  aggregateCertitude,
  aggregateUbiquite,
  weightedMean,
  computeAllIndicators,
  CERTITUDE_INDICATORS,
  UBIQUITE_INDICATORS,
} from './patent-indicators.mjs';

// ─── Helper ─────────────────────────────────────────────────────────────────────

function approx(actual, expected, tolerance = 0.05) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ~${expected} (±${tolerance}), got ${actual}`
  );
}

function inRange(value, min, max) {
  assert.ok(
    value >= min && value <= max,
    `Expected value in [${min}, ${max}], got ${value}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CERTITUDE INDICATOR TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('convergenceHHI', () => {
  it('returns 0 for empty array', () => {
    assert.equal(convergenceHHI([]), 0);
  });

  it('returns 0 for null/undefined', () => {
    assert.equal(convergenceHHI(null), 0);
    assert.equal(convergenceHHI(undefined), 0);
  });

  it('returns 1 for single CPC class (full convergence)', () => {
    assert.equal(convergenceHHI([{ cpc: 'H04L', count: 100 }]), 1);
  });

  it('returns high score for concentrated distribution', () => {
    const dist = [
      { cpc: 'H04L', count: 900 },
      { cpc: 'G06F', count: 50 },
      { cpc: 'H04W', count: 50 },
    ];
    const score = convergenceHHI(dist);
    assert.ok(score > 0.7, `Expected > 0.7, got ${score}`);
  });

  it('returns low score for even distribution', () => {
    const dist = [
      { cpc: 'A01B', count: 100 },
      { cpc: 'B01C', count: 100 },
      { cpc: 'C01D', count: 100 },
      { cpc: 'D01E', count: 100 },
      { cpc: 'E01F', count: 100 },
    ];
    const score = convergenceHHI(dist);
    assert.ok(score < 0.01, `Expected ~0 for even distribution, got ${score}`);
  });

  it('is bounded [0, 1]', () => {
    const dist = [
      { cpc: 'H04L', count: 500 },
      { cpc: 'G06F', count: 300 },
    ];
    inRange(convergenceHHI(dist), 0, 1);
  });

  it('handles zero counts gracefully', () => {
    const dist = [{ cpc: 'H04L', count: 0 }];
    assert.equal(convergenceHHI(dist), 0);
  });
});

describe('stabiliteTaxonomique', () => {
  it('returns 0 for single year (not enough data)', () => {
    assert.equal(stabiliteTaxonomique([{ year: 2020, cpcCodes: ['H04L'] }]), 0);
  });

  it('returns 0 for empty array', () => {
    assert.equal(stabiliteTaxonomique([]), 0);
  });

  it('returns 1 for perfectly stable taxonomy', () => {
    const data = [
      { year: 2018, cpcCodes: ['H04L', 'G06F'] },
      { year: 2019, cpcCodes: ['H04L', 'G06F'] },
      { year: 2020, cpcCodes: ['G06F', 'H04L'] }, // same set, different order
    ];
    approx(stabiliteTaxonomique(data), 1.0, 0.001);
  });

  it('returns low score for high churn', () => {
    const data = [
      { year: 2018, cpcCodes: ['A01B', 'B02C'] },
      { year: 2019, cpcCodes: ['C03D', 'D04E'] }, // completely different
      { year: 2020, cpcCodes: ['E05F', 'F06G'] }, // completely different again
    ];
    approx(stabiliteTaxonomique(data), 0.0, 0.001);
  });

  it('returns moderate score for partial churn', () => {
    const data = [
      { year: 2018, cpcCodes: ['H04L', 'G06F', 'H04W'] },
      { year: 2019, cpcCodes: ['H04L', 'G06F', 'G06N'] }, // 2/4 overlap
      { year: 2020, cpcCodes: ['H04L', 'G06N', 'B60L'] }, // 2/4 overlap
    ];
    const score = stabiliteTaxonomique(data);
    inRange(score, 0.3, 0.7);
  });

  it('sorts years correctly even if input is unordered', () => {
    const ordered = [
      { year: 2018, cpcCodes: ['H04L'] },
      { year: 2019, cpcCodes: ['H04L'] },
      { year: 2020, cpcCodes: ['H04L'] },
    ];
    const unordered = [
      { year: 2020, cpcCodes: ['H04L'] },
      { year: 2018, cpcCodes: ['H04L'] },
      { year: 2019, cpcCodes: ['H04L'] },
    ];
    assert.equal(stabiliteTaxonomique(ordered), stabiliteTaxonomique(unordered));
  });
});

describe('densiteCitation', () => {
  it('returns 0 for null/missing data', () => {
    assert.equal(densiteCitation(null), 0);
    assert.equal(densiteCitation({}), 0);
    assert.equal(densiteCitation({ totalForwardCitations: 0, patentCount: 0 }), 0);
  });

  it('returns ~0.5 at midpoint (10 citations/patent)', () => {
    const score = densiteCitation({ totalForwardCitations: 1000, patentCount: 100 });
    approx(score, 0.5, 0.02);
  });

  it('returns high score for heavily cited patents', () => {
    const score = densiteCitation({ totalForwardCitations: 5000, patentCount: 100 });
    assert.ok(score > 0.9, `Expected > 0.9, got ${score}`);
  });

  it('returns low score for rarely cited patents', () => {
    const score = densiteCitation({ totalForwardCitations: 10, patentCount: 100 });
    assert.ok(score < 0.1, `Expected < 0.1, got ${score}`);
  });

  it('is bounded [0, 1]', () => {
    inRange(densiteCitation({ totalForwardCitations: 999999, patentCount: 1 }), 0, 1);
  });
});

describe('retrecissementClaims', () => {
  it('returns 0 for insufficient data', () => {
    assert.equal(retrecissementClaims([]), 0);
    assert.equal(retrecissementClaims([{ year: 2020, avgIndependentClaims: 5 }]), 0);
  });

  it('returns high score for decreasing claims (narrowing)', () => {
    const data = [
      { year: 2015, avgIndependentClaims: 12 },
      { year: 2016, avgIndependentClaims: 10 },
      { year: 2017, avgIndependentClaims: 8 },
      { year: 2018, avgIndependentClaims: 6 },
      { year: 2019, avgIndependentClaims: 4 },
    ];
    const score = retrecissementClaims(data);
    assert.ok(score > 0.8, `Expected > 0.8 for strong narrowing, got ${score}`);
  });

  it('returns low score for increasing claims (broadening)', () => {
    const data = [
      { year: 2015, avgIndependentClaims: 3 },
      { year: 2016, avgIndependentClaims: 5 },
      { year: 2017, avgIndependentClaims: 7 },
      { year: 2018, avgIndependentClaims: 9 },
    ];
    const score = retrecissementClaims(data);
    assert.ok(score < 0.2, `Expected < 0.2 for broadening, got ${score}`);
  });

  it('returns ~0.5 for stable claims', () => {
    const data = [
      { year: 2015, avgIndependentClaims: 5 },
      { year: 2016, avgIndependentClaims: 5 },
      { year: 2017, avgIndependentClaims: 5 },
    ];
    approx(retrecissementClaims(data), 0.5, 0.02);
  });

  it('is bounded [0, 1]', () => {
    const extreme = [
      { year: 2015, avgIndependentClaims: 100 },
      { year: 2016, avgIndependentClaims: 1 },
    ];
    inRange(retrecissementClaims(extreme), 0, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UBIQUITÉ INDICATOR TESTS (basic coverage)
// ═══════════════════════════════════════════════════════════════════════════════

describe('diversiteAssignees', () => {
  it('returns 0 for missing data', () => {
    assert.equal(diversiteAssignees(null), 0);
  });

  it('returns high score for many assignees', () => {
    const score = diversiteAssignees({ uniqueAssignees: 200, totalPatents: 500 });
    assert.ok(score > 0.9, `Expected > 0.9, got ${score}`);
  });

  it('returns low score for few assignees', () => {
    const score = diversiteAssignees({ uniqueAssignees: 3, totalPatents: 50 });
    assert.ok(score < 0.05, `Expected < 0.05, got ${score}`);
  });
});

describe('couvertureGeo', () => {
  it('returns 0 for missing data', () => {
    assert.equal(couvertureGeo(null), 0);
  });

  it('returns high score for many jurisdictions', () => {
    const score = couvertureGeo({ jurisdictionCount: 10 });
    assert.ok(score > 0.9, `Expected > 0.9, got ${score}`);
  });

  it('supports jurisdiction list instead of count', () => {
    const score = couvertureGeo({ jurisdictions: ['US', 'EP', 'CN', 'JP', 'KR'] });
    assert.ok(score > 0.7, `Expected > 0.7, got ${score}`);
  });
});

describe('diffusionSectorielle', () => {
  it('returns 0 for missing data', () => {
    assert.equal(diffusionSectorielle(null), 0);
  });

  it('returns high score for many CPC sections', () => {
    const score = diffusionSectorielle({ uniqueSections: 7, uniqueClasses: 25 });
    assert.ok(score > 0.8, `Expected > 0.8, got ${score}`);
  });
});

describe('ratioExpires', () => {
  it('returns 0 for null/missing data', () => {
    assert.equal(ratioExpires(null), 0);
    assert.equal(ratioExpires(undefined), 0);
    assert.equal(ratioExpires({}), 0);
  });

  it('returns 0 for zero total patents', () => {
    assert.equal(ratioExpires({ expiredCount: 10, totalPatents: 0 }), 0);
  });

  it('returns high score when most patents are expired (commoditized)', () => {
    const score = ratioExpires({ expiredCount: 800, totalPatents: 1000 });
    assert.ok(score > 0.95, `Expected > 0.95 for 80% expired, got ${score}`);
  });

  it('returns ~0.5 at midpoint (40% expired)', () => {
    const score = ratioExpires({ expiredCount: 400, totalPatents: 1000 });
    approx(score, 0.5, 0.02);
  });

  it('returns low score when few patents are expired (proprietary)', () => {
    const score = ratioExpires({ expiredCount: 50, totalPatents: 1000 });
    assert.ok(score < 0.1, `Expected < 0.1 for 5% expired, got ${score}`);
  });

  it('is bounded [0, 1]', () => {
    inRange(ratioExpires({ expiredCount: 1000, totalPatents: 1000 }), 0, 1);
    inRange(ratioExpires({ expiredCount: 0, totalPatents: 1000 }), 0, 1);
  });

  it('caps expired count at totalPatents', () => {
    // expiredCount > totalPatents — should treat as 100% expired
    const score = ratioExpires({ expiredCount: 1500, totalPatents: 1000 });
    assert.ok(score > 0.95, `Expected > 0.95, got ${score}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AGGREGATION TESTS (AC 3 — certitude weighted mean)
// ═══════════════════════════════════════════════════════════════════════════════

describe('aggregateCertitude', () => {
  it('computes weighted mean with default weights summing to 1.0', () => {
    const scores = {
      convergenceHHI: 0.8,
      stabiliteTaxonomique: 0.6,
      densiteCitation: 0.7,
      retrecissementClaims: 0.9,
    };
    // Expected: 0.8*0.30 + 0.6*0.20 + 0.7*0.25 + 0.9*0.25
    //         = 0.24 + 0.12 + 0.175 + 0.225 = 0.76
    const result = aggregateCertitude(scores);
    approx(result.value, 0.76, 0.001);
    assert.equal(result.enabledCount, 4);
  });

  it('default weights sum to 1.0', () => {
    const totalWeight = CERTITUDE_INDICATORS.reduce((s, i) => s + i.weight, 0);
    approx(totalWeight, 1.0, 0.001);
  });

  it('returns breakdown with correct structure', () => {
    const scores = {
      convergenceHHI: 0.5,
      stabiliteTaxonomique: 0.5,
      densiteCitation: 0.5,
      retrecissementClaims: 0.5,
    };
    const result = aggregateCertitude(scores);
    assert.equal(result.breakdown.length, 4);
    for (const item of result.breakdown) {
      assert.ok('key' in item);
      assert.ok('score' in item);
      assert.ok('weight' in item);
      assert.ok('weightNormalized' in item);
    }
    // All same score → weighted mean = 0.5
    approx(result.value, 0.5, 0.001);
  });

  it('handles missing scores as 0', () => {
    const scores = { convergenceHHI: 1.0 }; // others missing
    const result = aggregateCertitude(scores);
    // Only convergenceHHI contributes: 1.0 * 0.30 = 0.30
    approx(result.value, 0.30, 0.001);
  });
});

describe('weight renormalization', () => {
  it('renormalizes when one indicator is disabled', () => {
    const config = [
      { key: 'convergenceHHI', weight: 0.30, enabled: true },
      { key: 'stabiliteTaxonomique', weight: 0.20, enabled: false }, // DISABLED
      { key: 'densiteCitation', weight: 0.25, enabled: true },
      { key: 'retrecissementClaims', weight: 0.25, enabled: true },
    ];
    const scores = {
      convergenceHHI: 1.0,
      stabiliteTaxonomique: 1.0, // should be ignored
      densiteCitation: 1.0,
      retrecissementClaims: 1.0,
    };
    const result = aggregateCertitude(scores, config);
    // Only 3 enabled, new weights: 0.30/(0.30+0.25+0.25), 0.25/0.80, 0.25/0.80
    // = 0.375 + 0.3125 + 0.3125 = 1.0 ✓
    // All scores 1.0 → weighted mean = 1.0
    approx(result.value, 1.0, 0.001);
    assert.equal(result.enabledCount, 3);
  });

  it('renormalizes correctly with varied scores and disabled indicator', () => {
    const config = [
      { key: 'convergenceHHI', weight: 0.30, enabled: true },
      { key: 'stabiliteTaxonomique', weight: 0.20, enabled: false },
      { key: 'densiteCitation', weight: 0.25, enabled: true },
      { key: 'retrecissementClaims', weight: 0.25, enabled: true },
    ];
    const scores = {
      convergenceHHI: 0.8,
      stabiliteTaxonomique: 0.0, // disabled, ignored
      densiteCitation: 0.6,
      retrecissementClaims: 0.4,
    };
    const result = aggregateCertitude(scores, config);
    // Renormalized: 0.30/0.80=0.375, 0.25/0.80=0.3125, 0.25/0.80=0.3125
    // = 0.8*0.375 + 0.6*0.3125 + 0.4*0.3125
    // = 0.300 + 0.1875 + 0.125 = 0.6125
    approx(result.value, 0.6125, 0.005);
  });

  it('returns 0 when all indicators disabled', () => {
    const config = CERTITUDE_INDICATORS.map(i => ({ ...i, enabled: false }));
    const result = aggregateCertitude({ convergenceHHI: 1 }, config);
    assert.equal(result.value, 0);
    assert.equal(result.enabledCount, 0);
  });

  it('normalizes to same result with single enabled indicator', () => {
    const config = [
      { key: 'convergenceHHI', weight: 0.30, enabled: true },
      { key: 'stabiliteTaxonomique', weight: 0.20, enabled: false },
      { key: 'densiteCitation', weight: 0.25, enabled: false },
      { key: 'retrecissementClaims', weight: 0.25, enabled: false },
    ];
    const scores = { convergenceHHI: 0.7 };
    const result = aggregateCertitude(scores, config);
    // Single enabled → weight normalized to 1.0 → value = 0.7
    approx(result.value, 0.7, 0.001);
  });
});

describe('aggregateUbiquite', () => {
  it('default weights sum to 1.0', () => {
    const totalWeight = UBIQUITE_INDICATORS.reduce((s, i) => s + i.weight, 0);
    approx(totalWeight, 1.0, 0.001);
  });

  it('computes weighted mean correctly', () => {
    const scores = {
      diversiteAssignees: 0.9,
      couvertureGeo: 0.7,
      diffusionSectorielle: 0.5,
      ratioExpires: 0.8,
    };
    // 0.9*0.30 + 0.7*0.25 + 0.5*0.25 + 0.8*0.20
    // = 0.27 + 0.175 + 0.125 + 0.16 = 0.73
    const result = aggregateUbiquite(scores);
    approx(result.value, 0.73, 0.001);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FULL PIPELINE TEST
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeAllIndicators', () => {
  it('computes certitude and ubiquité from full patent data', () => {
    const patentData = {
      // Certitude inputs
      cpcDistribution: [
        { cpc: 'H04L', count: 800 },
        { cpc: 'G06F', count: 100 },
        { cpc: 'H04W', count: 100 },
      ],
      yearlyClassifications: [
        { year: 2018, cpcCodes: ['H04L', 'G06F'] },
        { year: 2019, cpcCodes: ['H04L', 'G06F'] },
        { year: 2020, cpcCodes: ['H04L', 'G06F', 'H04W'] },
      ],
      citationData: { totalForwardCitations: 2000, patentCount: 100 },
      claimsTimeline: [
        { year: 2015, avgIndependentClaims: 10 },
        { year: 2020, avgIndependentClaims: 5 },
      ],
      // Ubiquité inputs
      assigneeData: { uniqueAssignees: 150, totalPatents: 500 },
      geoData: { jurisdictionCount: 6 },
      sectorData: { uniqueSections: 4, uniqueClasses: 12 },
      expirationData: { expiredCount: 250, totalPatents: 500 },
    };

    const result = computeAllIndicators(patentData);

    // Certitude should be in a reasonable range
    inRange(result.certitude.value, 0.3, 0.95);
    assert.equal(result.certitude.enabledCount, 4);

    // Ubiquité should be in a reasonable range
    inRange(result.ubiquite.value, 0.3, 0.95);
    assert.equal(result.ubiquite.enabledCount, 4);

    // All 8 scores present
    assert.equal(Object.keys(result.scores).length, 8);
    for (const score of Object.values(result.scores)) {
      inRange(score, 0, 1);
    }
  });

  it('supports custom config for indicator toggling', () => {
    const patentData = {
      cpcDistribution: [{ cpc: 'H04L', count: 100 }],
      yearlyClassifications: [
        { year: 2018, cpcCodes: ['H04L'] },
        { year: 2019, cpcCodes: ['H04L'] },
      ],
      citationData: { totalForwardCitations: 500, patentCount: 50 },
      claimsTimeline: [
        { year: 2015, avgIndependentClaims: 8 },
        { year: 2020, avgIndependentClaims: 4 },
      ],
      assigneeData: { uniqueAssignees: 100, totalPatents: 300 },
      geoData: { jurisdictionCount: 5 },
      sectorData: { uniqueSections: 3, uniqueClasses: 8 },
      expirationData: { expiredCount: 120, totalPatents: 300 },
    };

    // Disable one certitude indicator
    const customCertitude = CERTITUDE_INDICATORS.map(i =>
      i.key === 'stabiliteTaxonomique' ? { ...i, enabled: false } : i
    );

    const result = computeAllIndicators(patentData, {
      certitudeConfig: customCertitude,
    });

    assert.equal(result.certitude.enabledCount, 3);
    // stabiliteTaxonomique should NOT appear in breakdown
    const keys = result.certitude.breakdown.map(b => b.key);
    assert.ok(!keys.includes('stabiliteTaxonomique'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// weightedMean EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('weightedMean', () => {
  it('returns 0 for empty config', () => {
    const result = weightedMean({}, []);
    assert.equal(result.value, 0);
    assert.equal(result.enabledCount, 0);
  });

  it('handles all-disabled config', () => {
    const config = [{ key: 'a', weight: 1, enabled: false }];
    const result = weightedMean({ a: 1 }, config);
    assert.equal(result.value, 0);
  });

  it('result value is always in [0, 1]', () => {
    const config = [{ key: 'a', weight: 1, enabled: true }];
    // Score above 1 (shouldn't happen, but test boundary)
    const result = weightedMean({ a: 1.5 }, config);
    assert.ok(result.value <= 1);
  });
});
