// Tests for solution discovery in pipeline-enriched.mjs
//
// Validates that discoverPipelineSolutions and parseSolutionDiscoveryResponse
// correctly identify SotA and legacy solutions for a given capability.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../../lib/prompts/init.mjs';
import {
  discoverPipelineSolutions,
  parseSolutionDiscoveryResponse,
  runEnrichedPipeline,
} from './pipeline-enriched.mjs';

// ─── parseSolutionDiscoveryResponse ──────────────────────────────────────

describe('parseSolutionDiscoveryResponse', () => {

  it('parses a well-formed 6-line response', () => {
    const text = [
      'sota_name=GitHub Actions',
      'sota_description=Modern cloud-native CI/CD platform integrated with GitHub',
      'legacy_name=Jenkins',
      'legacy_description=Established open-source automation server, widely used but complex to maintain',
      'confidence=0.88',
      'reasoning=GitHub Actions represents modern SotA while Jenkins is the canonical legacy CI/CD tool',
    ].join('\n');

    const result = parseSolutionDiscoveryResponse(text, 'continuous integration');

    assert.deepEqual(result.sota, {
      name: 'GitHub Actions',
      description: 'Modern cloud-native CI/CD platform integrated with GitHub',
      role: 'sota',
    });
    assert.deepEqual(result.legacy, {
      name: 'Jenkins',
      description: 'Established open-source automation server, widely used but complex to maintain',
      role: 'legacy',
    });
    assert.equal(result.confidence, 0.88);
    assert.equal(result.capabilityUsed, 'continuous integration');
    assert.ok(result.reasoning.includes('GitHub Actions'));
  });

  it('handles response with extra whitespace and preamble', () => {
    const text = [
      'Here are my suggestions:',
      '',
      'sota_name = Kubernetes',
      'sota_description = Modern container orchestration platform by Google',
      'legacy_name = Docker Swarm',
      'legacy_description = Older container orchestration built into Docker',
      'confidence = 0.92',
      'reasoning = Kubernetes is the dominant SotA while Docker Swarm is the legacy alternative',
    ].join('\n');

    const result = parseSolutionDiscoveryResponse(text, 'container orchestration');
    assert.equal(result.sota.name, 'Kubernetes');
    assert.equal(result.legacy.name, 'Docker Swarm');
    assert.equal(result.confidence, 0.92);
  });

  it('returns null for sota when sota_name is missing', () => {
    const text = [
      'legacy_name=Jenkins',
      'legacy_description=Old CI tool',
      'confidence=0.70',
      'reasoning=Only legacy found',
    ].join('\n');

    const result = parseSolutionDiscoveryResponse(text, 'CI/CD');
    assert.equal(result.sota, null);
    assert.equal(result.legacy.name, 'Jenkins');
  });

  it('returns null for legacy when legacy_name is missing', () => {
    const text = [
      'sota_name=GitHub Actions',
      'sota_description=Modern CI/CD',
      'confidence=0.65',
      'reasoning=Only SotA found',
    ].join('\n');

    const result = parseSolutionDiscoveryResponse(text, 'CI/CD');
    assert.equal(result.sota.name, 'GitHub Actions');
    assert.equal(result.legacy, null);
  });

  it('returns null for solutions when names are "none" or "n/a"', () => {
    const text = [
      'sota_name=none',
      'sota_description=N/A',
      'legacy_name=N/A',
      'legacy_description=N/A',
      'confidence=0.30',
      'reasoning=Cannot determine specific solutions',
    ].join('\n');

    const result = parseSolutionDiscoveryResponse(text, 'obscure capability');
    assert.equal(result.sota, null);
    assert.equal(result.legacy, null);
    assert.equal(result.confidence, 0.30);
  });

  it('defaults confidence to 0.60 when not present', () => {
    const text = [
      'sota_name=React',
      'sota_description=Modern frontend library',
      'legacy_name=jQuery',
      'legacy_description=Legacy DOM manipulation library',
      'reasoning=React vs jQuery',
    ].join('\n');

    const result = parseSolutionDiscoveryResponse(text, 'frontend rendering');
    assert.equal(result.confidence, 0.60);
  });

  it('clamps confidence to [0, 1]', () => {
    const text = [
      'sota_name=React',
      'sota_description=Modern',
      'legacy_name=jQuery',
      'legacy_description=Legacy',
      'confidence=1.50',
      'reasoning=Overconfident',
    ].join('\n');

    const result = parseSolutionDiscoveryResponse(text, 'frontend');
    assert.equal(result.confidence, 1.0);
  });

  it('returns both null for completely unparseable response', () => {
    const text = 'This is not a structured response at all.';
    const result = parseSolutionDiscoveryResponse(text, 'unknown');
    assert.equal(result.sota, null);
    assert.equal(result.legacy, null);
    assert.equal(result.confidence, 0.60); // default
    assert.equal(result.capabilityUsed, 'unknown');
  });
});

