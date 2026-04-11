// Tests for SolutionEvolutionResult, PropertyScore, and ConfidenceMetadata
//
// Verifies:
//   1. PropertyScore construction, validation, and conversion
//   2. ConfidenceMetadata construction and validation
//   3. SolutionEvolutionResult core contract alignment
//   4. Factory method: fromPropertyScores (12 properties, equal weights)
//   5. Factory method: fromEvolutionResult (backward compatibility)
//   6. Computed properties: stage, meanPhase, phaseDistribution
//   7. Interoperability: toEvolutionResult passes BaseStrategy.validateResult
//   8. Validation: rejects invalid data, edge cases
//   9. Serialization: toJSON round-trip fidelity
//  10. Constants: PROPERTY_IDS, PROPERTY_NAMES, mappings

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  PropertyScore,
  ConfidenceMetadata,
  SolutionEvolutionResult,
  PROPERTY_COUNT,
  DEFAULT_WEIGHT,
  PROPERTY_IDS,
  PROPERTY_NAMES,
  PROPERTY_ID_TO_NAME,
  PROPERTY_NAME_TO_ID,
} from './solution-evolution-result.mjs';
import { BaseStrategy } from '../base-strategy.mjs';
import { SolutionBaseStrategy, PHASE_TO_EVOLUTION, PHASE_LABELS } from './solution-base-strategy.mjs';

// ─── Test Data Helpers ───────────────────────────────────────────────────────

/** Build 12 PropertyScore instances, one per canonical property. */
function build12Scores(phase = 3) {
  return PROPERTY_IDS.map((id, i) =>
    PropertyScore.create(id, PROPERTY_NAMES[i], phase, `Phase ${phase} for ${PROPERTY_NAMES[i]}`)
  );
}

/** Build mixed scores: half at phase 2, half at phase 4. */
function buildMixedScores() {
  return PROPERTY_IDS.map((id, i) =>
    PropertyScore.create(
      id, PROPERTY_NAMES[i],
      i < 6 ? 2 : 4,
      `Mixed evaluation for ${PROPERTY_NAMES[i]}`
    )
  );
}

// ─── Constants ───────────────────────────────────────────────────────────────

describe('Constants', () => {
  it('PROPERTY_COUNT is 12', () => {
    assert.equal(PROPERTY_COUNT, 12);
  });

  it('DEFAULT_WEIGHT is 1/12', () => {
    assert.ok(Math.abs(DEFAULT_WEIGHT - 1 / 12) < 0.0001);
  });

  it('PROPERTY_IDS has 12 entries', () => {
    assert.equal(PROPERTY_IDS.length, 12);
  });

  it('PROPERTY_NAMES has 12 entries', () => {
    assert.equal(PROPERTY_NAMES.length, 12);
  });

  it('PROPERTY_IDS are unique', () => {
    assert.equal(new Set(PROPERTY_IDS).size, 12);
  });

  it('PROPERTY_NAMES are unique', () => {
    assert.equal(new Set(PROPERTY_NAMES).size, 12);
  });

  it('PROPERTY_ID_TO_NAME maps all IDs to names', () => {
    for (let i = 0; i < PROPERTY_IDS.length; i++) {
      assert.equal(PROPERTY_ID_TO_NAME.get(PROPERTY_IDS[i]), PROPERTY_NAMES[i]);
    }
  });

  it('PROPERTY_NAME_TO_ID maps all names to IDs (case-insensitive)', () => {
    for (let i = 0; i < PROPERTY_NAMES.length; i++) {
      assert.equal(PROPERTY_NAME_TO_ID.get(PROPERTY_NAMES[i].toLowerCase()), PROPERTY_IDS[i]);
    }
  });

  it('PROPERTY_IDS are frozen', () => {
    assert.ok(Object.isFrozen(PROPERTY_IDS));
  });

  it('PROPERTY_NAMES are frozen', () => {
    assert.ok(Object.isFrozen(PROPERTY_NAMES));
  });

  it('first property is "market" / "Market"', () => {
    assert.equal(PROPERTY_IDS[0], 'market');
    assert.equal(PROPERTY_NAMES[0], 'Market');
  });

  it('last property is "decision_driver" / "Decision driver"', () => {
    assert.equal(PROPERTY_IDS[11], 'decision_driver');
    assert.equal(PROPERTY_NAMES[11], 'Decision driver');
  });
});

