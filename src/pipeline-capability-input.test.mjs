// Tests for pipeline mode with CAPABILITY input (AC 5)
//
// Validates that estimateEvolution({name: "container orchestration", pipeline: true})
// returns a valid pipeline OWM output — i.e. the pipeline works when the input is
// a generic capability (not a named solution like "Kubernetes").
//
// In this path:
//   - Step 1: The standard evaluation already ran capability strategies → used directly as pivot
//   - Step 2: LLM discovers SotA + legacy solutions for that capability
//   - Step 3: Each discovered solution is evaluated via solution strategies (12 properties)
//   - OWM syntax is generated with real evolution coordinates

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runEnrichedPipeline, generateOwmSyntax } from './pipeline-enriched.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse OWM lines into structured objects for assertions.
 */
function parseOwmLines(owm) {
  const lines = owm.split('\n');
  const result = { comments: [], outerComponent: null, pipeline: null, innerComponents: [] };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) {
      result.comments.push(trimmed);
    } else if (trimmed.startsWith('component') && !line.startsWith('    ')) {
      result.outerComponent = trimmed;
    } else if (trimmed.startsWith('pipeline')) {
      result.pipeline = trimmed;
    } else if (trimmed.startsWith('component') && line.startsWith('    ')) {
      result.innerComponents.push(trimmed);
    }
  }

  return result;
}

function extractInnerEvolution(line) {
  const match = line.match(/\[([0-9.]+)\]/);
  return match ? parseFloat(match[1]) : null;
}

// ─── Tests: capability input produces valid pipeline ─────────────────────

