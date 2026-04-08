// Tests for aggregate-properties.mjs — property aggregation logic
//
// Covers:
//   1. Basic equal-weight aggregation (12 properties, all same phase)
//   2. Mixed phases aggregation (correct weighted averaging)
//   3. Property toggling with weight renormalization (CPC indicator pattern)
//   4. Custom weight overrides
//   5. Partial coverage handling (fewer than 12 properties)
//   6. Phase agreement metric (entropy-based)
//   7. Confidence model (coverage, agreement, bounds)
//   8. Edge cases: single property, all disabled, invalid phases
//   9. Weight renormalization correctness (sum to 1.0)
//  10. Backward compatibility with simpleAggregate
//  11. PropertyScore instance aggregation
//  12. Metadata completeness

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  aggregatePropertyScores,
  aggregatePropertyScoreInstances,
  simpleAggregate,
  renormalizeWeights,
  buildWeightConfig,
  computePhaseAgreement,
  STANDARD_PROPERTY_COUNT,
  DEFAULT_WEIGHT,
  MAX_BASE_CONFIDENCE,
  MIN_CONFIDENCE,
  MAX_CONFIDENCE,
} from './aggregate-properties.mjs';
import {
  PropertyScore,
  PROPERTY_IDS,
  PROPERTY_NAMES,
} from './solution-evolution-result.mjs';
import { PHASE_TO_EVOLUTION } from './solution-base-strategy.mjs';

// ─── Test Data Helpers ─────────────────────────────────────────────────────────

/** Build 12 PropertyEvaluation plain objects, all at the same phase. */
function build12Props(phase = 3) {
  return PROPERTY_NAMES.map((name, i) => ({
    property: name,
    id: PROPERTY_IDS[i],
    phase,
    weight: 1 / 12,
  }));
}

/** Build 12 PropertyEvaluation objects with alternating phases. */
function buildAlternating(phaseA, phaseB) {
  return PROPERTY_NAMES.map((name, i) => ({
    property: name,
    id: PROPERTY_IDS[i],
    phase: i % 2 === 0 ? phaseA : phaseB,
    weight: 1 / 12,
  }));
}

/** Build 12 PropertyScore instances, all at the same phase. */
function build12Scores(phase = 3) {
  return PROPERTY_IDS.map((id, i) =>
    PropertyScore.create(id, PROPERTY_NAMES[i], phase, `Phase ${phase}`)
  );
}

/** Compute expected evolution for uniform phase. */
function expectedEvolution(phase) {
  return PHASE_TO_EVOLUTION[phase];
}

// ─── Constants ─────────────────────────────────────────────────────────────────

describe('Aggregation Constants', () => {
  it('STANDARD_PROPERTY_COUNT is 12', () => {
    assert.equal(STANDARD_PROPERTY_COUNT, 12);
  });

  it('DEFAULT_WEIGHT is approximately 1/12', () => {
    assert.ok(Math.abs(DEFAULT_WEIGHT - 1 / 12) < 0.0001);
  });

  it('MAX_BASE_CONFIDENCE is 0.85', () => {
    assert.equal(MAX_BASE_CONFIDENCE, 0.85);
  });

  it('MIN_CONFIDENCE is 0.10', () => {
    assert.equal(MIN_CONFIDENCE, 0.10);
  });

  it('MAX_CONFIDENCE is 0.95', () => {
    assert.equal(MAX_CONFIDENCE, 0.95);
  });
});

// ─── renormalizeWeights ─────────────────────────────────────────────────────────