// ─── PropertyScore ───────────────────────────────────────────────────────────

describe('PropertyScore', () => {

  describe('construction', () => {
    it('creates with all fields', () => {
      const score = new PropertyScore({
        id: 'market',
        property: 'Market',
        phase: 3,
        label: 'Product',
        weight: 1 / 12,
        confidence: 0.85,
        reason: 'Growing competitive market',
        phaseDescription: 'Established market with growing competition',
      });
      assert.equal(score.id, 'market');
      assert.equal(score.property, 'Market');
      assert.equal(score.phase, 3);
      assert.equal(score.label, 'Product');
      assert.ok(Math.abs(score.weight - 1 / 12) < 0.0001);
      assert.equal(score.confidence, 0.85);
      assert.equal(score.reason, 'Growing competitive market');
      assert.equal(score.phaseDescription, 'Established market with growing competition');
    });

    it('auto-derives label from phase', () => {
      const score = new PropertyScore({ id: 'market', property: 'Market', phase: 1 });
      assert.equal(score.label, 'Genesis');
    });

    it('defaults weight to 1/12', () => {
      const score = new PropertyScore({ id: 'market', property: 'Market', phase: 2 });
      assert.ok(Math.abs(score.weight - 1 / 12) < 0.0001);
    });

    it('defaults confidence to null', () => {
      const score = new PropertyScore({ id: 'market', property: 'Market', phase: 3 });
      assert.equal(score.confidence, null);
    });

    it('defaults reason to null', () => {
      const score = new PropertyScore({ id: 'market', property: 'Market', phase: 3 });
      assert.equal(score.reason, null);
    });

    it('rounds fractional phases', () => {
      const score = new PropertyScore({ id: 'market', property: 'Market', phase: 2.7 });
      assert.equal(score.phase, 3);
    });
  });

  describe('validation', () => {
    it('rejects missing id', () => {
      assert.throws(
        () => new PropertyScore({ id: '', property: 'Market', phase: 2 }),
        /id must be a non-empty string/
      );
    });

    it('rejects missing property name', () => {
      assert.throws(
        () => new PropertyScore({ id: 'market', property: '', phase: 2 }),
        /property must be a non-empty string/
      );
    });

    it('rejects phase below 1', () => {
      assert.throws(
        () => new PropertyScore({ id: 'market', property: 'Market', phase: 0 }),
        /phase must be 1–4/
      );
    });

    it('rejects phase above 4', () => {
      assert.throws(
        () => new PropertyScore({ id: 'market', property: 'Market', phase: 5 }),
        /phase must be 1–4/
      );
    });

    it('rejects NaN phase', () => {
      assert.throws(
        () => new PropertyScore({ id: 'market', property: 'Market', phase: NaN }),
        /phase must be 1–4/
      );
    });
  });

  describe('evolution (computed)', () => {
    it('phase 1 → 0.09', () => {
      const score = PropertyScore.create('market', 'Market', 1);
      assert.equal(score.evolution, 0.09);
    });

    it('phase 2 → 0.29', () => {
      const score = PropertyScore.create('market', 'Market', 2);
      assert.equal(score.evolution, 0.29);
    });

    it('phase 3 → 0.55', () => {
      const score = PropertyScore.create('market', 'Market', 3);
      assert.equal(score.evolution, 0.55);
    });

    it('phase 4 → 0.85', () => {
      const score = PropertyScore.create('market', 'Market', 4);
      assert.equal(score.evolution, 0.85);
    });
  });

  describe('factory: create()', () => {
    it('creates with minimal args', () => {
      const score = PropertyScore.create('market', 'Market', 3);
      assert.equal(score.id, 'market');
      assert.equal(score.property, 'Market');
      assert.equal(score.phase, 3);
      assert.equal(score.reason, null);
    });

    it('creates with reason', () => {
      const score = PropertyScore.create('market', 'Market', 3, 'Mature market');
      assert.equal(score.reason, 'Mature market');
    });

    it('creates with extra fields', () => {
      const score = PropertyScore.create('market', 'Market', 3, 'Reason', {
        confidence: 0.9,
        phaseDescription: 'Description text',
      });
      assert.equal(score.confidence, 0.9);
      assert.equal(score.phaseDescription, 'Description text');
    });
  });

  describe('factory: fromPropertyEvaluation()', () => {
    it('converts a PropertyEvaluation to PropertyScore', () => {
      const evalObj = SolutionBaseStrategy.buildPropertyEvaluation('Market', 3, 'Growing market');
      const score = PropertyScore.fromPropertyEvaluation(evalObj);
      assert.equal(score.id, 'market');
      assert.equal(score.property, 'Market');
      assert.equal(score.phase, 3);
      assert.equal(score.label, 'Product');
      assert.equal(score.reason, 'Growing market');
    });

    it('resolves ID from canonical name map', () => {
      const evalObj = SolutionBaseStrategy.buildPropertyEvaluation('Knowledge management', 2);
      const score = PropertyScore.fromPropertyEvaluation(evalObj);
      assert.equal(score.id, 'knowledge_management');
    });

    it('accepts explicit ID override', () => {
      const evalObj = { property: 'Custom Prop', phase: 1, label: 'Genesis', weight: 1 / 12 };
      const score = PropertyScore.fromPropertyEvaluation(evalObj, 'custom_prop');
      assert.equal(score.id, 'custom_prop');
    });

    it('falls back to name-derived ID for unknown properties', () => {
      const evalObj = { property: 'New Property', phase: 2, label: 'Custom', weight: 1 / 12 };
      const score = PropertyScore.fromPropertyEvaluation(evalObj);
      assert.equal(score.id, 'new_property');
    });
  });

  describe('toPropertyEvaluation()', () => {
    it('produces a valid PropertyEvaluation object', () => {
      const score = PropertyScore.create('market', 'Market', 3, 'Test reason');
      const eval_ = score.toPropertyEvaluation();
      assert.equal(eval_.property, 'Market');
      assert.equal(eval_.phase, 3);
      assert.equal(eval_.label, 'Product');
      assert.ok(Math.abs(eval_.weight - 1 / 12) < 0.0001);
      assert.equal(eval_.reason, 'Test reason');
    });

    it('omits reason when null', () => {
      const score = PropertyScore.create('market', 'Market', 2);
      const eval_ = score.toPropertyEvaluation();
      assert.ok(!('reason' in eval_));
    });

    it('passes SolutionBaseStrategy.validateSolutionResult when wrapped', () => {
      const score = PropertyScore.create('market', 'Market', 3, 'Good market');
      const result = {
        evolution: 0.55,
        confidence: 0.8,
        method: 'test',
        properties: [score.toPropertyEvaluation()],
      };
      // Should not throw
      SolutionBaseStrategy.validateSolutionResult(result);
    });
  });

  describe('toJSON()', () => {
    it('includes all set fields', () => {
      const score = new PropertyScore({
        id: 'market',
        property: 'Market',
        phase: 3,
        confidence: 0.9,
        reason: 'Test',
        phaseDescription: 'Desc',
      });
      const json = score.toJSON();
      assert.equal(json.id, 'market');
      assert.equal(json.property, 'Market');
      assert.equal(json.phase, 3);
      assert.equal(json.label, 'Product');
      assert.equal(json.evolution, 0.55);
      assert.equal(json.confidence, 0.9);
      assert.equal(json.reason, 'Test');
      assert.equal(json.phaseDescription, 'Desc');
    });

    it('omits null optional fields', () => {
      const score = PropertyScore.create('market', 'Market', 2);
      const json = score.toJSON();
      assert.ok(!('confidence' in json));
      assert.ok(!('reason' in json));
      assert.ok(!('phaseDescription' in json));
    });
  });
});