describe('Pipeline with capability input (AC 5)', () => {

  it('returns pipeline:true with valid OWM when input is a capability', async () => {
    // Mock LLM that handles both discovery and solution evaluation prompts
    const mockLLM = async (prompt) => {
      // Solution discovery prompt contains "GENERIC CAPABILITY"
      if (prompt.includes('GENERIC CAPABILITY') || prompt.includes('STATE-OF-THE-ART')) {
        return [
          'sota_name=Kubernetes',
          'sota_description=Cloud-native container orchestration platform',
          'legacy_name=Docker Swarm',
          'legacy_description=Earlier Docker-native orchestration tool',
          'confidence=0.90',
          'reasoning=Kubernetes is the dominant SotA, Docker Swarm is the legacy alternative',
        ].join('\n');
      }
      // Solution strategy evaluation prompts (12 properties)
      // Return a simple properties-style evaluation
      return 'evolution=0.70\nconfidence=0.80\nmethod=properties';
    };

    // Simulate a standard result from capability evaluation (not solution)
    const standardResult = {
      mode: 'oneshot',
      evaluations: {
        'llm-direct': { evolution: 0.55, confidence: 0.85 },
      },
      routing: {
        usedSolutionStrategies: false, // KEY: input is capability, not solution
        usedCapabilityStrategies: true,
      },
      evolution: 0.55,
      classification: { space: 'economic' },
    };

    // Component is a generic capability — no "capability" sub-field needed
    const component = {
      name: 'container orchestration',
      description: 'Orchestrating containers at scale in the cloud',
      nature: 'activity',
    };

    const result = await runEnrichedPipeline(standardResult, component, {
      llmCall: mockLLM,
    });

    // ── Pipeline flag present
    assert.equal(result.pipeline, true, 'result.pipeline should be true');

    // ── Capability pivot extracted from standard evaluations (not re-evaluated)
    assert.ok(result.capabilityPivot, 'capabilityPivot should exist');
    assert.equal(result.capabilityPivot.capabilityName, 'container orchestration');
    assert.equal(result.capabilityPivot.nature, 'activity');
    assert.equal(result.capabilityPivot.evolution, 0.55, 'capability pivot should use standard eval');
    assert.equal(result.capabilityPivot.confidence, 0.85);

    // ── Solutions discovered and evaluated
    assert.ok(result.discoveredSolutions, 'discoveredSolutions should exist');
    assert.equal(result.discoveredSolutions.sota.name, 'Kubernetes');
    assert.equal(result.discoveredSolutions.legacy.name, 'Docker Swarm');

    assert.ok(result.sotaSolution, 'sotaSolution should exist');
    assert.equal(result.sotaSolution.name, 'Kubernetes');
    assert.ok(result.sotaSolution.evaluations != null, 'SotA should have evaluations');

    assert.ok(result.legacySolution, 'legacySolution should exist');
    assert.equal(result.legacySolution.name, 'Docker Swarm');
    assert.ok(result.legacySolution.evaluations != null, 'Legacy should have evaluations');

    // ── OWM output is valid
    assert.ok(result.owm, 'owm should be a non-empty string');
    assert.ok(typeof result.owm === 'string');
    assert.ok(result.owm.length > 0);

    const parsed = parseOwmLines(result.owm);

    // Has nature comment
    assert.ok(parsed.comments.some(c => c.includes('nature: activity')));

    // Has outer component
    assert.ok(parsed.outerComponent, 'outer component should exist');
    assert.ok(parsed.outerComponent.includes('"container orchestration"'));

    // Has pipeline declaration
    assert.ok(parsed.pipeline, 'pipeline declaration should exist');
    assert.ok(parsed.pipeline.includes('"container orchestration"'));

    // Has inner components (at least 2 - the input component and at least one solution)
    assert.ok(parsed.innerComponents.length >= 2, `should have ≥2 inner components, got ${parsed.innerComponents.length}`);

    // Inner components have real evolution values (not null/undefined)
    for (const ic of parsed.innerComponents) {
      const evo = extractInnerEvolution(ic);
      assert.ok(evo !== null, `inner component should have evolution value: ${ic}`);
      assert.ok(evo >= 0 && evo <= 1, `evolution should be in [0,1]: ${evo}`);
    }
  });

  it('uses standard eval directly (no re-evaluation) when input is capability', async () => {
    // When routing.usedSolutionStrategies === false, Step 1 should NOT re-evaluate
    const standardResult = {
      evaluations: {
        'llm-direct': { evolution: 0.42, confidence: 0.75 },
        's-curve': { evolution: 0.38, confidence: 0.60 },
      },
      routing: { usedSolutionStrategies: false },
    };

    const component = {
      name: 'data storage',
      nature: 'activity',
    };

    const result = await runEnrichedPipeline(standardResult, component, {});

    // Capability pivot should use the best evaluation from the standard result
    assert.ok(result.capabilityPivot);
    // Best confidence is llm-direct at 0.75 → evolution 0.42
    assert.equal(result.capabilityPivot.evolution, 0.42);
    assert.equal(result.capabilityPivot.confidence, 0.75);
  });

  it('generates valid OWM even when only discovery works (no solution eval)', async () => {
    // LLM discovers solutions but evaluation might return simple results
    const mockLLM = async (prompt) => {
      if (prompt.includes('GENERIC CAPABILITY')) {
        return [
          'sota_name=React',
          'sota_description=Modern component-based UI library',
          'legacy_name=jQuery',
          'legacy_description=Legacy DOM manipulation library',
          'confidence=0.85',
          'reasoning=React vs jQuery',
        ].join('\n');
      }
      return 'evolution=0.65\nconfidence=0.70';
    };

    const standardResult = {
      evaluations: {
        'llm-direct': { evolution: 0.50, confidence: 0.80 },
      },
      routing: { usedSolutionStrategies: false },
      evolution: 0.50,
    };

    const component = {
      name: 'frontend rendering',
      nature: 'activity',
    };

    const result = await runEnrichedPipeline(standardResult, component, {
      llmCall: mockLLM,
    });

    assert.equal(result.pipeline, true);
    assert.ok(result.owm);

    // OWM should contain the capability as pipeline label
    const parsed = parseOwmLines(result.owm);
    assert.ok(parsed.pipeline.includes('"frontend rendering"'));
    assert.ok(parsed.outerComponent.includes('"frontend rendering"'));
  });

  it('graceful degradation: capability input without llmCall produces OWM with capability only', async () => {
    const standardResult = {
      evaluations: {
        'llm-direct': { evolution: 0.60, confidence: 0.80 },
      },
      routing: { usedSolutionStrategies: false },
      evolution: 0.60,
    };

    const component = {
      name: 'message queuing',
      nature: 'activity',
    };

    // No llmCall → no discovery → no solution evaluation
    const result = await runEnrichedPipeline(standardResult, component, {});

    assert.equal(result.pipeline, true);
    assert.ok(result.owm);
    assert.equal(result.sotaSolution, null);
    assert.equal(result.legacySolution, null);

    // OWM should still be valid with at least the input component
    const parsed = parseOwmLines(result.owm);
    assert.ok(parsed.outerComponent);
    assert.ok(parsed.pipeline);
    assert.ok(parsed.innerComponents.length >= 1, 'should have at least the input component');
  });

  it('capability label in OWM uses component name when no capabilityLabel', async () => {
    const standardResult = {
      evaluations: {
        'llm-direct': { evolution: 0.45, confidence: 0.70 },
      },
      routing: { usedSolutionStrategies: false },
      evolution: 0.45,
    };

    const component = {
      name: 'identity management',
      nature: 'practice',
    };

    const result = await runEnrichedPipeline(standardResult, component, {});

    assert.equal(result.pipeline, true);
    const parsed = parseOwmLines(result.owm);
    // The capability name from pivot should be used as label
    assert.ok(
      parsed.outerComponent.includes('identity management'),
      'OWM should use the capability name as label',
    );
    // Nature should be in the comment
    assert.ok(parsed.comments.some(c => c.includes('nature: practice')));
  });
});