describe('renormalizeWeights', () => {
  it('returns equal weights when all enabled with same base weight', () => {
    const config = {
      a: { weight: 1 / 3, enabled: true },
      b: { weight: 1 / 3, enabled: true },
      c: { weight: 1 / 3, enabled: true },
    };
    const result = renormalizeWeights(config);
    assert.equal(Object.keys(result).length, 3);
    for (const w of Object.values(result)) {
      assert.ok(Math.abs(w - 1 / 3) < 0.0001, `Expected ~${1 / 3}, got ${w}`);
    }
  });

  it('excludes disabled properties', () => {
    const config = {
      a: { weight: 0.25, enabled: true },
      b: { weight: 0.25, enabled: false },
      c: { weight: 0.25, enabled: true },
      d: { weight: 0.25, enabled: true },
    };
    const result = renormalizeWeights(config);
    assert.equal(Object.keys(result).length, 3);
    assert.ok(!('b' in result), 'Disabled property should not be in result');
  });

  it('renormalized weights sum to 1.0', () => {
    const config = {
      a: { weight: 0.30, enabled: true },
      b: { weight: 0.20, enabled: false },
      c: { weight: 0.25, enabled: true },
      d: { weight: 0.25, enabled: true },
    };
    const result = renormalizeWeights(config);
    const sum = Object.values(result).reduce((s, w) => s + w, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.0001, `Weights should sum to 1.0, got ${sum}`);
  });

  it('renormalizes proportionally', () => {
    const config = {
      a: { weight: 0.40, enabled: true },
      b: { weight: 0.20, enabled: false },
      c: { weight: 0.40, enabled: true },
    };
    const result = renormalizeWeights(config);
    // a and c both had 0.40 → should be 0.50 each after renormalization
    assert.ok(Math.abs(result.a - 0.50) < 0.001, `Expected 0.50, got ${result.a}`);
    assert.ok(Math.abs(result.c - 0.50) < 0.001, `Expected 0.50, got ${result.c}`);
  });

  it('returns empty map when all disabled', () => {
    const config = {
      a: { weight: 0.5, enabled: false },
      b: { weight: 0.5, enabled: false },
    };
    const result = renormalizeWeights(config);
    assert.equal(Object.keys(result).length, 0);
  });

  it('handles single enabled property', () => {
    const config = {
      a: { weight: 0.3, enabled: true },
      b: { weight: 0.3, enabled: false },
      c: { weight: 0.4, enabled: false },
    };
    const result = renormalizeWeights(config);
    assert.equal(Object.keys(result).length, 1);
    assert.equal(result.a, 1.0); // Sole property gets weight 1.0
  });

  it('falls back to equal weights when base weights are all zero', () => {
    const config = {
      a: { weight: 0, enabled: true },
      b: { weight: 0, enabled: true },
    };
    const result = renormalizeWeights(config);
    assert.equal(result.a, 0.5);
    assert.equal(result.b, 0.5);
  });

  it('treats missing enabled field as enabled (default true)', () => {
    const config = {
      a: { weight: 0.5 },
      b: { weight: 0.5 },
    };
    const result = renormalizeWeights(config);
    assert.equal(Object.keys(result).length, 2);
  });
});

// ─── buildWeightConfig ──────────────────────────────────────────────────────────

describe('buildWeightConfig', () => {
  it('builds config from property array with default weights', () => {
    const props = [
      { property: 'Market', phase: 3 },
      { property: 'Efficiency', phase: 4 },
    ];
    const config = buildWeightConfig(props);
    assert.ok('Market' in config);
    assert.ok('Efficiency' in config);
    assert.equal(config['Market'].enabled, true);
    assert.ok(Math.abs(config['Market'].weight - DEFAULT_WEIGHT) < 0.001);
  });

  it('marks disabled properties correctly', () => {
    const props = [
      { property: 'Market', id: 'market', phase: 3 },
      { property: 'Efficiency', id: 'efficiency', phase: 4 },
    ];
    const config = buildWeightConfig(props, { disabled: ['efficiency'] });
    assert.equal(config['market'].enabled, true);
    assert.equal(config['efficiency'].enabled, false);
  });

  it('applies custom weight overrides', () => {
    const props = [
      { property: 'Market', id: 'market', phase: 3 },
      { property: 'Efficiency', id: 'efficiency', phase: 4 },
    ];
    const config = buildWeightConfig(props, {
      customWeights: { market: 0.3 },
    });
    assert.equal(config['market'].weight, 0.3);
  });

  it('disabled list is case-insensitive', () => {
    const props = [
      { property: 'Market', id: 'market', phase: 3 },
      { property: 'Knowledge management', id: 'knowledge_management', phase: 2 },
    ];
    const config = buildWeightConfig(props, { disabled: ['MARKET'] });
    assert.equal(config['market'].enabled, false);
  });
});

// ─── computePhaseAgreement ──────────────────────────────────────────────────────