// ─── discoverPipelineSolutions ───────────────────────────────────────────

describe('discoverPipelineSolutions', () => {

  it('returns null results when capability is empty', async () => {
    const result = await discoverPipelineSolutions('', { llmCall: async () => '' });
    assert.equal(result.sota, null);
    assert.equal(result.legacy, null);
    assert.equal(result.confidence, 0);
  });

  it('returns null results when no llmCall provided', async () => {
    const result = await discoverPipelineSolutions('container orchestration', {});
    assert.equal(result.sota, null);
    assert.equal(result.legacy, null);
    assert.equal(result.capabilityUsed, 'container orchestration');
    assert.equal(result.confidence, 0);
  });

  it('discovers solutions via mock LLM call', async () => {
    const mockLLM = async (prompt) => {
      // Verify the prompt contains the capability name
      assert.ok(prompt.includes('container orchestration'));
      return [
        'sota_name=Kubernetes',
        'sota_description=Dominant cloud-native container orchestration platform',
        'legacy_name=Docker Swarm',
        'legacy_description=Earlier container orchestration built into Docker Engine',
        'confidence=0.91',
        'reasoning=Kubernetes is the clear SotA while Docker Swarm is the legacy predecessor',
      ].join('\n');
    };

    const result = await discoverPipelineSolutions('container orchestration', {
      llmCall: mockLLM,
    });

    assert.equal(result.sota.name, 'Kubernetes');
    assert.equal(result.sota.role, 'sota');
    assert.equal(result.legacy.name, 'Docker Swarm');
    assert.equal(result.legacy.role, 'legacy');
    assert.equal(result.confidence, 0.91);
    assert.equal(result.capabilityUsed, 'container orchestration');
  });

  it('passes excludeName to LLM prompt', async () => {
    let capturedPrompt = '';
    const mockLLM = async (prompt) => {
      capturedPrompt = prompt;
      return [
        'sota_name=EKS',
        'sota_description=AWS managed Kubernetes',
        'legacy_name=Mesos',
        'legacy_description=Apache Mesos legacy orchestrator',
        'confidence=0.80',
        'reasoning=Excluding Kubernetes as requested',
      ].join('\n');
    };

    await discoverPipelineSolutions('container orchestration', {
      llmCall: mockLLM,
      excludeName: 'Kubernetes',
    });

    assert.ok(capturedPrompt.includes('Kubernetes'), 'prompt should contain exclude name');
    assert.ok(capturedPrompt.includes('do NOT repeat'), 'prompt should contain exclusion instruction');
  });

  it('passes description context to LLM prompt', async () => {
    let capturedPrompt = '';
    const mockLLM = async (prompt) => {
      capturedPrompt = prompt;
      return [
        'sota_name=Terraform',
        'sota_description=Modern IaC tool by HashiCorp',
        'legacy_name=CloudFormation',
        'legacy_description=AWS native IaC, older approach',
        'confidence=0.85',
        'reasoning=Terraform vs CloudFormation',
      ].join('\n');
    };

    await discoverPipelineSolutions('infrastructure as code', {
      llmCall: mockLLM,
      description: 'Managing cloud infrastructure declaratively',
    });

    assert.ok(capturedPrompt.includes('Managing cloud infrastructure declaratively'));
  });

  it('gracefully handles LLM errors', async () => {
    const failingLLM = async () => {
      throw new Error('LLM API unavailable');
    };

    const result = await discoverPipelineSolutions('container orchestration', {
      llmCall: failingLLM,
    });

    assert.equal(result.sota, null);
    assert.equal(result.legacy, null);
    assert.equal(result.capabilityUsed, 'container orchestration');
    assert.equal(result.confidence, 0);
  });

  it('trims whitespace from capability name', async () => {
    let capturedPrompt = '';
    const mockLLM = async (prompt) => {
      capturedPrompt = prompt;
      return [
        'sota_name=React',
        'sota_description=Modern UI library',
        'legacy_name=jQuery',
        'legacy_description=Legacy DOM library',
        'confidence=0.85',
        'reasoning=React vs jQuery',
      ].join('\n');
    };

    const result = await discoverPipelineSolutions('  frontend rendering  ', {
      llmCall: mockLLM,
    });

    assert.ok(capturedPrompt.includes('"frontend rendering"'));
    assert.equal(result.capabilityUsed, 'frontend rendering');
  });
});