// ─── Direct OWM generation from capability data ──────────────────────────

describe('generateOwmSyntax with capability-sourced data', () => {

  it('produces valid OWM when all 3 components have real evolution values', () => {
    const owm = generateOwmSyntax({
      capabilityLabel: 'container orchestration',
      capabilityEvolution: 0.55,
      componentName: 'container orchestration',
      componentEvolution: 0.55,
      sotaName: 'Kubernetes',
      sotaEvolution: 0.72,
      legacyName: 'Docker Swarm',
      legacyEvolution: 0.40,
      nature: 'activity',
    });

    const parsed = parseOwmLines(owm);

    // Deduplication: capability and component share name → 2 inner components (+ 1 deduped)
    // Actually: componentName = "container orchestration" is different from sota/legacy names
    // So we get: container orchestration (0.55), Docker Swarm (0.40), Kubernetes (0.72) = 3 inner
    assert.equal(parsed.innerComponents.length, 3);

    // Sorted by evolution: Docker Swarm (0.40) → container orchestration (0.55) → Kubernetes (0.72)
    const evolutions = parsed.innerComponents.map(extractInnerEvolution);
    for (let i = 1; i < evolutions.length; i++) {
      assert.ok(evolutions[i] >= evolutions[i - 1],
        `inner components should be sorted by evolution: ${evolutions}`);
    }
  });

  it('handles capability input where component name = capability label (deduplication)', () => {
    // When the user passes a capability, componentName and capabilityLabel may match
    const owm = generateOwmSyntax({
      capabilityLabel: 'data storage',
      capabilityEvolution: 0.50,
      componentName: 'data storage',
      componentEvolution: 0.50,
      sotaName: 'Amazon S3',
      sotaEvolution: 0.85,
      legacyName: 'NFS',
      legacyEvolution: 0.30,
      nature: 'activity',
    });

    const parsed = parseOwmLines(owm);

    // 3 inner components (data storage, NFS, Amazon S3) — component name = capability label
    // but inner components are distinct names
    assert.equal(parsed.innerComponents.length, 3);

    // Pipeline declaration uses the capability label
    assert.ok(parsed.pipeline.includes('"data storage"'));
  });
});