// ─── ConfidenceMetadata ─────────────────────────────────────────────────────

describe('ConfidenceMetadata', () => {

  describe('construction', () => {
    it('creates with all fields', () => {
      const meta = new ConfidenceMetadata({
        coverage: 1.0,
        evaluatedCount: 12,
        totalCount: 12,
        mode: 'auto',
        meanPropertyConfidence: 0.85,
        aggregationMethod: 'weighted_average',
        phaseAgreement: 0.75,
      });
      assert.equal(meta.coverage, 1.0);
      assert.equal(meta.evaluatedCount, 12);
      assert.equal(meta.totalCount, 12);
      assert.equal(meta.mode, 'auto');
      assert.equal(meta.meanPropertyConfidence, 0.85);
      assert.equal(meta.aggregationMethod, 'weighted_average');
      assert.equal(meta.phaseAgreement, 0.75);
    });

    it('defaults totalCount to 12', () => {
      const meta = new ConfidenceMetadata({ coverage: 0.5, evaluatedCount: 6 });
      assert.equal(meta.totalCount, 12);
    });

    it('defaults mode to auto', () => {
      const meta = new ConfidenceMetadata({ coverage: 1, evaluatedCount: 12 });
      assert.equal(meta.mode, 'auto');
    });

    it('defaults aggregationMethod to weighted_average', () => {
      const meta = new ConfidenceMetadata({ coverage: 1, evaluatedCount: 12 });
      assert.equal(meta.aggregationMethod, 'weighted_average');
    });

    it('rounds coverage to 3 decimals', () => {
      const meta = new ConfidenceMetadata({ coverage: 0.33333, evaluatedCount: 4 });
      assert.equal(meta.coverage, 0.333);
    });
  });

  describe('validation', () => {
    it('rejects coverage < 0', () => {
      assert.throws(
        () => new ConfidenceMetadata({ coverage: -0.1, evaluatedCount: 0 }),
        /coverage must be 0–1/
      );
    });

    it('rejects coverage > 1', () => {
      assert.throws(
        () => new ConfidenceMetadata({ coverage: 1.1, evaluatedCount: 12 }),
        /coverage must be 0–1/
      );
    });

    it('rejects negative evaluatedCount', () => {
      assert.throws(
        () => new ConfidenceMetadata({ coverage: 0.5, evaluatedCount: -1 }),
        /evaluatedCount must be >= 0/
      );
    });
  });

  describe('toJSON()', () => {
    it('includes all required fields', () => {
      const meta = new ConfidenceMetadata({
        coverage: 0.833,
        evaluatedCount: 10,
        totalCount: 12,
        mode: 'conversational',
        meanPropertyConfidence: 0.8,
        phaseAgreement: 0.6,
      });
      const json = meta.toJSON();
      assert.equal(json.coverage, 0.833);
      assert.equal(json.evaluatedCount, 10);
      assert.equal(json.totalCount, 12);
      assert.equal(json.mode, 'conversational');
      assert.equal(json.meanPropertyConfidence, 0.8);
      assert.equal(json.phaseAgreement, 0.6);
      assert.equal(json.aggregationMethod, 'weighted_average');
    });

    it('omits null optional fields', () => {
      const meta = new ConfidenceMetadata({ coverage: 1, evaluatedCount: 12 });
      const json = meta.toJSON();
      assert.ok(!('meanPropertyConfidence' in json));
      assert.ok(!('phaseAgreement' in json));
    });
  });
});

