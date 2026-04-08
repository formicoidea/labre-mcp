// AC 9010203 Sub-AC 3: Solution result assembly and formatting integration
//
// Validates that:
//   1. assembleSolutionResult enriches raw strategy output with metadata
//   2. Formatted output for solutions is consistent with capability format
//   3. Both auto and conversational modes produce properly assembled results
//   4. The full pipeline: detection -> routing -> strategy -> assembly -> formatting works
//   5. Response formatter correctly handles solution-properties method
//   6. Existing capability results are unaffected (backward compatibility)
//   7. The assembler is extensible (handles new strategies dropping in)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleSolutionResult,
  assembleSolutionEvaluations,
  buildStructuredResult,
  resolveStage,
  computePhaseDistribution,
  computeMeanPhase,
  dominantPhase,
} from './solution-strategies/assemble-result.mjs';
import {
  SolutionEvolutionResult,
  PropertyScore,
  PROPERTY_COUNT,
} from './solution-strategies/solution-evolution-result.mjs';
import {
  dispatchSolutionStrategies,
  detectComponentType,
  determineRoutingTargets,
  COMPONENT_TYPE,
} from './solution-capability-router.mjs';
import {
  formatResponse,
  formatStrategyResult,
  strategyReasoning,
  evolutionToStage,
} from './response-formatter.mjs';
import { estimateEvolutionOneShot } from './estimate-evolution.mjs';

// ─── Mock LLM ───────────────────────────────────────────────────────────────

const mockLlmPhase3 = async () => [
  'Market=3|Established market with growing competition',
  'Knowledge management=3|Widely published and taught',
  'Market perception=3|Well-understood and accepted',
  'User perception=3|Expected reliability and support',
  'Industry perception=3|Recognized as strategic necessity',
  'Value focus=3|Reliability and TCO driven',
  'Understanding=3|Well-understood with established architectures',
  'Comparison=3|Feature-by-feature comparison standard',
  'Failure/deficiency=3|Notable events tracked via SLAs',
  'Market action/engagement=3|Product marketing and competitive positioning',
  'Efficiency=3|Good efficiency with established processes',
  'Decision driver=3|Feature comparison and risk mitigation',
].join('\n');

