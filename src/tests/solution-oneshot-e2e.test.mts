// End-to-end test: Auto (oneshot) mode correctly routes and evaluates solutions
//
// Sub-AC 1 validation:
//   When classification detects a solution input, the oneshot/auto path
//   invokes solution-strategies and returns a complete evolution result
//   in a single call.
//
// Test architecture (optimized for speed):
//   Part 1: FAST — Pure routing detection, no LLM (instant)
//   Part 2: FAST — Mock LLM dispatch (instant, validates strategy contract)
//   Part 3: FAST — Capability s-curve integration (analytical, no LLM)
//   Part 4: INTEGRATION — Single real LLM call for one solution (validates E2E)
//   Part 5: FAST — Non-economic short-circuits (no LLM)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { estimateEvolutionOneShot } from '#work-on-evolution/write/estimate-evolution.mjs';
import {
  detectComponentType,
  COMPONENT_TYPE,
} from '../lib/component-detection.mjs';
import {
  determineRoutingTargets,
  dispatchSolutionStrategies,
  EVAL_MODES,
} from '#work-on-evolution/write/routing/solution-dispatch.mjs';

// ─── Test Suite ───────────────────────────────────────────────────────────

describe('Solution oneshot E2E — Sub-AC 1', () => {
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

  // ══════════════════════════════════════════════════════════════════════════
  // Part 1: FAST — Routing detection (no LLM, < 1ms each)
  // ══════════════════════════════════════════════════════════════════════════

  describe('routing detection — solutions correctly identified', () => {
    const knownSolutions = [
      'Kubernetes', 'Docker', 'Salesforce', 'SAP ERP', 'AWS', 'Azure', 'GCP',
      'PostgreSQL', 'MongoDB', 'Kafka', 'Terraform', 'Slack', 'Jira',
      'Stripe', 'Snowflake', 'Redis', 'Jenkins', 'GitLab', 'Shopify',
      'Datadog', 'Grafana', 'Prometheus',
    ];

    for (const name of knownSolutions) {
      it(`${name} → solution with ≥90% confidence`, () => {
        const detection = detectComponentType(name);
        assert.equal(detection.type, COMPONENT_TYPE.SOLUTION);
        assert.ok(detection.confidence >= 0.90);
        assert.equal(detection.needsFallback, false);
      });
    }
  });

  describe('routing detection — capabilities correctly identified', () => {
    const knownCapabilities = [
      'CRM', 'ERP', 'DevOps', 'CI/CD',
      'container orchestration', 'identity management',
      'payment processing', 'data analytics', 'monitoring',
      'authentication', 'load balancing', 'event streaming',
    ];

    for (const name of knownCapabilities) {
      it(`${name} → capability with ≥85% confidence`, () => {
        const detection = detectComponentType(name);
        assert.equal(detection.type, COMPONENT_TYPE.CAPABILITY);
        assert.ok(detection.confidence >= 0.85);
      });
    }
  });

  describe('exclusive routing targets', () => {
    it('solution → useSolutionStrategies=true, useCapabilityStrategies=false', () => {
      delete process.env.WARDLEY_EVAL_MODE;
      const detection = detectComponentType('Kubernetes');
      const targets = determineRoutingTargets(detection);
      assert.equal(targets.useSolutionStrategies, true);
      assert.equal(targets.useCapabilityStrategies, false);
      assert.equal(targets.mode, EVAL_MODES.EXCLUSIVE);
    });

    it('capability → useSolutionStrategies=false, useCapabilityStrategies=true', () => {
      delete process.env.WARDLEY_EVAL_MODE;
      const detection = detectComponentType('CRM');
      const targets = determineRoutingTargets(detection);
      assert.equal(targets.useSolutionStrategies, false);
      assert.equal(targets.useCapabilityStrategies, true);
      assert.equal(targets.mode, EVAL_MODES.EXCLUSIVE);
    });

    it('parallel mode → both strategy sets activated', () => {
      process.env.WARDLEY_EVAL_MODE = 'parallel';
      const detection = detectComponentType('Kubernetes');
      const targets = determineRoutingTargets(detection);
      assert.equal(targets.useSolutionStrategies, true);
      assert.equal(targets.useCapabilityStrategies, true);
      assert.equal(targets.mode, EVAL_MODES.PARALLEL);
      delete process.env.WARDLEY_EVAL_MODE;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 2: FAST — Mock LLM dispatch (validates strategy contract)
  // ══════════════════════════════════════════════════════════════════════════

  describe('solution strategy dispatch with mock LLM', () => {
    const mockLlm = async () => [
      'Market=3|Established market',
      'Knowledge management=3|Widely documented',
      'Market perception=3|Mainstream acceptance',
      'User perception=3|Expected reliability',
      'Industry perception=3|Strategic necessity',
      'Value focus=3|TCO and reliability',
      'Understanding=3|Well understood',
      'Comparison=3|Feature comparison standard',
      'Failure/deficiency=3|Low tolerance',
      'Market action/engagement=3|Product marketing',
      'Efficiency=3|Good efficiency',
      'Decision driver=3|Analysis driven',
    ].join('\n');

    it('dispatches to solution-properties and returns valid EvolutionResult', async () => {
      const evaluations = await dispatchSolutionStrategies(
        { name: 'Kubernetes', description: 'Container orchestration platform' },
        { llmCall: mockLlm, strategy: 'all', mode: 'auto' }
      );

      const methods = Object.keys(evaluations);
      assert.ok(methods.includes('write:solution:properties'));

      const result = evaluations['write:solution:properties'];
      assert.ok(!result.error);

      // EvolutionResult contract
      assert.equal(typeof result.evolution, 'number');
      assert.ok(result.evolution >= 0 && result.evolution <= 1);
      assert.equal(typeof result.confidence, 'number');
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
      assert.equal(result.method, 'write:solution:properties');

      // Solution-specific: 12 properties
      assert.ok(Array.isArray(result.properties));
      assert.equal(result.properties.length, 12);
    });

    it('phase 3 → evolution near Product midpoint (0.55)', async () => {
      const evals = await dispatchSolutionStrategies(
        { name: 'Kubernetes' }, { llmCall: mockLlm, strategy: 'all' }
      );
      const result = evals['write:solution:properties'];
      assert.ok(result.evolution >= 0.45 && result.evolution <= 0.65,
        `Expected ~0.55, got ${result.evolution}`);
    });

    it('phase 4 → evolution near Commodity midpoint (0.85)', async () => {
      const mockLlm4 = async () => [
        'Market=4|Commodity', 'Knowledge management=4|Ubiquitous',
        'Market perception=4|Utility', 'User perception=4|Expected',
        'Industry perception=4|Essential', 'Value focus=4|Cost',
        'Understanding=4|Fully understood', 'Comparison=4|Trivial',
        'Failure/deficiency=4|Unacceptable', 'Market action/engagement=4|Volume',
        'Efficiency=4|Maximum', 'Decision driver=4|Price',
      ].join('\n');

      const evals = await dispatchSolutionStrategies(
        { name: 'TCP/IP' }, { llmCall: mockLlm4, strategy: 'all' }
      );
      assert.ok(evals['write:solution:properties'].evolution >= 0.75);
    });

    it('each property weight is 1/12', async () => {
      const evals = await dispatchSolutionStrategies(
        { name: 'Kubernetes' }, { llmCall: mockLlm, strategy: 'all' }
      );
      const expected = 1 / 12;
      for (const prop of evals['write:solution:properties'].properties) {
        assert.ok(Math.abs(prop.weight - expected) < 0.001,
          `${prop.property}: ${prop.weight} ≠ ~${expected}`);
      }
    });

    it('all 12 properties present in result', async () => {
      const evals = await dispatchSolutionStrategies(
        { name: 'Kubernetes' }, { llmCall: mockLlm, strategy: 'all' }
      );
      const names = evals['write:solution:properties'].properties.map(p => p.property);
      const expected = [
        'Market', 'Knowledge management', 'Market perception',
        'User perception', 'Industry perception', 'Value focus',
        'Understanding', 'Comparison', 'Failure/deficiency',
        'Market action/engagement', 'Efficiency', 'Decision driver',
      ];
      for (const e of expected) {
        assert.ok(names.includes(e), `Missing property: ${e}`);
      }
    });

    it('auto mode evaluates all 12 properties in single LLM call', async () => {
      let callCount = 0;
      const countingLlm = async () => { callCount++; return mockLlm(); };

      await dispatchSolutionStrategies(
        { name: 'K8s' }, { llmCall: countingLlm, strategy: 'all', mode: 'auto' }
      );
      assert.equal(callCount, 1, `Auto mode: expected 1 LLM call, got ${callCount}`);
    });

    it('handles LLM errors gracefully (no crash)', async () => {
      const errorLlm = async () => { throw new Error('LLM unavailable'); };
      const evals = await dispatchSolutionStrategies(
        { name: 'K8s' }, { llmCall: errorLlm, strategy: 'all' }
      );
      assert.ok(evals['write:solution:properties']?.error, 'should have error entry');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 3: FAST — Capability s-curve integration (no LLM needed)
  // ══════════════════════════════════════════════════════════════════════════

  describe('estimateEvolutionOneShot — capability routing (s-curve)', { timeout: 120_000 }, () => {
    it('CRM routes to capability strategies with s-curve result', async () => {
      const result = await estimateEvolutionOneShot({
        name: 'CRM',
        description: 'Customer relationship management',
        space: 'economic',
        strategy: 'write:capacity:s-curve',
        certitude: 0.85,
        ubiquity: 0.8,
      });

      assert.equal(result.mode, 'oneshot');
      assert.equal(result.classification.space, 'economic');
      assert.equal(result.reQuestions, null);
      assert.ok(result.routing);
      assert.equal(result.routing.type, COMPONENT_TYPE.CAPABILITY);
      assert.equal(result.routing.usedCapabilityStrategies, true);
      assert.equal(result.routing.usedSolutionStrategies, false);
      assert.equal(result.routing.evalMode, 'exclusive');
      assert.ok(result.evaluations['write:capacity:s-curve']);
      assert.equal(typeof result.evaluations['write:capacity:s-curve'].evolution, 'number');
      assert.equal(typeof result.evaluations['write:capacity:s-curve'].confidence, 'number');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 4: INTEGRATION — Single real LLM call validates full E2E pipeline
  //          (This is the one test that proves the WHOLE pipeline works)
  // ══════════════════════════════════════════════════════════════════════════

  describe('estimateEvolutionOneShot — solution E2E (real LLM)', { timeout: 120_000 }, () => {
    it('Kubernetes: detected → routed → evaluated → complete result in single call', async () => {
      delete process.env.WARDLEY_EVAL_MODE;

      const result = await estimateEvolutionOneShot({
        name: 'Kubernetes',
        description: 'Container orchestration platform',
        space: 'economic',
      });

      // ── Mode ──
      assert.equal(result.mode, 'oneshot');
      assert.ok(!result.sessionState, 'oneshot: no session state');
      assert.ok(!result.nextQuestion, 'oneshot: no next question');

      // ── Classification ──
      assert.equal(result.classification.space, 'economic');
      assert.equal(result.reQuestions, null);

      // ── Routing metadata ──
      assert.ok(result.routing, 'routing info must be present');
      assert.equal(result.routing.type, COMPONENT_TYPE.SOLUTION);
      assert.ok(result.routing.confidence >= 0.90,
        `confidence ${result.routing.confidence} ≥ 0.90`);
      assert.equal(result.routing.usedSolutionStrategies, true);
      assert.equal(result.routing.usedCapabilityStrategies, false);
      assert.equal(result.routing.evalMode, 'exclusive');

      // ── Evaluations ──
      assert.ok(result.evaluations != null);
      const methods = Object.keys(result.evaluations);
      assert.ok(methods.length > 0, 'at least one evaluation entry');

      // No capability strategies should be present
      const capMethods = ['write:capacity:s-curve', 'write:capacity:llm-direct', 'write:capacity:publication-analysis',
        'write:capacity:timeline-benchmark', 'write:capacity:logprob-distribution', 'write:capacity:cpc-evolution'];
      for (const m of capMethods) {
        assert.ok(!result.evaluations[m],
          `should NOT have capability "${m}" in exclusive solution routing`);
      }

      // Verify EvolutionResult contract for each entry
      for (const [method, evalResult] of Object.entries(result.evaluations)) {
        if (evalResult.error) {
          assert.equal(typeof evalResult.error, 'string');
        } else {
          assert.equal(typeof evalResult.evolution, 'number');
          assert.ok(evalResult.evolution >= 0 && evalResult.evolution <= 1);
          assert.equal(typeof evalResult.confidence, 'number');
          assert.ok(evalResult.confidence >= 0 && evalResult.confidence <= 1);
          assert.equal(typeof evalResult.method, 'string');

          // Solution-specific: properties array if solution-properties method
          if (evalResult.method === 'write:solution:properties') {
            assert.ok(Array.isArray(evalResult.properties));
            assert.equal(evalResult.properties.length, 12);
          }
        }
      }

      // ── Message ──
      assert.ok(result.message.includes('solution'),
        `message should mention solution: "${result.message}"`);
      assert.ok(result.message.includes('Kubernetes'),
        `message should mention component name`);

      // ── Result shape completeness ──
      assert.equal(typeof result.routing.type, 'string');
      assert.equal(typeof result.routing.confidence, 'number');
      assert.equal(typeof result.routing.method, 'string');
      assert.equal(typeof result.routing.evalMode, 'string');
      assert.equal(typeof result.routing.usedSolutionStrategies, 'boolean');
      assert.equal(typeof result.routing.usedCapabilityStrategies, 'boolean');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 5: FAST — Non-economic short-circuits (no LLM)
  // ══════════════════════════════════════════════════════════════════════════

  describe('non-economic classification takes priority', () => {
    it('social_good: re-questioned, no routing, no evaluation', async () => {
      const result = await estimateEvolutionOneShot({
        name: 'Air',
        description: 'Atmospheric oxygen',
        space: 'social_good',
      });

      assert.equal(result.classification.space, 'social_good');
      assert.equal(result.evaluations, null);
      assert.ok(result.reQuestions.length > 0);
      assert.ok(!result.routing, 'non-economic should not have routing');
    });
  });
});