// ─── SolutionEvolutionResult ────────────────────────────────────────────────

describe('SolutionEvolutionResult', () => {

  describe('construction', () => {
    it('creates with required fields', () => {
      const result = new SolutionEvolutionResult({
        evolution: 0.55,
        confidence: 0.85,
        method: 'solution-properties',
      });
      assert.equal(result.evolution, 0.55);
      assert.equal(result.confidence, 0.85);
      assert.equal(result.method, 'solution-properties');
      assert.deepEqual(result.trace, []);
      assert.deepEqual(result.properties, []);
      assert.equal(result.confidenceMetadata, null);
    });

    it('rounds evolution to 3 decimals', () => {
      const result = new SolutionEvolutionResult({
        evolution: 0.571428,
        confidence: 0.8,
        method: 'test',
      });
      assert.equal(result.evolution, 0.571);
    });

    it('rounds confidence to 3 decimals', () => {
      const result = new SolutionEvolutionResult({
        evolution: 0.5,
        confidence: 0.84999,
        method: 'test',
      });
      assert.equal(result.confidence, 0.85);
    });
  });

  describe('validation', () => {
    it('rejects non-number evolution', () => {
      assert.throws(
        () => new SolutionEvolutionResult({ evolution: 'bad', confidence: 0.8, method: 'x' }),
        /evolution must be a number/
      );
    });

    it('rejects NaN evolution', () => {
      assert.throws(
        () => new SolutionEvolutionResult({ evolution: NaN, confidence: 0.8, method: 'x' }),
        /evolution must be a number/
      );
    });

    it('rejects confidence out of range', () => {
      assert.throws(
        () => new SolutionEvolutionResult({ evolution: 0.5, confidence: 1.5, method: 'x' }),
        /confidence must be 0–1/
      );
    });

    it('rejects empty method', () => {
      assert.throws(
        () => new SolutionEvolutionResult({ evolution: 0.5, confidence: 0.8, method: '' }),
        /method must be a non-empty string/
      );
    });
  });

  describe('computed: stage', () => {
    it('maps evolution < 0.18 to Genesis', () => {
      const r = new SolutionEvolutionResult({ evolution: 0.09, confidence: 0.8, method: 'x' });
      assert.equal(r.stage, 'Genesis');
    });

    it('maps evolution 0.18-0.40 to Custom', () => {
      const r = new SolutionEvolutionResult({ evolution: 0.29, confidence: 0.8, method: 'x' });
      assert.equal(r.stage, 'Custom');
    });

    it('maps evolution 0.40-0.70 to Product', () => {
      const r = new SolutionEvolutionResult({ evolution: 0.55, confidence: 0.8, method: 'x' });
      assert.equal(r.stage, 'Product');
    });

    it('maps evolution >= 0.70 to Commodity', () => {
      const r = new SolutionEvolutionResult({ evolution: 0.85, confidence: 0.8, method: 'x' });
      assert.equal(r.stage, 'Commodity');
    });
  });

  describe('computed: meanPhase', () => {
    it('returns null when no properties', () => {
      const r = new SolutionEvolutionResult({ evolution: 0.5, confidence: 0.8, method: 'x' });
      assert.equal(r.meanPhase, null);
    });

    it('computes mean of all property phases', () => {
      const scores = build12Scores(3);
      const r = new SolutionEvolutionResult({
        evolution: 0.55, confidence: 0.85, method: 'x', properties: scores,
      });
      assert.equal(r.meanPhase, 3);
    });

    it('computes mean for mixed phases', () => {
      const scores = buildMixedScores();
      const r = new SolutionEvolutionResult({
        evolution: 0.57, confidence: 0.8, method: 'x', properties: scores,
      });
      // 6*2 + 6*4 = 12+24 = 36, mean = 36/12 = 3
      assert.equal(r.meanPhase, 3);
    });
  });

  describe('computed: phaseDistribution', () => {
    it('returns correct distribution for uniform phases', () => {
      const scores = build12Scores(3);
      const r = new SolutionEvolutionResult({
        evolution: 0.55, confidence: 0.85, method: 'x', properties: scores,
      });
      assert.deepEqual(r.phaseDistribution, { 1: 0, 2: 0, 3: 12, 4: 0 });
    });

    it('returns correct distribution for mixed phases', () => {
      const scores = buildMixedScores();
      const r = new SolutionEvolutionResult({
        evolution: 0.57, confidence: 0.8, method: 'x', properties: scores,
      });
      assert.deepEqual(r.phaseDistribution, { 1: 0, 2: 6, 3: 0, 4: 6 });
    });

    it('returns zeros when no properties', () => {
      const r = new SolutionEvolutionResult({ evolution: 0.5, confidence: 0.8, method: 'x' });
      assert.deepEqual(r.phaseDistribution, { 1: 0, 2: 0, 3: 0, 4: 0 });
    });
  });

  // ─── Factory: fromPropertyScores ──────────────────────────────────────

  describe('fromPropertyScores', () => {
    it('creates result from 12 uniform scores (all phase 3)', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, {
        method: 'solution-properties',
      });
      assert.equal(result.evolution, 0.55);
      assert.equal(result.method, 'solution-properties');
      assert.equal(result.propertyCount, 12);
      assert.equal(result.stage, 'Product');
    });

    it('creates result from 12 mixed scores (half phase 2, half phase 4)', () => {
      const scores = buildMixedScores();
      const result = SolutionEvolutionResult.fromPropertyScores(scores, {
        method: 'solution-properties',
      });
      // Expected: (6 * 0.29 + 6 * 0.85) / 12 = (1.74 + 5.10) / 12 = 0.57
      assert.equal(result.evolution, 0.57);
    });

    it('computes confidence metadata', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, {
        method: 'test',
        mode: 'auto',
      });
      assert.ok(result.confidenceMetadata != null);
      assert.equal(result.confidenceMetadata.mode, 'auto');
      assert.equal(result.confidenceMetadata.evaluatedCount, 12);
      assert.equal(result.confidenceMetadata.totalCount, 12);
      assert.equal(result.confidenceMetadata.coverage, 1);
      assert.equal(result.confidenceMetadata.aggregationMethod, 'weighted_average');
    });

    it('computes phaseAgreement = 1.0 for uniform phases', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      assert.equal(result.confidenceMetadata.phaseAgreement, 1);
    });

    it('computes phaseAgreement < 1.0 for mixed phases', () => {
      const scores = buildMixedScores();
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      assert.ok(result.confidenceMetadata.phaseAgreement < 1);
      assert.ok(result.confidenceMetadata.phaseAgreement > 0);
    });

    it('includes trace entries', () => {
      const scores = build12Scores(2);
      const trace = [{ step: 'test', note: 'custom trace' }];
      const result = SolutionEvolutionResult.fromPropertyScores(scores, {
        method: 'test',
        trace,
      });
      assert.equal(result.trace.length, 1);
      assert.equal(result.trace[0].step, 'test');
    });

    it('defaults mode to auto', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      assert.equal(result.confidenceMetadata.mode, 'auto');
    });

    it('accepts conversational mode', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, {
        method: 'test',
        mode: 'conversational',
      });
      assert.equal(result.confidenceMetadata.mode, 'conversational');
    });

    it('throws on empty scores array', () => {
      assert.throws(
        () => SolutionEvolutionResult.fromPropertyScores([], { method: 'test' }),
        /non-empty array/
      );
    });

    it('computes meanPropertyConfidence when scores have confidence', () => {
      const scores = PROPERTY_IDS.map((id, i) =>
        new PropertyScore({
          id,
          property: PROPERTY_NAMES[i],
          phase: 3,
          confidence: 0.8 + (i % 3) * 0.05,
          reason: 'Test',
        })
      );
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      assert.ok(result.confidenceMetadata.meanPropertyConfidence != null);
      assert.ok(result.confidenceMetadata.meanPropertyConfidence > 0);
    });
  });

  // ─── Factory: fromEvolutionResult ─────────────────────────────────────

  describe('fromEvolutionResult', () => {
    it('reconstructs from a plain EvolutionResult object', () => {
      const plain = {
        evolution: 0.55,
        confidence: 0.85,
        method: 'solution-properties',
        trace: [{ step: 'test' }],
        properties: [
          { property: 'Market', phase: 3, label: 'Product', weight: 1 / 12, reason: 'Test' },
          { property: 'Knowledge management', phase: 2, label: 'Custom', weight: 1 / 12 },
        ],
      };
      const result = SolutionEvolutionResult.fromEvolutionResult(plain);
      assert.equal(result.evolution, 0.55);
      assert.equal(result.confidence, 0.85);
      assert.equal(result.method, 'solution-properties');
      assert.equal(result.propertyCount, 2);
      assert.ok(result.properties[0] instanceof PropertyScore);
      assert.equal(result.properties[0].id, 'market');
      assert.equal(result.properties[1].id, 'knowledge_management');
    });

    it('handles result without properties', () => {
      const plain = {
        evolution: 0.5,
        confidence: 0.8,
        method: 'simple',
      };
      const result = SolutionEvolutionResult.fromEvolutionResult(plain);
      assert.equal(result.propertyCount, 0);
    });

    it('preserves existing PropertyScore instances', () => {
      const score = PropertyScore.create('market', 'Market', 3);
      const plain = {
        evolution: 0.55,
        confidence: 0.85,
        method: 'test',
        properties: [score],
      };
      const result = SolutionEvolutionResult.fromEvolutionResult(plain);
      assert.ok(result.properties[0] instanceof PropertyScore);
      assert.equal(result.properties[0], score); // same instance
    });
  });

  // ─── Validation ───────────────────────────────────────────────────────

  describe('validate()', () => {
    it('passes for a valid result', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, {
        method: 'solution-properties',
      });
      // Should not throw
      const validated = result.validate();
      assert.equal(validated, result); // returns self for chaining
    });

    it('passes for result without properties', () => {
      const result = new SolutionEvolutionResult({
        evolution: 0.5,
        confidence: 0.8,
        method: 'simple',
      });
      result.validate();
    });

    it('result passes BaseStrategy.validateResult', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, {
        method: 'solution-properties',
      });
      // Core contract validation
      BaseStrategy.validateResult(result.toEvolutionResult());
    });
  });

  // ─── toEvolutionResult (interoperability) ─────────────────────────────

  describe('toEvolutionResult()', () => {
    it('returns plain object with EvolutionResult shape', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, {
        method: 'solution-properties',
      });
      const plain = result.toEvolutionResult();
      assert.equal(typeof plain.evolution, 'number');
      assert.equal(typeof plain.confidence, 'number');
      assert.equal(typeof plain.method, 'string');
      assert.ok(Array.isArray(plain.trace));
      assert.ok(Array.isArray(plain.properties));
    });

    it('properties are plain PropertyEvaluation objects', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      const plain = result.toEvolutionResult();
      for (const p of plain.properties) {
        assert.ok(!(p instanceof PropertyScore), 'Should be plain object, not PropertyScore');
        assert.ok('property' in p);
        assert.ok('phase' in p);
        assert.ok('label' in p);
        assert.ok('weight' in p);
      }
    });

    it('passes BaseStrategy.validateResult()', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      // Should not throw
      BaseStrategy.validateResult(result.toEvolutionResult());
    });

    it('passes SolutionBaseStrategy.validateSolutionResult()', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      // Should not throw
      SolutionBaseStrategy.validateSolutionResult(result.toEvolutionResult());
    });
  });

  // ─── toJSON ───────────────────────────────────────────────────────────

  describe('toJSON()', () => {
    it('includes all top-level fields', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, {
        method: 'solution-properties',
        mode: 'auto',
      });
      const json = result.toJSON();
      assert.equal(json.evolution, 0.55);
      assert.ok(json.confidence > 0);
      assert.equal(json.method, 'solution-properties');
      assert.equal(json.stage, 'Product');
      assert.equal(json.meanPhase, 3);
      assert.deepEqual(json.phaseDistribution, { 1: 0, 2: 0, 3: 12, 4: 0 });
      assert.ok(Array.isArray(json.trace));
      assert.ok(Array.isArray(json.properties));
      assert.equal(json.properties.length, 12);
      assert.ok(json.confidenceMetadata != null);
    });

    it('property JSON includes id, property, phase, label, weight, evolution', () => {
      const scores = [PropertyScore.create('market', 'Market', 3, 'Test')];
      const result = new SolutionEvolutionResult({
        evolution: 0.55,
        confidence: 0.85,
        method: 'test',
        properties: scores,
      });
      const json = result.toJSON();
      const p = json.properties[0];
      assert.equal(p.id, 'market');
      assert.equal(p.property, 'Market');
      assert.equal(p.phase, 3);
      assert.equal(p.label, 'Product');
      assert.equal(p.evolution, 0.55);
      assert.equal(p.reason, 'Test');
    });

    it('is JSON.stringify safe', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      const jsonStr = JSON.stringify(result);
      const parsed = JSON.parse(jsonStr);
      assert.equal(parsed.evolution, 0.55);
      assert.equal(parsed.properties.length, 12);
    });
  });

  // ─── toString ─────────────────────────────────────────────────────────

  describe('toString()', () => {
    it('produces a readable summary', () => {
      const scores = build12Scores(3);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      const str = result.toString();
      assert.ok(str.includes('SolutionEvolutionResult'));
      assert.ok(str.includes('0.55'));
      assert.ok(str.includes('Product'));
      assert.ok(str.includes('Market'));
    });

    it('handles empty properties', () => {
      const result = new SolutionEvolutionResult({
        evolution: 0.5,
        confidence: 0.8,
        method: 'test',
      });
      const str = result.toString();
      assert.ok(str.includes('no property evaluations'));
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('all phase 1 (Genesis)', () => {
      const scores = build12Scores(1);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      assert.equal(result.evolution, 0.09);
      assert.equal(result.stage, 'Genesis');
    });

    it('all phase 4 (Commodity)', () => {
      const scores = build12Scores(4);
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      assert.equal(result.evolution, 0.85);
      assert.equal(result.stage, 'Commodity');
    });

    it('single property score', () => {
      const scores = [PropertyScore.create('market', 'Market', 3, 'Only market')];
      const result = SolutionEvolutionResult.fromPropertyScores(scores, { method: 'test' });
      assert.equal(result.evolution, 0.55);
      assert.equal(result.propertyCount, 1);
    });

    it('evolution at boundary 0', () => {
      const result = new SolutionEvolutionResult({
        evolution: 0,
        confidence: 0.5,
        method: 'test',
      });
      assert.equal(result.evolution, 0);
      assert.equal(result.stage, 'Genesis');
    });

    it('evolution at boundary 1', () => {
      const result = new SolutionEvolutionResult({
        evolution: 1,
        confidence: 0.5,
        method: 'test',
      });
      assert.equal(result.evolution, 1);
      assert.equal(result.stage, 'Commodity');
    });
  });
});