describe('computePhaseAgreement', () => {
  it('returns 1.0 for perfect agreement (all same phase)', () => {
    const dist = { 1: 0, 2: 0, 3: 12, 4: 0 };
    assert.equal(computePhaseAgreement(dist, 12), 1);
  });

  it('returns 0 for perfectly uniform distribution', () => {
    // 3 properties in each of 4 phases
    const dist = { 1: 3, 2: 3, 3: 3, 4: 3 };
    assert.equal(computePhaseAgreement(dist, 12), 0);
  });

  it('returns intermediate value for partial agreement', () => {
    const dist = { 1: 0, 2: 6, 3: 0, 4: 6 };
    const agreement = computePhaseAgreement(dist, 12);
    assert.ok(agreement > 0, 'Should be > 0 (not uniform)');
    assert.ok(agreement < 1, 'Should be < 1 (not perfect)');
  });

  it('returns 0 for zero total', () => {
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0 };
    assert.equal(computePhaseAgreement(dist, 0), 0);
  });

  it('returns 1.0 for single property', () => {
    const dist = { 1: 0, 2: 1, 3: 0, 4: 0 };
    assert.equal(computePhaseAgreement(dist, 1), 1);
  });

  it('higher concentration → higher agreement', () => {
    const concentrated = { 1: 0, 2: 1, 3: 10, 4: 1 };
    const spread = { 1: 3, 2: 3, 3: 3, 4: 3 };
    const concAgreement = computePhaseAgreement(concentrated, 12);
    const spreadAgreement = computePhaseAgreement(spread, 12);
    assert.ok(concAgreement > spreadAgreement,
      `Concentrated (${concAgreement}) should be > spread (${spreadAgreement})`);
  });
});

// ─── aggregatePropertyScores — Basic ────────────────────────────────────────────

describe('aggregatePropertyScores — basic equal-weight', () => {

  it('all phase 1 → evolution = 0.09 (Genesis midpoint)', () => {
    const result = aggregatePropertyScores(build12Props(1));
    assert.equal(result.evolution, expectedEvolution(1));
  });

  it('all phase 2 → evolution = 0.29 (Custom midpoint)', () => {
    const result = aggregatePropertyScores(build12Props(2));
    assert.equal(result.evolution, expectedEvolution(2));
  });

  it('all phase 3 → evolution = 0.55 (Product midpoint)', () => {
    const result = aggregatePropertyScores(build12Props(3));
    assert.equal(result.evolution, expectedEvolution(3));
  });

  it('all phase 4 → evolution = 0.85 (Commodity midpoint)', () => {
    const result = aggregatePropertyScores(build12Props(4));
    assert.equal(result.evolution, expectedEvolution(4));
  });

  it('mixed phases 2 and 4 → evolution = average of midpoints', () => {
    const props = buildAlternating(2, 4);
    const result = aggregatePropertyScores(props);
    // Expected: (6 * 0.29 + 6 * 0.85) / 12 = (1.74 + 5.10) / 12 = 0.57
    assert.equal(result.evolution, 0.57);
  });

  it('mixed phases 1 and 3 → evolution = average of midpoints', () => {
    const props = buildAlternating(1, 3);
    const result = aggregatePropertyScores(props);
    // Expected: (6 * 0.09 + 6 * 0.55) / 12 = (0.54 + 3.30) / 12 = 0.32
    assert.equal(result.evolution, 0.32);
  });

  it('returns confidence in [0, 1] range', () => {
    const result = aggregatePropertyScores(build12Props(3));
    assert.ok(result.confidence >= 0, `Confidence ${result.confidence} should be >= 0`);
    assert.ok(result.confidence <= 1, `Confidence ${result.confidence} should be <= 1`);
  });

  it('full coverage → confidence = 0.85', () => {
    const result = aggregatePropertyScores(build12Props(3));
    assert.equal(result.confidence, MAX_BASE_CONFIDENCE,
      `Expected confidence = ${MAX_BASE_CONFIDENCE}, got ${result.confidence}`);
  });

  it('returns weight map with 12 entries', () => {
    const result = aggregatePropertyScores(build12Props(3));
    assert.equal(Object.keys(result.weightMap).length, 12);
  });

  it('weight map values sum to ~1.0', () => {
    const result = aggregatePropertyScores(build12Props(3));
    const sum = Object.values(result.weightMap).reduce((s, w) => s + w, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.001, `Weight sum should be ~1.0, got ${sum}`);
  });

  it('returns metadata with all expected fields', () => {
    const result = aggregatePropertyScores(build12Props(3));
    const m = result.metadata;
    assert.equal(m.totalProperties, 12);
    assert.equal(m.enabledProperties, 12);
    assert.equal(m.disabledProperties, 0);
    assert.equal(m.validProperties, 12);
    assert.equal(m.coverage, 1);
    assert.equal(m.aggregationMethod, 'weighted_average');
    assert.equal(typeof m.phaseAgreement, 'number');
    assert.ok(m.phaseDistribution);
    assert.equal(typeof m.meanPhase, 'number');
    assert.equal(typeof m.weightedPhase, 'number');
    assert.equal(m.renormalized, false);
  });

  it('metadata.meanPhase for uniform phase 3 = 3', () => {
    const result = aggregatePropertyScores(build12Props(3));
    assert.equal(result.metadata.meanPhase, 3);
  });

  it('metadata.phaseDistribution correct for uniform phase', () => {
    const result = aggregatePropertyScores(build12Props(3));
    assert.deepEqual(result.metadata.phaseDistribution, { 1: 0, 2: 0, 3: 12, 4: 0 });
  });

  it('metadata.phaseDistribution correct for mixed phases', () => {
    const result = aggregatePropertyScores(buildAlternating(2, 4));
    assert.deepEqual(result.metadata.phaseDistribution, { 1: 0, 2: 6, 3: 0, 4: 6 });
  });

  it('metadata.phaseAgreement = 1.0 for uniform phase', () => {
    const result = aggregatePropertyScores(build12Props(3));
    assert.equal(result.metadata.phaseAgreement, 1);
  });

  it('metadata.phaseAgreement < 1.0 for mixed phases', () => {
    const result = aggregatePropertyScores(buildAlternating(2, 4));
    assert.ok(result.metadata.phaseAgreement < 1);
  });
});

