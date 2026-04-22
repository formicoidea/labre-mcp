// Tests for SolutionBaseStrategy
//
// Verifies:
//   1. EvolutionResult contract compatibility with capability strategies
//   2. Abstract method enforcement
//   3. Phase ↔ evolution mapping
//   4. Property aggregation with equal weights
//   5. Subclass pattern works (auto-discovery compatible)
//   6. validateSolutionResult validates both core + extensions

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SolutionBaseStrategy, PHASE_TO_EVOLUTION, PHASE_LABELS } from './solution-base-strategy.mjs';
import { BaseStrategy } from '../capacity/base-strategy.mjs';

// ─── Contract Compatibility ────────────────────────────────────────────────────

describe('SolutionBaseStrategy', () => {

  describe('inheritance', () => {
    it('extends BaseStrategy', () => {
      assert.ok(SolutionBaseStrategy.prototype instanceof BaseStrategy);
    });

    it('instances are recognized as BaseStrategy subclasses', () => {
      class TestStrategy extends SolutionBaseStrategy {
        static get method() { return 'test-solution'; }
        async evaluate() { return { evolution: 0.5, confidence: 0.8, method: 'test-solution' }; }
      }
      const instance = new TestStrategy();
      assert.ok(instance instanceof BaseStrategy);
      assert.ok(instance instanceof SolutionBaseStrategy);
    });
  });

  describe('abstract method enforcement', () => {
    it('static method getter throws if not overridden', () => {
      assert.throws(
        () => SolutionBaseStrategy.method,
        /must be overridden/
      );
    });

    it('evaluate() throws if not implemented', async () => {
      // Create a minimal subclass that only overrides method
      class IncompleteStrategy extends SolutionBaseStrategy {
        static get method() { return 'incomplete'; }
      }
      const instance = new IncompleteStrategy();
      await assert.rejects(
        () => instance.evaluate({ name: 'Test' }),
        /must be implemented/
      );
    });
  });

  // ─── EvolutionResult Contract ────────────────────────────────────────────

  describe('EvolutionResult contract', () => {
    it('validates a correct result via BaseStrategy.validateResult', () => {
      const result = {
        evolution: 0.55,
        confidence: 0.85,
        method: 'write:solution:properties',
      };
      const validated = BaseStrategy.validateResult(result);
      assert.equal(validated.evolution, 0.55);
      assert.equal(validated.confidence, 0.85);
      assert.equal(validated.method, 'write:solution:properties');
    });

    it('rejects missing evolution', () => {
      assert.throws(
        () => BaseStrategy.validateResult({ confidence: 0.8, method: 'x' }),
        /evolution must be a number/
      );
    });

    it('rejects confidence out of range', () => {
      assert.throws(
        () => BaseStrategy.validateResult({ evolution: 0.5, confidence: 1.5, method: 'x' }),
        /confidence must be a number in \[0, 1\]/
      );
    });

    it('rejects empty method', () => {
      assert.throws(
        () => BaseStrategy.validateResult({ evolution: 0.5, confidence: 0.8, method: '' }),
        /method must be a non-empty string/
      );
    });

    it('a subclass evaluate() result passes BaseStrategy.validateResult', async () => {
      class ValidStrategy extends SolutionBaseStrategy {
        static get method() { return 'valid-solution'; }
        async evaluate(component) {
          return SolutionBaseStrategy.validateSolutionResult({
            evolution: 0.55,
            confidence: 0.85,
            method: ValidStrategy.method,
            properties: [
              { property: 'Market', phase: 3, label: 'Product', weight: 1/12 },
            ],
          });
        }
      }
      const instance = new ValidStrategy();
      const result = await instance.evaluate({ name: 'Kubernetes' });

      // Core contract passes
      const validated = BaseStrategy.validateResult(result);
      assert.equal(validated.evolution, 0.55);
      assert.equal(validated.confidence, 0.85);
      assert.equal(validated.method, 'valid-solution');
    });
  });

  // ─── Phase ↔ Evolution Mapping ──────────────────────────────────────────

  describe('phaseToEvolution', () => {
    it('maps phase 1 (Genesis) to 0.09', () => {
      assert.equal(SolutionBaseStrategy.phaseToEvolution(1), 0.09);
    });

    it('maps phase 2 (Custom) to 0.29', () => {
      assert.equal(SolutionBaseStrategy.phaseToEvolution(2), 0.29);
    });

    it('maps phase 3 (Product) to 0.55', () => {
      assert.equal(SolutionBaseStrategy.phaseToEvolution(3), 0.55);
    });

    it('maps phase 4 (Commodity) to 0.85', () => {
      assert.equal(SolutionBaseStrategy.phaseToEvolution(4), 0.85);
    });

    it('throws for phase < 1', () => {
      assert.throws(
        () => SolutionBaseStrategy.phaseToEvolution(0),
        /Phase must be between 1 and 4/
      );
    });

    it('throws for phase > 4', () => {
      assert.throws(
        () => SolutionBaseStrategy.phaseToEvolution(5),
        /Phase must be between 1 and 4/
      );
    });

    it('rounds fractional phases', () => {
      // 2.7 rounds to 3 → Product
      assert.equal(SolutionBaseStrategy.phaseToEvolution(2.7), 0.55);
    });
  });

  describe('phaseLabel', () => {
    it('returns correct labels', () => {
      assert.equal(SolutionBaseStrategy.phaseLabel(1), 'Genesis');
      assert.equal(SolutionBaseStrategy.phaseLabel(2), 'Custom');
      assert.equal(SolutionBaseStrategy.phaseLabel(3), 'Product');
      assert.equal(SolutionBaseStrategy.phaseLabel(4), 'Commodity');
    });

    it('returns Unknown for invalid phases', () => {
      assert.equal(SolutionBaseStrategy.phaseLabel(0), 'Unknown');
      assert.equal(SolutionBaseStrategy.phaseLabel(5), 'Unknown');
    });
  });

  // ─── Property Aggregation ───────────────────────────────────────────────

  describe('aggregateProperties', () => {
    it('aggregates 12 properties with equal weights', () => {
      // All properties at phase 3 (Product) → evolution = 0.55
      const properties = Array.from({ length: 12 }, (_, i) => ({
        property: `Property${i}`,
        phase: 3,
        label: 'Product',
        weight: 1/12,
      }));
      const { evolution, confidence } = SolutionBaseStrategy.aggregateProperties(properties);
      assert.equal(evolution, 0.55);
      assert.equal(confidence, 0.85);  // Full coverage
    });

    it('aggregates mixed phases correctly', () => {
      // 6 at phase 2, 6 at phase 4
      const properties = [
        ...Array.from({ length: 6 }, () => ({ property: 'A', phase: 2, label: 'Custom', weight: 1/12 })),
        ...Array.from({ length: 6 }, () => ({ property: 'B', phase: 4, label: 'Commodity', weight: 1/12 })),
      ];
      const { evolution } = SolutionBaseStrategy.aggregateProperties(properties);
      // Expected: (6 * 0.29 + 6 * 0.85) / 12 = (1.74 + 5.10) / 12 = 0.57
      assert.equal(evolution, 0.57);
    });

    it('handles single property', () => {
      const properties = [{ property: 'Market', phase: 1, label: 'Genesis', weight: 1 }];
      const { evolution } = SolutionBaseStrategy.aggregateProperties(properties);
      assert.equal(evolution, 0.09);
    });

    it('throws on empty array', () => {
      assert.throws(
        () => SolutionBaseStrategy.aggregateProperties([]),
        /non-empty array/
      );
    });

    it('throws when no valid phases', () => {
      assert.throws(
        () => SolutionBaseStrategy.aggregateProperties([{ property: 'X', phase: 0 }]),
        /No valid property evaluations/
      );
    });

    it('reduces confidence for partial coverage', () => {
      // 6 valid out of 12 total
      const properties = [
        ...Array.from({ length: 6 }, () => ({ property: 'A', phase: 3, label: 'Product', weight: 1/12 })),
        ...Array.from({ length: 6 }, () => ({ property: 'B', phase: NaN, label: '?', weight: 1/12 })),
      ];
      const { confidence } = SolutionBaseStrategy.aggregateProperties(properties);
      // 50% coverage → 0.85 * 0.5 = 0.425
      assert.ok(confidence < 0.85, `Expected confidence < 0.85, got ${confidence}`);
      assert.ok(confidence > 0, `Expected confidence > 0, got ${confidence}`);
    });
  });

  // ─── buildPropertyEvaluation ────────────────────────────────────────────

  describe('buildPropertyEvaluation', () => {
    it('builds correct evaluation entry', () => {
      const entry = SolutionBaseStrategy.buildPropertyEvaluation('Market', 3, 'Mature market');
      assert.deepEqual(entry, {
        property: 'Market',
        phase: 3,
        label: 'Product',
        weight: 1/12,
        reason: 'Mature market',
      });
    });

    it('clamps phase to [1, 4]', () => {
      const low = SolutionBaseStrategy.buildPropertyEvaluation('X', 0);
      assert.equal(low.phase, 1);
      const high = SolutionBaseStrategy.buildPropertyEvaluation('Y', 6);
      assert.equal(high.phase, 4);
    });

    it('omits reason when not provided', () => {
      const entry = SolutionBaseStrategy.buildPropertyEvaluation('Market', 2);
      assert.ok(!('reason' in entry));
    });

    it('weight defaults to 1/12', () => {
      const entry = SolutionBaseStrategy.buildPropertyEvaluation('Knowledge', 1);
      assert.ok(Math.abs(entry.weight - 1/12) < 0.0001);
    });
  });

  // ─── validateSolutionResult ─────────────────────────────────────────────

  describe('validateSolutionResult', () => {
    it('validates core + solution extensions', () => {
      const result = {
        evolution: 0.55,
        confidence: 0.85,
        method: 'write:solution:properties',
        properties: [
          { property: 'Market', phase: 3, label: 'Product', weight: 1/12 },
          { property: 'Knowledge', phase: 2, label: 'Custom', weight: 1/12 },
        ],
      };
      const validated = SolutionBaseStrategy.validateSolutionResult(result);
      assert.equal(validated.evolution, 0.55);
      assert.equal(validated.properties.length, 2);
    });

    it('passes when properties is absent (optional)', () => {
      const result = {
        evolution: 0.55,
        confidence: 0.85,
        method: 'simple-solution',
      };
      // Should not throw
      SolutionBaseStrategy.validateSolutionResult(result);
    });

    it('rejects non-array properties', () => {
      assert.throws(
        () => SolutionBaseStrategy.validateSolutionResult({
          evolution: 0.5, confidence: 0.8, method: 'x',
          properties: 'not-an-array',
        }),
        /properties must be an array/
      );
    });

    it('rejects property with empty name', () => {
      assert.throws(
        () => SolutionBaseStrategy.validateSolutionResult({
          evolution: 0.5, confidence: 0.8, method: 'x',
          properties: [{ property: '', phase: 2, label: 'Custom', weight: 1/12 }],
        }),
        /non-empty property name/
      );
    });

    it('rejects property with phase out of range', () => {
      assert.throws(
        () => SolutionBaseStrategy.validateSolutionResult({
          evolution: 0.5, confidence: 0.8, method: 'x',
          properties: [{ property: 'Market', phase: 5, label: '?', weight: 1/12 }],
        }),
        /phase must be 1–4/
      );
    });

    it('also enforces core EvolutionResult contract', () => {
      assert.throws(
        () => SolutionBaseStrategy.validateSolutionResult({
          evolution: 'bad', confidence: 0.8, method: 'x',
        }),
        /evolution must be a number/
      );
    });
  });

  // ─── Subclass Pattern (auto-discovery compatible) ───────────────────────

  describe('subclass pattern', () => {
    it('concrete subclass can be instantiated and evaluated', async () => {
      class MockSolutionStrategy extends SolutionBaseStrategy {
        static get method() { return 'mock-solution'; }

        async evaluate(component) {
          const properties = [
            SolutionBaseStrategy.buildPropertyEvaluation('Market', 3, `${component.name} has mature market`),
            SolutionBaseStrategy.buildPropertyEvaluation('Knowledge', 2),
          ];
          const { evolution, confidence } = SolutionBaseStrategy.aggregateProperties(properties);
          return SolutionBaseStrategy.validateSolutionResult({
            evolution,
            confidence,
            method: MockSolutionStrategy.method,
            properties,
          });
        }
      }

      const instance = new MockSolutionStrategy();
      const result = await instance.evaluate({ name: 'Kubernetes' });

      // Contract checks
      assert.equal(typeof result.evolution, 'number');
      assert.ok(result.evolution >= 0 && result.evolution <= 1);
      assert.equal(typeof result.confidence, 'number');
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
      assert.equal(result.method, 'mock-solution');
      assert.equal(result.properties.length, 2);

      // Also passes BaseStrategy validation
      BaseStrategy.validateResult(result);
    });

    it('isPrototypeOf check works for registry discovery', () => {
      class DiscoverableStrategy extends SolutionBaseStrategy {
        static get method() { return 'discoverable'; }
        async evaluate() { return { evolution: 0.5, confidence: 0.8, method: 'discoverable' }; }
      }

      // Registry uses: Cls.prototype instanceof BaseStrategy
      assert.ok(DiscoverableStrategy.prototype instanceof BaseStrategy);
      assert.ok(DiscoverableStrategy.prototype instanceof SolutionBaseStrategy);
    });
  });

  // ─── Exported Constants ─────────────────────────────────────────────────

  describe('exported constants', () => {
    it('PHASE_TO_EVOLUTION has 4 entries', () => {
      assert.equal(Object.keys(PHASE_TO_EVOLUTION).length, 4);
    });

    it('PHASE_LABELS has 4 entries', () => {
      assert.equal(Object.keys(PHASE_LABELS).length, 4);
    });

    it('all phases in PHASE_TO_EVOLUTION are within [0, 1]', () => {
      for (const [phase, evo] of Object.entries(PHASE_TO_EVOLUTION)) {
        assert.ok(evo >= 0 && evo <= 1, `Phase ${phase} evolution ${evo} not in [0, 1]`);
      }
    });
  });
});
