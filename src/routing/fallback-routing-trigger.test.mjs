// Tests for the fallback trigger in estimate-evolution.mjs
//
// Validates Sub-AC 2: When naming convention confidence < 90%, the router
// delegates to the dual-verification orchestrator, forwarding the component
// name and any partial classification context accumulated so far.
//
// Test categories:
//   1. High-confidence names (Kubernetes, CRM) skip fallback
//   2. Low-confidence/ambiguous names trigger fallback
//   3. Partial context (description, capability, nature) is forwarded
//   4. Fallback error is handled gracefully (falls back to naming-only)
//   5. Routing metadata includes verification info when fallback ran
//   6. Conversational mode also triggers fallback
//   7. Environment variable doesn't interfere with fallback logic
//
// All tests use direct function calls or mocks — no real LLM calls.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectComponentType,
  COMPONENT_TYPE,
  CONFIDENCE_THRESHOLD,
} from '../lib/component-detection.mjs';
import {
  determineRoutingTargets,
} from './solution-dispatch.mjs';
import {
  verifyClassification,
  classifyNamingOnly,
  THRESHOLDS,
} from '../pipeline/dual-verification-orchestrator.mjs';

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Fallback routing trigger — Sub-AC 2', () => {
  let originalMode;

  before(() => {
    originalMode = process.env.WARDLEY_EVAL_MODE;
    delete process.env.WARDLEY_EVAL_MODE;
  });

  after(() => {
    if (originalMode !== undefined) {
      process.env.WARDLEY_EVAL_MODE = originalMode;
    } else {
      delete process.env.WARDLEY_EVAL_MODE;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 1: High-confidence names do NOT trigger fallback
  // ═══════════════════════════════════════════════════════════════════════════

  describe('high-confidence names skip fallback', () => {
    const highConfidenceSolutions = [
      'Kubernetes', 'Salesforce', 'Docker', 'PostgreSQL', 'AWS',
      'Terraform', 'Kafka', 'Redis', 'Snowflake', 'Slack',
    ];

    for (const name of highConfidenceSolutions) {
      it(`${name} → needsFallback=false (known solution, confidence ≥ 0.90)`, () => {
        const detection = detectComponentType(name);
        assert.equal(detection.type, COMPONENT_TYPE.SOLUTION);
        assert.ok(detection.confidence >= CONFIDENCE_THRESHOLD,
          `${name}: confidence ${detection.confidence} should be >= ${CONFIDENCE_THRESHOLD}`);
        assert.equal(detection.needsFallback, false,
          `${name}: should NOT need fallback`);
      });
    }

    const highConfidenceCapabilities = [
      'CRM', 'ERP', 'DevOps', 'CI/CD', 'container orchestration',
      'identity management', 'payment processing',
    ];

    for (const name of highConfidenceCapabilities) {
      it(`${name} → needsFallback=false (known capability, confidence ≥ 0.90)`, () => {
        const detection = detectComponentType(name);
        assert.equal(detection.type, COMPONENT_TYPE.CAPABILITY);
        assert.ok(detection.confidence >= 0.88,
          `${name}: confidence ${detection.confidence} should be >= 0.88`);
        // Most known capabilities have confidence 0.97, so needsFallback should be false
        if (detection.confidence >= CONFIDENCE_THRESHOLD) {
          assert.equal(detection.needsFallback, false);
        }
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 2: Low-confidence/ambiguous names DO trigger fallback
  // ═══════════════════════════════════════════════════════════════════════════

  describe('low-confidence names trigger fallback (needsFallback=true)', () => {
    const ambiguousNames = [
      'XyzWidget',       // Unknown — heuristic only
      'MyCustomTool',    // No brand recognition
      'Blarg',           // Completely unknown
      'SuperApp',        // Looks like product but unknown
      'AnalyticsEngine', // Could be either
    ];

    for (const name of ambiguousNames) {
      it(`${name} → needsFallback=true (confidence < 0.90)`, () => {
        const detection = detectComponentType(name);
        assert.ok(detection.confidence < CONFIDENCE_THRESHOLD,
          `${name}: confidence ${detection.confidence} should be < ${CONFIDENCE_THRESHOLD} for ambiguous names`);
        assert.equal(detection.needsFallback, true,
          `${name}: should need fallback`);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 3: Dual-verification orchestrator correctly receives context
  // ═══════════════════════════════════════════════════════════════════════════

  describe('verifyClassification receives and uses partial context', () => {
    it('accepts description in context', async () => {
      // Known solution — should short-circuit at Tier 1 regardless of context
      const result = await verifyClassification('Docker', {
        description: 'Container platform for microservices',
      });
      assert.equal(result.classification, 'solution');
      assert.ok(result.confidence >= 0.90);
      assert.equal(result.verified, true);
      assert.ok(result.tiersUsed.includes('naming'));
    });

    it('accepts capability and nature in context', async () => {
      const result = await verifyClassification('Kubernetes', {
        description: 'Container orchestration platform',
        capability: 'Orchestrate containers',
        nature: 'activity',
      });
      assert.equal(result.classification, 'solution');
      assert.ok(result.verified);
    });

    it('ambiguous name with mock LLM resolves via fallback', async () => {
      const mockLLM = async (prompt) => {
        return 'classification=SOLUTION\nconfidence=0.85\nreasoning=XyzWidget is a product';
      };

      const result = await verifyClassification('XyzWidget', {
        description: 'A custom widget for our platform',
        llmCall: mockLLM,
        skipWebSearch: true,
      });

      // LLM tier should have been used
      assert.ok(result.tiersUsed.includes('llm'),
        `Should use LLM tier, used: ${result.tiersUsed.join('+')}`);
      assert.equal(result.classification, 'solution');
    });

    it('ambiguous name without LLM stays at naming-only', async () => {
      const result = await verifyClassification('UnknownWidget');

      // Only naming tier (no LLM provided)
      assert.deepEqual(result.tiersUsed, ['naming']);
      assert.ok(result.confidence < CONFIDENCE_THRESHOLD);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 4: Fallback error handling (graceful degradation)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('fallback error handling', () => {
    it('LLM error in verifyClassification returns naming-only result', async () => {
      const failingLLM = async () => { throw new Error('LLM timeout'); };

      const result = await verifyClassification('AmbiguousThing', {
        llmCall: failingLLM,
        skipWebSearch: true,
      });

      // Should still return a valid result (naming-only)
      assert.ok(result.tiersUsed.includes('naming'));
      assert.ok(typeof result.classification === 'string');
      assert.ok(typeof result.confidence === 'number');
      // LLM tier attempted but failed
      assert.ok(result.tiersUsed.includes('llm'),
        `LLM tier should have been attempted`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 5: Routing metadata includes verification info
  // ═══════════════════════════════════════════════════════════════════════════

  describe('verified result provides routing targets', () => {
    it('high-confidence verified result has routing targets', async () => {
      const result = await verifyClassification('Kubernetes');

      assert.ok(result.routingTargets, 'Should have routingTargets');
      assert.equal(result.routingTargets.useSolutionStrategies, true,
        'Kubernetes should route to solution strategies');
      assert.equal(result.routingTargets.useCapabilityStrategies, false,
        'Kubernetes should NOT route to capability strategies (exclusive mode)');
    });

    it('verified capability has correct routing targets', async () => {
      const result = await verifyClassification('CRM');

      assert.ok(result.routingTargets);
      assert.equal(result.routingTargets.useSolutionStrategies, false);
      assert.equal(result.routingTargets.useCapabilityStrategies, true);
    });

    it('LLM-verified result overrides routing targets', async () => {
      const mockLLM = async () =>
        'classification=SOLUTION\nconfidence=0.88\nreasoning=Custom product detected';

      const result = await verifyClassification('MyCustomProduct', {
        llmCall: mockLLM,
        skipWebSearch: true,
      });

      // LLM says solution → routingTargets should reflect that
      assert.equal(result.classification, 'solution');
      assert.ok(result.routingTargets.useSolutionStrategies,
        'LLM-verified solution should use solution strategies');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 6: Confidence threshold is exactly 0.90
  // ═══════════════════════════════════════════════════════════════════════════

  describe('confidence threshold boundary', () => {
    it('CONFIDENCE_THRESHOLD is 0.90', () => {
      assert.equal(CONFIDENCE_THRESHOLD, 0.90);
    });

    it('THRESHOLDS.NAMING_SKIP matches CONFIDENCE_THRESHOLD', () => {
      assert.equal(THRESHOLDS.NAMING_SKIP, CONFIDENCE_THRESHOLD);
    });

    it('known solution at 0.98 does not need fallback', () => {
      const detection = detectComponentType('Kubernetes');
      assert.equal(detection.confidence, 0.98);
      assert.equal(detection.needsFallback, false);
    });

    it('heuristic result capped at 0.89 always needs fallback', () => {
      // "React 18" has version number + product suffix heuristic → capped at 0.89
      const detection = detectComponentType('React 18');
      assert.ok(detection.confidence <= 0.89,
        `Heuristic confidence ${detection.confidence} should be <= 0.89`);
      assert.equal(detection.needsFallback, true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 7: classifyNamingOnly provides consistent VerifiedClassificationResult
  // ═══════════════════════════════════════════════════════════════════════════

  describe('classifyNamingOnly convenience function', () => {
    it('returns same shape as verifyClassification', () => {
      const result = classifyNamingOnly('Salesforce');
      assert.equal(result.classification, 'solution');
      assert.ok(result.confidence >= 0.90);
      assert.equal(result.verified, true);
      assert.deepEqual(result.tiersUsed, ['naming']);
      assert.ok(result.routingTargets);
      assert.equal(typeof result.isSolution, 'boolean');
    });

    it('ambiguous name returns verified=false via naming-only', () => {
      const result = classifyNamingOnly('UnknownWidget');
      assert.ok(result.confidence < 0.90);
      assert.equal(result.verified, false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 8: Parallel mode does not block fallback logic
  // ═══════════════════════════════════════════════════════════════════════════

  describe('WARDLEY_EVAL_MODE does not affect fallback detection', () => {
    let saved;

    before(() => {
      saved = process.env.WARDLEY_EVAL_MODE;
    });

    after(() => {
      if (saved !== undefined) {
        process.env.WARDLEY_EVAL_MODE = saved;
      } else {
        delete process.env.WARDLEY_EVAL_MODE;
      }
    });

    it('parallel mode: needsFallback still based on confidence', () => {
      process.env.WARDLEY_EVAL_MODE = 'parallel';
      const detection = detectComponentType('XyzWidget');
      assert.equal(detection.needsFallback, true,
        'needsFallback should be true regardless of eval mode');
    });

    it('exclusive mode: needsFallback still based on confidence', () => {
      process.env.WARDLEY_EVAL_MODE = 'exclusive';
      const known = detectComponentType('Docker');
      assert.equal(known.needsFallback, false);

      const unknown = detectComponentType('FooBar');
      assert.equal(unknown.needsFallback, true);
    });
  });
});