// ─── aggregatePropertyScores — Property Toggling ────────────────────────────────

describe('aggregatePropertyScores — property toggling (CPC pattern)', () => {

  it('disabled properties are excluded from aggregation', () => {
    const props = build12Props(3);
    const result = aggregatePropertyScores(props, {
      disabled: ['efficiency', 'decision_driver'],
    });
    assert.equal(result.metadata.enabledProperties, 10);
    assert.equal(result.metadata.disabledProperties, 2);
  });

  it('disabling properties renormalizes weights to sum to 1.0', () => {
    const props = build12Props(3);
    const result = aggregatePropertyScores(props, {
      disabled: ['efficiency', 'decision_driver'],
    });
    const sum = Object.values(result.weightMap).reduce((s, w) => s + w, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.001, `Weights should sum to 1.0, got ${sum}`);
  });

  it('disabled properties are NOT in the weight map', () => {
    const props = build12Props(3);
    const result = aggregatePropertyScores(props, {
      disabled: ['efficiency'],
    });
    // Weight map should not contain 'efficiency' or its display name
    for (const key of Object.keys(result.weightMap)) {
      assert.ok(key.toLowerCase() !== 'efficiency',
        `Disabled property "efficiency" should not be in weightMap`);
    }
  });

  it('evolution unchanged when all at same phase (disabled properties irrelevant)', () => {
    const props = build12Props(3);
    const resultAll = aggregatePropertyScores(props);
    const resultPartial = aggregatePropertyScores(props, {
      disabled: ['efficiency', 'decision_driver'],
    });
    // When all phases are the same, disabling any subset doesn't change evolution
    assert.equal(resultAll.evolution, resultPartial.evolution);
  });

  it('metadata.renormalized = true when toggling is applied', () => {
    const props = build12Props(3);
    const result = aggregatePropertyScores(props, { disabled: ['efficiency'] });
    assert.equal(result.metadata.renormalized, true);
  });

  it('metadata.renormalized = false when no toggling', () => {
    const result = aggregatePropertyScores(build12Props(3));
    assert.equal(result.metadata.renormalized, false);
  });

  it('disabling high-phase property lowers evolution for mixed input', () => {
    // 11 properties at phase 2, 1 at phase 4
    const props = PROPERTY_NAMES.map((name, i) => ({
      property: name,
      id: PROPERTY_IDS[i],
      phase: i === 0 ? 4 : 2,
      weight: 1 / 12,
    }));

    const resultAll = aggregatePropertyScores(props);
    const resultDisabled = aggregatePropertyScores(props, {
      disabled: ['market'], // market was the phase 4 property
    });

    assert.ok(resultDisabled.evolution < resultAll.evolution,
      `Disabling the high-phase property should lower evolution: ` +
      `all=${resultAll.evolution}, disabled=${resultDisabled.evolution}`);
  });

  it('throws when all properties are disabled', () => {
    const props = build12Props(3);
    assert.throws(
      () => aggregatePropertyScores(props, {
        disabled: PROPERTY_IDS.slice(), // all 12
      }),
      /All properties are disabled/
    );
  });
});