const mockLlmMixed = async () => [
  'Market=4|Mature commoditized market',
  'Knowledge management=3|Widely published',
  'Market perception=4|Taken for granted utility',
  'User perception=3|Expected reliability',
  'Industry perception=4|Essential infrastructure',
  'Value focus=3|TCO and reliability focus',
  'Understanding=4|Completely understood',
  'Comparison=3|Feature comparison standard',
  'Failure/deficiency=4|Failure unacceptable',
  'Market action/engagement=3|Product marketing',
  'Efficiency=3|Good efficiency',
  'Decision driver=3|Risk and analysis driven',
].join('\n');

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('AC 9010203 Sub-AC 3: Solution result assembly and formatting', () => {
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
  // Part 1: assembleSolutionResult enrichment
  // ══════════════════════════════════════════════════════════════════════════

  describe('assembleSolutionResult: metadata enrichment', () => {
    const rawResult = {
      evolution: 0.55,
      confidence: 0.85,
      method: 'solution-properties',
      properties: [
        { property: 'Market', phase: 3, label: 'Product', weight: 1 / 12, reason: 'Established market' },
        { property: 'Knowledge management', phase: 3, label: 'Product', weight: 1 / 12, reason: 'Widely documented' },
        { property: 'Market perception', phase: 3, label: 'Product', weight: 1 / 12 },
        { property: 'User perception', phase: 3, label: 'Product', weight: 1 / 12 },
        { property: 'Industry perception', phase: 3, label: 'Product', weight: 1 / 12 },
        { property: 'Value focus', phase: 3, label: 'Product', weight: 1 / 12 },
        { property: 'Understanding', phase: 3, label: 'Product', weight: 1 / 12 },
        { property: 'Comparison', phase: 3, label: 'Product', weight: 1 / 12 },
        { property: 'Failure/deficiency', phase: 3, label: 'Product', weight: 1 / 12 },
        { property: 'Market action/engagement', phase: 3, label: 'Product', weight: 1 / 12 },
        { property: 'Efficiency', phase: 3, label: 'Product', weight: 1 / 12 },
        { property: 'Decision driver', phase: 3, label: 'Product', weight: 1 / 12 },
      ],
      trace: [{ step: 'test' }],
    };

    it('adds stage label', () => {
      const enriched = assembleSolutionResult(rawResult);
      assert.equal(enriched.stage, 'Product');
    });

    it('adds phaseDistribution', () => {
      const enriched = assembleSolutionResult(rawResult);
      assert.deepEqual(enriched.phaseDistribution, { 1: 0, 2: 0, 3: 12, 4: 0 });
    });

    it('adds meanPhase', () => {
      const enriched = assembleSolutionResult(rawResult);
      assert.equal(enriched.meanPhase, 3);
    });

    it('adds dominantPhase', () => {
      const enriched = assembleSolutionResult(rawResult);
      assert.equal(enriched.dominantPhase.phase, 3);
      assert.equal(enriched.dominantPhase.label, 'Product');
      assert.equal(enriched.dominantPhase.count, 12);
    });

    it('adds confidenceMetadata', () => {
      const enriched = assembleSolutionResult(rawResult);
      assert.ok(enriched.confidenceMetadata);
      assert.equal(enriched.confidenceMetadata.evaluatedCount, 12);
      assert.equal(enriched.confidenceMetadata.totalCount, 12);
      assert.equal(enriched.confidenceMetadata.coverage, 1);
      assert.equal(enriched.confidenceMetadata.mode, 'auto');
      assert.equal(enriched.confidenceMetadata.aggregationMethod, 'weighted_average');
    });

    it('preserves original fields', () => {
      const enriched = assembleSolutionResult(rawResult);
      assert.equal(enriched.evolution, 0.55);
      assert.equal(enriched.confidence, 0.85);
      assert.equal(enriched.method, 'solution-properties');
      assert.ok(Array.isArray(enriched.trace));
      assert.equal(enriched.properties.length, 12);
    });

    it('passes through error results unchanged', () => {
      const errorResult = { error: 'LLM unavailable' };
      const enriched = assembleSolutionResult(errorResult);
      assert.deepEqual(enriched, errorResult);
    });

    it('handles results without properties (adds only stage)', () => {
      const noPropsResult = { evolution: 0.65, confidence: 0.60, method: 'some-other-strategy' };
      const enriched = assembleSolutionResult(noPropsResult);
      assert.equal(enriched.stage, 'Product');
      assert.equal(enriched.phaseDistribution, undefined);
      assert.equal(enriched.meanPhase, undefined);
    });

    it('respects mode option for confidenceMetadata', () => {
      const enriched = assembleSolutionResult(rawResult, { mode: 'conversational' });
      assert.equal(enriched.confidenceMetadata.mode, 'conversational');
    });

    it('handles mixed phases with correct distribution', () => {
      const mixedResult = {
        evolution: 0.68,
        confidence: 0.80,
        method: 'solution-properties',
        properties: [
          { property: 'Market', phase: 4, weight: 1 / 12 },
          { property: 'Knowledge management', phase: 3, weight: 1 / 12 },
          { property: 'Market perception', phase: 4, weight: 1 / 12 },
          { property: 'User perception', phase: 3, weight: 1 / 12 },
          { property: 'Industry perception', phase: 4, weight: 1 / 12 },
          { property: 'Value focus', phase: 3, weight: 1 / 12 },
          { property: 'Understanding', phase: 4, weight: 1 / 12 },
          { property: 'Comparison', phase: 3, weight: 1 / 12 },
          { property: 'Failure/deficiency', phase: 4, weight: 1 / 12 },
          { property: 'Market action/engagement', phase: 3, weight: 1 / 12 },
          { property: 'Efficiency', phase: 3, weight: 1 / 12 },
          { property: 'Decision driver', phase: 3, weight: 1 / 12 },
        ],
      };
      const enriched = assembleSolutionResult(mixedResult);
      assert.deepEqual(enriched.phaseDistribution, { 1: 0, 2: 0, 3: 7, 4: 5 });
      assert.equal(enriched.dominantPhase.phase, 3);
      assert.equal(enriched.dominantPhase.count, 7);
      assert.ok(enriched.meanPhase > 3 && enriched.meanPhase < 4);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 2: assembleSolutionEvaluations (batch enrichment)
  // ══════════════════════════════════════════════════════════════════════════

  describe('assembleSolutionEvaluations: batch processing', () => {
    it('enriches all evaluations in the map', () => {
      const evals = {
        'solution-properties': {
          evolution: 0.55,
          confidence: 0.85,
          method: 'solution-properties',
          properties: Array.from({ length: 12 }, (_, i) => ({
            property: `Prop${i}`, phase: 3, weight: 1 / 12,
          })),
        },
        'solution-dispatch-error': { error: 'test error' },
      };

      const assembled = assembleSolutionEvaluations(evals, { mode: 'auto' });
      assert.ok(assembled['solution-properties'].stage);
      assert.ok(assembled['solution-properties'].phaseDistribution);
      assert.deepEqual(assembled['solution-dispatch-error'], { error: 'test error' });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 3: buildStructuredResult (full SolutionEvolutionResult)
  // ══════════════════════════════════════════════════════════════════════════

  describe('buildStructuredResult: SolutionEvolutionResult construction', () => {
    it('creates valid SolutionEvolutionResult from raw output', () => {
      const raw = {
        evolution: 0.55,
        confidence: 0.85,
        method: 'solution-properties',
        properties: [
          { property: 'Market', phase: 3, reason: 'Established market' },
          { property: 'Knowledge management', phase: 3, reason: 'Widely documented' },
        ],
      };

      const structured = buildStructuredResult(raw);
      assert.ok(structured instanceof SolutionEvolutionResult);
      assert.equal(typeof structured.evolution, 'number');
      assert.equal(typeof structured.confidence, 'number');
      assert.equal(structured.method, 'solution-properties');
    });

    it('throws for error results', () => {
      assert.throws(
        () => buildStructuredResult({ error: 'fail' }),
        /Cannot build structured result/
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 4: Helpers
  // ══════════════════════════════════════════════════════════════════════════

  describe('helper functions', () => {
    it('resolveStage maps correctly', () => {
      assert.equal(resolveStage(0.05), 'Genesis');
      assert.equal(resolveStage(0.25), 'Custom');
      assert.equal(resolveStage(0.55), 'Product');
      assert.equal(resolveStage(0.85), 'Commodity');
      assert.equal(resolveStage(NaN), 'Unknown');
    });

    it('computePhaseDistribution counts phases', () => {
      const props = [
        { phase: 1 }, { phase: 2 }, { phase: 3 }, { phase: 3 },
        { phase: 4 }, { phase: 4 }, { phase: 4 },
      ];
      assert.deepEqual(computePhaseDistribution(props), { 1: 1, 2: 1, 3: 2, 4: 3 });
    });

    it('computeMeanPhase calculates average', () => {
      const props = [{ phase: 2 }, { phase: 3 }, { phase: 4 }];
      assert.equal(computeMeanPhase(props), 3);
    });

    it('dominantPhase finds the mode', () => {
      const dist = { 1: 1, 2: 2, 3: 7, 4: 2 };
      const result = dominantPhase(dist);
      assert.equal(result.phase, 3);
      assert.equal(result.count, 7);
      assert.equal(result.label, 'Product');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 5: Response formatter handles solution-properties correctly
  // ══════════════════════════════════════════════════════════════════════════

  describe('response formatter: solution-properties integration', () => {
    it('strategyReasoning handles "solution-properties" method', () => {
      const result = {
        evolution: 0.55,
        confidence: 0.85,
        method: 'solution-properties',
        properties: Array.from({ length: 12 }, () => ({ phase: 3 })),
        phaseDistribution: { 1: 0, 2: 0, 3: 12, 4: 0 },
        dominantPhase: { phase: 3, count: 12, label: 'Product' },
      };

      const reasoning = strategyReasoning('solution-properties', result, { name: 'Kubernetes' });
      assert.ok(reasoning.includes('12-property'), 'should mention 12-property evaluation');
      assert.ok(reasoning.includes('Product'), 'should mention the Product stage');
      assert.ok(reasoning.includes('12× Product'), 'should include phase distribution');
      assert.ok(reasoning.includes('Dominant phase'), 'should mention dominant phase');
    });

    it('strategyReasoning handles "properties" alias the same way', () => {
      const result = {
        evolution: 0.55,
        confidence: 0.85,
        method: 'properties',
        properties: Array.from({ length: 12 }, () => ({ phase: 3 })),
      };

      const reasoning = strategyReasoning('properties', result, { name: 'Kubernetes' });
      assert.ok(reasoning.includes('12-property'));
    });

    it('strategyReasoning handles solution: prefixed methods (parallel mode)', () => {
      const result = {
        evolution: 0.55,
        confidence: 0.85,
        method: 'solution:solution-properties',
        properties: Array.from({ length: 12 }, () => ({ phase: 3 })),
      };

      const reasoning = strategyReasoning('solution:solution-properties', result, { name: 'K8s' });
      // Should use the base method lookup for solution: prefix
      assert.ok(reasoning.includes('12-property'));
    });

    it('strategyReasoning falls back gracefully for unknown solution methods', () => {
      const result = {
        evolution: 0.55,
        confidence: 0.85,
        method: 'custom-solution-strategy',
        properties: [{ phase: 3 }, { phase: 3 }],
      };

      const reasoning = strategyReasoning('custom-solution-strategy', result, { name: 'X' });
      // Should still mention 12-property since result has properties
      assert.ok(reasoning.includes('12-property') || reasoning.includes('Product'));
    });

    it('formatStrategyResult includes enriched property breakdown', () => {
      const result = {
        evolution: 0.55,
        confidence: 0.80,
        method: 'solution-properties',
        stage: 'Product',
        meanPhase: 3.0,
        properties: [
          { property: 'Market', phase: 3, label: 'Product', reason: 'Established market' },
          { property: 'Knowledge management', phase: 2, label: 'Custom', reason: 'Emerging knowledge' },
          { property: 'Efficiency', phase: 4, label: 'Commodity', reason: 'Highly efficient' },
        ],
        confidenceMetadata: {
          coverage: 1.0,
          evaluatedCount: 12,
          totalCount: 12,
          mode: 'auto',
        },
      };

      const formatted = formatStrategyResult('solution-properties', result, { name: 'Kubernetes' });

      // Check property breakdown with reasons
      assert.ok(formatted.includes('Market: **Product** (phase 3)'), 'should show Market as Product');
      assert.ok(formatted.includes('Established market'), 'should include reason');
      assert.ok(formatted.includes('Knowledge management: **Custom** (phase 2)'), 'should show Knowledge as Custom');
      assert.ok(formatted.includes('Efficiency: **Commodity** (phase 4)'), 'should show Efficiency as Commodity');

      // Check summary statistics
      assert.ok(formatted.includes('Mean phase: 3'), 'should show mean phase');
      assert.ok(formatted.includes('Overall stage: Product'), 'should show stage');
      assert.ok(formatted.includes('Coverage: 100%'), 'should show coverage');
    });

    it('formatStrategyResult handles results without enrichment', () => {
      const bareResult = {
        evolution: 0.55,
        confidence: 0.80,
        method: 'solution-properties',
        properties: [
          { property: 'Market', phase: 3, label: 'Product' },
        ],
      };

      const formatted = formatStrategyResult('solution-properties', bareResult, { name: 'X' });
      assert.ok(formatted.includes('Market: **Product**'));
      // No summary stats (no stage, meanPhase, confidenceMetadata)
      assert.ok(!formatted.includes('Mean phase:'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 6: Full formatResponse for solution results
  // ══════════════════════════════════════════════════════════════════════════

  describe('formatResponse: full solution result formatting', () => {
    it('solution result produces valid markdown with routing + property breakdown', () => {
      const mockResult = {
        mode: 'oneshot',
        classification: { space: 'economic', reason: 'Market component', requiresReQuestion: false },
        reQuestions: null,
        evaluations: {
          'solution-properties': {
            evolution: 0.62,
            confidence: 0.85,
            method: 'solution-properties',
            stage: 'Product',
            meanPhase: 3.17,
            phaseDistribution: { 1: 0, 2: 2, 3: 8, 4: 2 },
            dominantPhase: { phase: 3, count: 8, label: 'Product' },
            properties: [
              { property: 'Market', phase: 3, label: 'Product', reason: 'Established market' },
              { property: 'Knowledge management', phase: 3, label: 'Product', reason: 'Well documented' },
            ],
            confidenceMetadata: {
              coverage: 1.0,
              evaluatedCount: 12,
              totalCount: 12,
              mode: 'auto',
            },
          },
        },
        routing: {
          type: 'solution',
          confidence: 0.98,
          method: 'known-solution',
          evalMode: 'exclusive',
          usedSolutionStrategies: true,
          usedCapabilityStrategies: false,
        },
        message: 'Kubernetes evaluated',
      };

      const formatted = formatResponse(mockResult, {
        component: { name: 'Kubernetes' },
      });

      // Verify markdown structure
      assert.ok(formatted.includes('## Evolution Estimation: Kubernetes'));
      assert.ok(formatted.includes('Named Solution'));
      assert.ok(formatted.includes('solution-properties'));
      assert.ok(formatted.includes('Property breakdown'));
      assert.ok(formatted.includes('Market: **Product**'));
    });

    it('capability result is formatted consistently (no property breakdown)', () => {
      const mockResult = {
        mode: 'oneshot',
        classification: { space: 'economic', reason: 'Market component', requiresReQuestion: false },
        reQuestions: null,
        evaluations: {
          's-curve': {
            evolution: 0.75,
            confidence: 0.60,
            method: 's-curve',
          },
        },
        routing: {
          type: 'capability',
          confidence: 0.97,
          method: 'known-capability',
          evalMode: 'exclusive',
          usedSolutionStrategies: false,
          usedCapabilityStrategies: true,
        },
        message: 'CRM evaluated',
      };

      const formatted = formatResponse(mockResult, {
        component: { name: 'CRM', certitude: 0.9, ubiquity: 0.85 },
      });

      assert.ok(formatted.includes('## Evolution Estimation: CRM'));
      assert.ok(formatted.includes('Abstract Capability'));
      assert.ok(formatted.includes('s-curve'));
      assert.ok(!formatted.includes('Property breakdown'), 'capability should not have property breakdown');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 7: Pipeline integration — dispatch produces assembled results
  // ══════════════════════════════════════════════════════════════════════════

  describe('pipeline: dispatchSolutionStrategies returns assembled results', () => {
    it('auto mode dispatch returns enriched result with metadata', async () => {
      const evaluations = await dispatchSolutionStrategies(
        { name: 'Kubernetes', description: 'Container orchestration platform' },
        { llmCall: mockLlmPhase3, strategy: 'all', mode: 'auto' }
      );

      const result = evaluations['solution-properties'];
      assert.ok(!result.error, `Strategy should succeed: ${result?.error}`);

      // Original EvolutionResult contract fields
      assert.equal(typeof result.evolution, 'number');
      assert.ok(result.evolution >= 0 && result.evolution <= 1);
      assert.equal(typeof result.confidence, 'number');
      assert.equal(result.method, 'solution-properties');
      assert.ok(Array.isArray(result.properties));
      assert.equal(result.properties.length, 12);

      // Enriched metadata from assembler
      assert.equal(result.stage, 'Product', 'should be Product stage for all-phase-3');
      assert.equal(result.meanPhase, 3, 'mean phase should be 3');
      assert.ok(result.phaseDistribution, 'phaseDistribution should be present');
      assert.equal(result.phaseDistribution[3], 12, 'all 12 properties at phase 3');
      assert.ok(result.dominantPhase, 'dominantPhase should be present');
      assert.equal(result.dominantPhase.phase, 3);
      assert.ok(result.confidenceMetadata, 'confidenceMetadata should be present');
      assert.equal(result.confidenceMetadata.mode, 'auto');
    });

    it('conversational mode dispatch returns enriched result', async () => {
      let callCount = 0;
      const singlePropLlm = async (prompt) => {
        callCount++;
        const nameMatch = prompt.match(/property: "(.+?)"/);
        const name = nameMatch ? nameMatch[1] : 'Market';
        return `${name}=3|Well-established`;
      };

      const evaluations = await dispatchSolutionStrategies(
        { name: 'PostgreSQL', context: 'Relational database' },
        { llmCall: singlePropLlm, strategy: 'all', mode: 'conversational' }
      );

      const result = evaluations['solution-properties'];
      assert.ok(!result.error);
      assert.equal(result.confidenceMetadata?.mode, 'conversational');
      assert.ok(result.stage, 'should have stage');
    });

    it('mixed-phase dispatch returns correct distribution', async () => {
      const evaluations = await dispatchSolutionStrategies(
        { name: 'PostgreSQL', description: 'Relational database' },
        { llmCall: mockLlmMixed, strategy: 'all', mode: 'auto' }
      );

      const result = evaluations['solution-properties'];
      assert.ok(!result.error);
      assert.ok(result.phaseDistribution);
      // mockLlmMixed: 5 properties at phase 4, 7 at phase 3
      assert.equal(result.phaseDistribution[4], 5);
      assert.equal(result.phaseDistribution[3], 7);
      assert.ok(result.meanPhase > 3 && result.meanPhase < 4);
    });

    it('LLM error produces error entry (not enriched)', async () => {
      const errorLlm = async () => { throw new Error('LLM unavailable'); };
      const evaluations = await dispatchSolutionStrategies(
        { name: 'K8s' }, { llmCall: errorLlm, strategy: 'all' }
      );
      const result = evaluations['solution-properties'];
      assert.ok(result.error, 'should have error entry');
      assert.equal(result.stage, undefined, 'error results should not be enriched');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 8: estimateEvolutionOneShot end-to-end with assembly
  // ══════════════════════════════════════════════════════════════════════════

  describe('estimateEvolutionOneShot: capability path unaffected', () => {
    it('ERP with s-curve produces standard result (no solution enrichment)', async () => {
      const result = await estimateEvolutionOneShot({
        name: 'ERP',
        description: 'Enterprise resource planning',
        space: 'economic',
        strategy: 's-curve',
        certitude: 0.9,
        ubiquity: 0.85,
      });

      assert.equal(result.mode, 'oneshot');
      assert.ok(result.evaluations['s-curve']);
      const scurve = result.evaluations['s-curve'];
      assert.equal(typeof scurve.evolution, 'number');
      assert.equal(typeof scurve.confidence, 'number');
      assert.equal(scurve.method, 's-curve');

      // Should NOT have solution-specific enrichment
      assert.equal(scurve.stage, undefined, 'capability result should not have stage from assembler');
      assert.equal(scurve.phaseDistribution, undefined);
      assert.equal(scurve.dominantPhase, undefined);
      assert.equal(scurve.confidenceMetadata, undefined);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 9: Extensibility — new strategy results get assembled
  // ══════════════════════════════════════════════════════════════════════════

  describe('extensibility: assembler handles arbitrary strategy results', () => {
    it('assembler enriches any result with properties array', () => {
      const futureStrategy = {
        evolution: 0.40,
        confidence: 0.70,
        method: 'market-data-analysis',
        properties: [
          { property: 'Market', phase: 2, weight: 1 / 12 },
          { property: 'Knowledge management', phase: 2, weight: 1 / 12 },
          { property: 'Efficiency', phase: 3, weight: 1 / 12 },
        ],
      };

      const enriched = assembleSolutionResult(futureStrategy);
      assert.equal(enriched.stage, 'Product'); // 0.40 → Product
      assert.ok(enriched.phaseDistribution);
      assert.equal(enriched.phaseDistribution[2], 2);
      assert.equal(enriched.phaseDistribution[3], 1);
      assert.ok(enriched.confidenceMetadata);
    });

    it('assembler handles result without properties (non-property strategy)', () => {
      const nonPropStrategy = {
        evolution: 0.65,
        confidence: 0.60,
        method: 'solution-market-signal',
      };

      const enriched = assembleSolutionResult(nonPropStrategy);
      assert.equal(enriched.stage, 'Product');
      assert.equal(enriched.phaseDistribution, undefined);
      assert.equal(enriched.evolution, 0.65);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 10: Consistent result format — solution vs capability shape
  // ══════════════════════════════════════════════════════════════════════════

  describe('result format consistency: solution matches capability contract', () => {
    it('both solution and capability results have evolution, confidence, method', async () => {
      // Capability
      const capResult = await estimateEvolutionOneShot({
        name: 'CRM',
        description: 'Customer relationship management',
        space: 'economic',
        strategy: 's-curve',
        certitude: 0.85,
        ubiquity: 0.80,
      });

      const scurve = capResult.evaluations['s-curve'];
      assert.equal(typeof scurve.evolution, 'number');
      assert.equal(typeof scurve.confidence, 'number');
      assert.equal(typeof scurve.method, 'string');

      // Solution (via mock)
      const solEvals = await dispatchSolutionStrategies(
        { name: 'Kubernetes' },
        { llmCall: mockLlmPhase3, strategy: 'all' }
      );
      const solResult = solEvals['solution-properties'];
      assert.equal(typeof solResult.evolution, 'number');
      assert.equal(typeof solResult.confidence, 'number');
      assert.equal(typeof solResult.method, 'string');

      // Both are numbers in [0, 1]
      assert.ok(scurve.evolution >= 0 && scurve.evolution <= 1);
      assert.ok(scurve.confidence >= 0 && scurve.confidence <= 1);
      assert.ok(solResult.evolution >= 0 && solResult.evolution <= 1);
      assert.ok(solResult.confidence >= 0 && solResult.confidence <= 1);
    });

    it('formatStrategyResult works for both capability and solution results', () => {
      // Capability
      const capFormatted = formatStrategyResult('s-curve', {
        evolution: 0.75, confidence: 0.60, method: 's-curve',
      }, { name: 'CRM', certitude: 0.9, ubiquity: 0.85 });

      assert.ok(capFormatted.includes('s-curve'));
      assert.ok(capFormatted.includes('Evolution:'));
      assert.ok(capFormatted.includes('Confidence:'));

      // Solution
      const solFormatted = formatStrategyResult('solution-properties', {
        evolution: 0.55, confidence: 0.85, method: 'solution-properties',
        properties: [{ property: 'Market', phase: 3, label: 'Product' }],
      }, { name: 'Kubernetes' });

      assert.ok(solFormatted.includes('solution-properties'));
      assert.ok(solFormatted.includes('Evolution:'));
      assert.ok(solFormatted.includes('Confidence:'));
      assert.ok(solFormatted.includes('Property breakdown'));
    });
  });
});