// ─── Integration: runEnrichedPipeline with solution discovery ────────────

describe('runEnrichedPipeline with solution discovery', () => {
  it('includes discoveredSolutions in pipeline result', async () => {
    // Mock LLM that handles both discovery prompts (Step 2) and
    // properties strategy prompts (Step 3) based on prompt content
    let callCount = 0;
    const mockLLM = async (prompt) => {
      callCount++;
      // Step 2: solution discovery prompt contains "STATE-OF-THE-ART"
      if (prompt.includes('STATE-OF-THE-ART') || prompt.includes('GENERIC CAPABILITY')) {
        return [
          'sota_name=Kubernetes',
          'sota_description=Cloud-native orchestration',
          'legacy_name=Docker Swarm',
          'legacy_description=Legacy orchestration',
          'confidence=0.90',
          'reasoning=Standard choices',
        ].join('\n');
      }
      // Step 3: properties strategy prompt — return 12-property format
      return [
        'Market=3|Widely adopted in the market',
        'Knowledge management=3|Well documented and understood',
        'Market perception=3|Established market presence',
        'User perception=3|Trusted by users',
        'Perception in industry=3|Industry standard',
        'Focus of value=3|ROI and efficiency focused',
        'Understanding=3|Well understood technology',
        'Comparison=3|Easily benchmarked',
        'Failure=3|Predictable failure modes',
        'Market action=3|Competitive market',
        'Efficiency=3|Highly optimized',
        'Decision drivers=3|Data-driven decisions',
      ].join('\n');
    };

    const standardResult = {
      evaluations: {
        'llm-direct': { evolution: 0.55, confidence: 0.80 },
      },
      routing: { usedSolutionStrategies: false },
    };

    const component = {
      name: 'container orchestration',
      capability: 'Orchestrate containers',
      nature: 'activity',
      context: 'Running containers at scale',
    };

    const result = await runEnrichedPipeline(standardResult, component, {
      llmCall: mockLLM,
    });

    assert.equal(result.pipeline, true);
    assert.ok(result.discoveredSolutions);
    assert.equal(result.discoveredSolutions.sota.name, 'Kubernetes');
    assert.equal(result.discoveredSolutions.legacy.name, 'Docker Swarm');
    assert.equal(result.discoveredSolutions.confidence, 0.90);

    // Step 3 evaluates solutions via the 12 Wardley property strategies
    // Both SotA and legacy should have real evolution scores and evaluations
    assert.equal(result.sotaSolution.name, 'Kubernetes');
    assert.ok(result.sotaSolution.evaluations != null, 'SotA should have evaluations object');
    assert.equal(typeof result.sotaSolution.evolution, 'number', 'SotA evolution should be a number');
    assert.ok(result.sotaSolution.evolution > 0 && result.sotaSolution.evolution <= 1, 'SotA evolution should be in (0, 1]');
    assert.ok(result.sotaSolution.confidence > 0, 'SotA confidence should be > 0');
    assert.equal(result.legacySolution.name, 'Docker Swarm');
    assert.ok(result.legacySolution.evaluations != null, 'Legacy should have evaluations object');
    assert.equal(typeof result.legacySolution.evolution, 'number', 'Legacy evolution should be a number');
    assert.ok(result.legacySolution.evolution > 0 && result.legacySolution.evolution <= 1, 'Legacy evolution in (0, 1]');

    // owmOutput is the canonical field name (owm kept for backward compat)
    assert.ok(result.owmOutput, 'owmOutput should be present');
    assert.equal(result.owmOutput, result.owm, 'owmOutput should equal owm');

    // OWM should contain real coordinates, not null placeholders
    assert.ok(result.owm, 'OWM syntax should be present');
    assert.ok(result.owm.includes('Kubernetes'), 'OWM should contain SotA name');
    assert.ok(result.owm.includes('Docker Swarm'), 'OWM should contain legacy name');

    // Validate OWM has 3 positioned inner components with real numeric coordinates
    const innerLines = result.owm.split('\n').filter(l => l.startsWith('    component'));
    assert.equal(innerLines.length, 3, 'OWM should have 3 inner components (anchor, SotA, legacy)');
    for (const line of innerLines) {
      const evoMatch = line.match(/\[([0-9.]+)\]/);
      assert.ok(evoMatch, `Inner component should have [evolution] coordinate: ${line}`);
      const evo = parseFloat(evoMatch[1]);
      assert.ok(evo > 0 && evo <= 1, `Evolution should be a real number in (0,1]: got ${evo}`);
    }

    // Validate outer pipeline component has [visibility, pipeline_min] with real coords
    const outerLine = result.owm.split('\n').find(l => l.startsWith('component'));
    const outerMatch = outerLine.match(/\[([0-9.]+),\s*([0-9.]+)\]/);
    assert.ok(outerMatch, 'Outer component should have [visibility, pipeline_min]');
    const vis = parseFloat(outerMatch[1]);
    const pMin = parseFloat(outerMatch[2]);
    assert.ok(vis > 0 && vis <= 1, `Visibility should be in (0,1]: got ${vis}`);
    assert.ok(pMin >= 0 && pMin <= 1, `Pipeline min should be in [0,1]: got ${pMin}`);
  });

  it('works when llmCall is not provided (graceful degradation)', async () => {
    const standardResult = {
      evaluations: {
        'llm-direct': { evolution: 0.55, confidence: 0.80 },
      },
      routing: { usedSolutionStrategies: false },
    };

    const component = {
      name: 'container orchestration',
      capability: 'Orchestrate containers',
      nature: 'activity',
    };

    const result = await runEnrichedPipeline(standardResult, component, {});

    assert.equal(result.pipeline, true);
    assert.ok(result.capabilityPivot);
    assert.equal(result.sotaSolution, null);
    assert.equal(result.legacySolution, null);
    assert.ok(result.discoveredSolutions);
    assert.equal(result.discoveredSolutions.confidence, 0);
  });

  it('preserves backward compatibility of standardResult', async () => {
    const standardResult = {
      mode: 'oneshot',
      evaluations: {
        'llm-direct': { evolution: 0.55, confidence: 0.80 },
      },
      routing: { usedSolutionStrategies: false },
      classification: { space: 'economic' },
    };

    const component = {
      name: 'data storage',
      nature: 'activity',
    };

    const result = await runEnrichedPipeline(standardResult, component, {});

    assert.equal(result.standardResult, standardResult);
    assert.equal(result.standardResult.mode, 'oneshot');
    assert.deepEqual(result.standardResult.classification, { space: 'economic' });
  });
});