// ─── aggregatePropertyScores — Custom Weights ───────────────────────────────────

describe('aggregatePropertyScores — custom weights', () => {

  it('custom weights are applied and renormalized', () => {
    const props = build12Props(3);
    const result = aggregatePropertyScores(props, {
      customWeights: { market: 0.5 },
    });
    // Market should have a higher weight than others
    const marketKey = Object.keys(result.weightMap).find(k => k.toLowerCase().includes('market') && !k.toLowerCase().includes('perception') && !k.toLowerCase().includes('action'));
    assert.ok(marketKey, 'Market should be in weight map');
    const otherKeys = Object.keys(result.weightMap).filter(k => k !== marketKey);
    for (const k of otherKeys) {
      assert.ok(result.weightMap[marketKey] > result.weightMap[k],
        `Market weight (${result.weightMap[marketKey]}) should be > ${k} weight (${result.weightMap[k]})`);
    }
  });

  it('custom weights with toggling: renormalized correctly', () => {
    const props = build12Props(3);
    const result = aggregatePropertyScores(props, {
      customWeights: { market: 0.5 },
      disabled: ['efficiency'],
    });
    const sum = Object.values(result.weightMap).reduce((s, w) => s + w, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.001, `Weights should sum to 1.0, got ${sum}`);
    assert.equal(result.metadata.renormalized, true);
  });
});

// ─── aggregatePropertyScores — Partial Coverage ─────────────────────────────────

describe('aggregatePropertyScores — partial coverage', () => {

  it('fewer than 12 properties → lower coverage', () => {
    const props = build12Props(3).slice(0, 6); // Only 6 of 12
    const result = aggregatePropertyScores(props);
    assert.equal(result.metadata.coverage, 0.5);
  });

  it('partial coverage → lower confidence', () => {
    const fullResult = aggregatePropertyScores(build12Props(3));
    const partialResult = aggregatePropertyScores(build12Props(3).slice(0, 6));
    assert.ok(partialResult.confidence < fullResult.confidence,
      `Partial confidence (${partialResult.confidence}) should be < full (${fullResult.confidence})`);
  });

  it('single property works', () => {
    const props = [{ property: 'Market', phase: 3, weight: 1 / 12 }];
    const result = aggregatePropertyScores(props);
    assert.equal(result.evolution, 0.55);
    assert.equal(result.metadata.validProperties, 1);
  });

  it('respects custom totalExpected', () => {
    const props = build12Props(3).slice(0, 6);
    const result = aggregatePropertyScores(props, { totalExpected: 6 });
    assert.equal(result.metadata.coverage, 1.0);
  });
});

// ─── aggregatePropertyScores — Confidence Bounds ────────────────────────────────

describe('aggregatePropertyScores — confidence bounds', () => {

  it('confidence is never > MAX_CONFIDENCE (0.95)', () => {
    const result = aggregatePropertyScores(build12Props(3));
    assert.ok(result.confidence <= MAX_CONFIDENCE,
      `Confidence ${result.confidence} should be <= ${MAX_CONFIDENCE}`);
  });

  it('confidence is at least MIN_CONFIDENCE for valid input', () => {
    // Very few properties
    const props = [{ property: 'Market', phase: 3 }];
    const result = aggregatePropertyScores(props);
    assert.ok(result.confidence >= MIN_CONFIDENCE,
      `Confidence ${result.confidence} should be >= ${MIN_CONFIDENCE}`);
  });
});

// ─── aggregatePropertyScores — Error Handling ───────────────────────────────────

describe('aggregatePropertyScores — error handling', () => {

  it('throws on empty array', () => {
    assert.throws(
      () => aggregatePropertyScores([]),
      /non-empty array/
    );
  });

  it('throws on null input', () => {
    assert.throws(
      () => aggregatePropertyScores(null),
      /non-empty array/
    );
  });

  it('throws when all phases are invalid', () => {
    assert.throws(
      () => aggregatePropertyScores([
        { property: 'Market', phase: 0 },
        { property: 'Efficiency', phase: 5 },
      ]),
      /No valid property evaluations/
    );
  });
});

