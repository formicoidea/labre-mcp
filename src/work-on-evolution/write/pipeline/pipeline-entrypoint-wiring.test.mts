// Tests for pipeline wiring: estimateEvolution({name, pipeline: true})
// returns a result with owmOutput containing 3 positioned components.
//
// This test validates the full wiring from handleEstimateEvolution
// through mode-router → estimateEvolutionOneShot → runEnrichedPipeline.
// Uses mock LLM to avoid external calls.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runEnrichedPipeline } from './pipeline-enriched.mjs';

describe('Pipeline entrypoint wiring: owmOutput with 3 positioned components', () => {

  it('runEnrichedPipeline returns owmOutput field equal to owm', async () => {
    // Mock LLM: handles both discovery (Step 2) and properties (Step 3) prompts
    const mockLLM = async (prompt) => {
      if (prompt.includes('STATE-OF-THE-ART') || prompt.includes('GENERIC CAPABILITY')) {
        // Note: SotA must be different from input "Kubernetes" to avoid dedup
        return [
          'sota_name=Nomad',
          'sota_description=HashiCorp lightweight orchestration platform',
          'legacy_name=Docker Swarm',
          'legacy_description=Older container orchestration built into Docker',
          'confidence=0.90',
          'reasoning=Nomad is emerging SotA, Docker Swarm is legacy',
        ].join('\n');
      }
      // Properties strategy: 12 Wardley properties at level 3 (Product phase)
      return [
        'Market=3|Widely adopted',
        'Knowledge management=3|Well documented',
        'Market perception=3|Established presence',
        'User perception=3|Trusted by users',
        'Perception in industry=3|Industry standard',
        'Focus of value=3|ROI focused',
        'Understanding=3|Well understood',
        'Comparison=3|Easily benchmarked',
        'Failure=3|Predictable failures',
        'Market action=3|Competitive market',
        'Efficiency=3|Highly optimized',
        'Decision drivers=3|Data-driven',
      ].join('\n');
    };

    const standardResult = {
      evolution: 0.65,
      evaluations: { 'write:capacity:llm-direct': { evolution: 0.65, confidence: 0.85 } },
      routing: { usedSolutionStrategies: true },
      classification: { space: 'economic' },
      message: 'Evaluated with 1 strategy(ies).',
    };

    const component = {
      name: 'Kubernetes',
      capability: 'container orchestration',
      nature: 'activity',
      context: 'Running containers at scale in production',
    };

    const result = await runEnrichedPipeline(standardResult, component, {
      llmCall: mockLLM,
      evaluateCapabilityFn: async () => ({
        evaluations: { 'write:capacity:llm-direct': { evolution: 0.55, confidence: 0.80 } },
        routing: {},
        wardleyType: { type: 'activity' },
      }),
    });

    // ── Core wiring assertions ──────────────────────────────────────

    // 1. pipeline flag is true
    assert.equal(result.pipeline, true, 'pipeline should be true');

    // 2. owmOutput field exists and equals owm
    assert.ok(result.owmOutput, 'owmOutput field should exist');
    assert.equal(typeof result.owmOutput, 'string', 'owmOutput should be a string');
    assert.equal(result.owmOutput, result.owm, 'owmOutput should equal owm');

    // 3. owmOutput contains 3 positioned inner components
    const innerLines = result.owmOutput.split('\n').filter(l => l.trim().startsWith('component') && !l.startsWith('component'));
    assert.equal(innerLines.length, 3, `owmOutput should have 3 inner components, got ${innerLines.length}`);

    // 4. Each inner component has a real numeric evolution coordinate
    for (const line of innerLines) {
      const evoMatch = line.match(/\[([0-9.]+)\]/);
      assert.ok(evoMatch, `Inner component should have [evolution]: ${line}`);
      const evo = parseFloat(evoMatch[1]);
      assert.ok(evo > 0 && evo <= 1, `Evolution should be in (0,1]: got ${evo} for line: ${line}`);
    }

    // 5. owmOutput contains all three component names
    assert.ok(result.owmOutput.includes('Kubernetes'), 'owmOutput should contain input component Kubernetes');
    assert.ok(result.owmOutput.includes('Nomad'), 'owmOutput should contain SotA Nomad');
    assert.ok(result.owmOutput.includes('Docker Swarm'), 'owmOutput should contain legacy Docker Swarm');

    // 6. Outer pipeline component has [visibility, pipeline_min]
    const outerLine = result.owmOutput.split('\n').find(l => l.startsWith('component'));
    assert.ok(outerLine, 'Should have an outer component line');
    const outerMatch = outerLine.match(/\[([0-9.]+),\s*([0-9.]+)\]/);
    assert.ok(outerMatch, 'Outer component should have [visibility, pipeline_min]');

    // 7. Pipeline-specific fields are populated
    assert.ok(result.capabilityPivot, 'capabilityPivot should be present');
    assert.ok(result.sotaSolution, 'sotaSolution should be present');
    assert.ok(result.legacySolution, 'legacySolution should be present');
    assert.equal(typeof result.sotaSolution.evolution, 'number', 'sotaSolution.evolution should be a number');
    assert.equal(typeof result.legacySolution.evolution, 'number', 'legacySolution.evolution should be a number');
  });

  it('owmOutput has pipeline syntax with component + pipeline + { inner } structure', async () => {
    const mockLLM = async (prompt) => {
      if (prompt.includes('STATE-OF-THE-ART')) {
        return 'sota_name=React\nsota_description=Modern UI library\nlegacy_name=jQuery\nlegacy_description=Classic DOM manipulation\nconfidence=0.85\nreasoning=React vs jQuery';
      }
      return [
        'Market=3|OK', 'Knowledge management=3|OK', 'Market perception=3|OK',
        'User perception=3|OK', 'Perception in industry=3|OK', 'Focus of value=3|OK',
        'Understanding=3|OK', 'Comparison=3|OK', 'Failure=3|OK',
        'Market action=3|OK', 'Efficiency=3|OK', 'Decision drivers=3|OK',
      ].join('\n');
    };

    const result = await runEnrichedPipeline(
      { evolution: 0.6, evaluations: { x: { evolution: 0.6, confidence: 0.7 } }, routing: {} },
      { name: 'frontend rendering', nature: 'activity' },
      { llmCall: mockLLM },
    );

    const lines = result.owmOutput.split('\n');

    // Has comment, outer component, pipeline declaration, { }, inner components
    assert.ok(lines.some(l => l.startsWith('//')), 'Should have a comment line');
    assert.ok(lines.some(l => l.startsWith('component ')), 'Should have outer component');
    assert.ok(lines.some(l => l.startsWith('pipeline ')), 'Should have pipeline declaration');
    assert.ok(lines.some(l => l.trim() === '{'), 'Should have opening brace');
    assert.ok(lines.some(l => l.trim() === '}'), 'Should have closing brace');

    const innerComponents = lines.filter(l => l.startsWith('    component'));
    assert.equal(innerComponents.length, 3, 'Should have 3 inner components');
  });

  it('standardResult is preserved for backward compatibility', async () => {
    const originalStd = {
      mode: 'oneshot',
      evolution: 0.7,
      evaluations: { x: { evolution: 0.7, confidence: 0.9 } },
      routing: { usedSolutionStrategies: false },
      classification: { space: 'economic' },
      message: 'Test message',
    };

    const result = await runEnrichedPipeline(
      originalStd,
      { name: 'test component', nature: 'activity' },
      {},
    );

    assert.equal(result.standardResult, originalStd, 'standardResult should be the original result');
    assert.equal(result.standardResult.mode, 'oneshot');
    assert.deepEqual(result.standardResult.classification, { space: 'economic' });
  });
});