// ─── simpleAggregate (backward compatibility) ───────────────────────────────────

describe('simpleAggregate', () => {

  it('returns { evolution, confidence } shape', () => {
    const result = simpleAggregate(build12Props(3));
    assert.equal(typeof result.evolution, 'number');
    assert.equal(typeof result.confidence, 'number');
    assert.ok(!('weightMap' in result), 'Should not include weightMap');
    assert.ok(!('metadata' in result), 'Should not include metadata');
  });

  it('matches aggregatePropertyScores for basic case', () => {
    const full = aggregatePropertyScores(build12Props(3));
    const simple = simpleAggregate(build12Props(3));
    assert.equal(simple.evolution, full.evolution);
    assert.equal(simple.confidence, full.confidence);
  });

  it('all phase 3 → evolution = 0.55', () => {
    const result = simpleAggregate(build12Props(3));
    assert.equal(result.evolution, 0.55);
  });
});

// ─── aggregatePropertyScoreInstances ────────────────────────────────────────────

describe('aggregatePropertyScoreInstances', () => {

  it('aggregates PropertyScore instances', () => {
    const scores = build12Scores(3);
    const result = aggregatePropertyScoreInstances(scores);
    assert.equal(result.evolution, 0.55);
    assert.equal(result.metadata.validProperties, 12);
  });

  it('supports toggling with PropertyScore instances', () => {
    const scores = build12Scores(3);
    const result = aggregatePropertyScoreInstances(scores, {
      disabled: ['efficiency'],
    });
    assert.equal(result.metadata.enabledProperties, 11);
    assert.equal(result.metadata.disabledProperties, 1);
  });

  it('mixed phases produce correct evolution', () => {
    // Half at phase 2, half at phase 4
    const scores = PROPERTY_IDS.map((id, i) =>
      PropertyScore.create(id, PROPERTY_NAMES[i], i < 6 ? 2 : 4, 'Mixed')
    );
    const result = aggregatePropertyScoreInstances(scores);
    // Expected: (6 * 0.29 + 6 * 0.85) / 12 = 0.57
    assert.equal(result.evolution, 0.57);
  });
});

// ─── Integration: Aggregation matches manual calculation ────────────────────────

describe('Aggregation — manual calculation verification', () => {

  it('3 at phase 1, 4 at phase 2, 3 at phase 3, 2 at phase 4 → correct evolution', () => {
    const phases = [1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4];
    const props = phases.map((phase, i) => ({
      property: PROPERTY_NAMES[i],
      id: PROPERTY_IDS[i],
      phase,
      weight: 1 / 12,
    }));
    const result = aggregatePropertyScores(props);

    // Manual calculation:
    // 3 × 0.09 + 4 × 0.29 + 3 × 0.55 + 2 × 0.85 = 0.27 + 1.16 + 1.65 + 1.70 = 4.78
    // 4.78 / 12 = 0.398333...
    // Rounded to 3 decimals: 0.398
    const expected = Math.round(
      (3 * 0.09 + 4 * 0.29 + 3 * 0.55 + 2 * 0.85) / 12 * 1000
    ) / 1000;
    assert.equal(result.evolution, expected,
      `Expected ${expected}, got ${result.evolution}`);
  });

  it('equal weights: each property contributes 1/12', () => {
    const props = build12Props(3);
    const result = aggregatePropertyScores(props);

    // Each property at phase 3 → evo 0.55, weight 1/12
    // Total: 12 × (0.55 × 1/12) = 0.55
    assert.equal(result.evolution, 0.55);
  });

  it('toggling 2 of 12: remaining 10 get weight 1/10 each', () => {
    const props = build12Props(3);
    const result = aggregatePropertyScores(props, {
      disabled: ['efficiency', 'decision_driver'],
    });

    // Each remaining weight = (1/12) / (10 × 1/12) = 1/10
    const expectedWeight = 1 / 10;
    for (const w of Object.values(result.weightMap)) {
      assert.ok(Math.abs(w - expectedWeight) < 0.001,
        `Expected weight ~${expectedWeight}, got ${w}`);
    }
  });
});
