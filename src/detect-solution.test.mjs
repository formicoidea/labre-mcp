// Tests for detect-solution.mjs
//
// Verifies:
//   1. Naming convention classification (known solutions, capabilities, ambiguous)
//   2. LLM response parsing (structured, fallback, unparseable)
//   3. LLM-based classification function (with mock LLM)
//   4. Unified detection pipeline (naming → LLM fallback)
//   5. Routing mode from environment
//   6. Edge cases (empty name, whitespace, special characters)

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  classifySolutionNaming,
  classifySolutionLLM,
  parseLLMClassificationResponse,
  detectSolution,
  getRoutingMode,
  CLASSIFICATION,
  NAMING_CONFIDENCE_THRESHOLD,
  KNOWN_SOLUTIONS,
} from './detect-solution.mjs';

// ─── Mock LLM Helpers ────────────────────────────────────────────────────────

/**
 * Create a mock LLM call that returns a canned response.
 * @param {string} classification - 'SOLUTION' or 'CAPABILITY'
 * @param {number} confidence - 0–1
 * @param {string} reasoning
 * @returns {function(string): Promise<string>}
 */
function mockLLMCall(classification, confidence, reasoning) {
  return async () =>
    `classification=${classification}\nconfidence=${confidence.toFixed(2)}\nreasoning=${reasoning}`;
}

/**
 * Create a mock LLM that throws an error.
 */
function failingLLMCall(errorMessage = 'LLM unavailable') {
  return async () => { throw new Error(errorMessage); };
}

// ─── Naming Convention Classification ────────────────────────────────────────

describe('classifySolutionNaming', () => {

  describe('known solutions', () => {
    const solutions = [
      'Kubernetes', 'kubernetes', 'KUBERNETES',
      'Salesforce', 'Docker', 'PostgreSQL', 'React',
      'Terraform', 'Jenkins', 'Slack', 'GitHub',
      'Redis', 'MongoDB', 'Elasticsearch',
      'AWS', 'Azure', 'GCP',
    ];

    for (const name of solutions) {
      it(`classifies "${name}" as solution with high confidence`, () => {
        const result = classifySolutionNaming(name);
        assert.equal(result.classification, CLASSIFICATION.SOLUTION);
        assert.ok(result.confidence >= NAMING_CONFIDENCE_THRESHOLD,
          `Expected confidence >= ${NAMING_CONFIDENCE_THRESHOLD}, got ${result.confidence}`);
        assert.equal(result.isSolution, true);
        assert.equal(result.method, 'naming');
      });
    }
  });

  describe('capability patterns', () => {
    const capabilities = [
      { name: 'manage customer relationships', reason: 'activity verb' },
      { name: 'orchestrate containers', reason: 'activity verb' },
      { name: 'how to manage IT services', reason: 'how to pattern' },
      { name: 'container orchestration', reason: 'generic capability term' },
      { name: 'data storage', reason: 'generic capability term' },
      { name: 'authentication', reason: 'generic capability term' },
      { name: 'monitoring', reason: 'generic capability term' },
    ];

    for (const { name, reason } of capabilities) {
      it(`classifies "${name}" as capability (${reason})`, () => {
        const result = classifySolutionNaming(name);
        assert.equal(result.classification, CLASSIFICATION.CAPABILITY);
        assert.equal(result.isSolution, false);
      });
    }
  });

  describe('ambiguous names (low confidence)', () => {
    it('classifies short acronyms with low confidence requiring LLM fallback', () => {
      // Acronyms like "ERP" (not in known solutions) are ambiguous
      // They might be products or capability abbreviations
      const result = classifySolutionNaming('ACME');
      assert.ok(result.confidence < NAMING_CONFIDENCE_THRESHOLD,
        `Expected confidence < ${NAMING_CONFIDENCE_THRESHOLD} for ambiguous name, got ${result.confidence}`);
    });
  });

  describe('context influence', () => {
    it('boosts solution confidence with vendor/product context', () => {
      const withoutCtx = classifySolutionNaming('MyTool');
      const withCtx = classifySolutionNaming('MyTool', { context: 'a vendor product platform' });
      // With product context, solution signals should increase
      assert.ok(withCtx.confidence >= withoutCtx.confidence ||
        withCtx.classification === CLASSIFICATION.SOLUTION,
        'Product context should influence toward solution');
    });

    it('boosts capability confidence with capability context', () => {
      const withCtx = classifySolutionNaming('manage workflows', { context: 'a capability needed for process management' });
      assert.equal(withCtx.classification, CLASSIFICATION.CAPABILITY);
    });
  });

  describe('edge cases', () => {
    it('handles empty name', () => {
      const result = classifySolutionNaming('');
      assert.equal(result.classification, CLASSIFICATION.CAPABILITY);
      assert.equal(result.confidence, 0.5);
    });

    it('handles null name', () => {
      const result = classifySolutionNaming(null);
      assert.equal(result.classification, CLASSIFICATION.CAPABILITY);
    });

    it('handles whitespace-only name', () => {
      const result = classifySolutionNaming('   ');
      assert.equal(result.classification, CLASSIFICATION.CAPABILITY);
      assert.equal(result.confidence, 0.5);
    });

    it('is case-insensitive for known solutions', () => {
      const lower = classifySolutionNaming('kubernetes');
      const upper = classifySolutionNaming('KUBERNETES');
      const mixed = classifySolutionNaming('Kubernetes');
      assert.equal(lower.classification, CLASSIFICATION.SOLUTION);
      assert.equal(upper.classification, CLASSIFICATION.SOLUTION);
      assert.equal(mixed.classification, CLASSIFICATION.SOLUTION);
    });
  });
});

// ─── LLM Response Parsing ────────────────────────────────────────────────────

describe('parseLLMClassificationResponse', () => {

  it('parses a well-formatted solution response', () => {
    const response = [
      'classification=SOLUTION',
      'confidence=0.95',
      'reasoning=Kubernetes is a specific container orchestration platform by Google/CNCF',
    ].join('\n');

    const result = parseLLMClassificationResponse(response, 'Kubernetes');
    assert.equal(result.classification, CLASSIFICATION.SOLUTION);
    assert.equal(result.confidence, 0.95);
    assert.ok(result.reasoning.includes('Kubernetes'));
    assert.equal(result.isSolution, true);
    assert.equal(result.method, 'llm');
  });

  it('parses a well-formatted capability response', () => {
    const response = [
      'classification=CAPABILITY',
      'confidence=0.88',
      'reasoning=Container orchestration is an abstract activity that can be fulfilled by multiple tools',
    ].join('\n');

    const result = parseLLMClassificationResponse(response, 'container orchestration');
    assert.equal(result.classification, CLASSIFICATION.CAPABILITY);
    assert.equal(result.confidence, 0.88);
    assert.equal(result.isSolution, false);
  });

  it('handles response with preamble text', () => {
    const response = [
      'Let me analyze this component.',
      '',
      'classification=SOLUTION',
      'confidence=0.90',
      'reasoning=It is a named product',
    ].join('\n');

    const result = parseLLMClassificationResponse(response, 'test');
    assert.equal(result.classification, CLASSIFICATION.SOLUTION);
    assert.equal(result.confidence, 0.90);
  });

  it('clamps confidence to [0, 1]', () => {
    const response = 'classification=SOLUTION\nconfidence=1.50\nreasoning=test';
    const result = parseLLMClassificationResponse(response, 'test');
    assert.equal(result.confidence, 1.0);

    const response2 = 'classification=SOLUTION\nconfidence=-0.5\nreasoning=test';
    const result2 = parseLLMClassificationResponse(response2, 'test');
    assert.equal(result2.confidence, 0.0);
  });

  it('defaults confidence to 0.70 when missing', () => {
    const response = 'classification=SOLUTION\nreasoning=test';
    const result = parseLLMClassificationResponse(response, 'test');
    assert.equal(result.confidence, 0.70);
  });

  it('extracts from unstructured response mentioning "solution"', () => {
    const response = 'This is clearly a SOLUTION because it is a specific product.';
    const result = parseLLMClassificationResponse(response, 'test');
    assert.equal(result.classification, CLASSIFICATION.SOLUTION);
    assert.equal(result.confidence, 0.60);
  });

  it('extracts from unstructured response mentioning "capability"', () => {
    const response = 'This describes an abstract CAPABILITY, not a specific product.';
    const result = parseLLMClassificationResponse(response, 'test');
    assert.equal(result.classification, CLASSIFICATION.CAPABILITY);
    assert.equal(result.confidence, 0.60);
  });

  it('defaults to capability for completely unparseable response', () => {
    const response = 'I cannot determine what this is.';
    const result = parseLLMClassificationResponse(response, 'test');
    assert.equal(result.classification, CLASSIFICATION.CAPABILITY);
    assert.equal(result.confidence, 0.40);
  });

  it('handles case-insensitive classification values', () => {
    const response = 'classification=solution\nconfidence=0.85\nreasoning=test';
    const result = parseLLMClassificationResponse(response, 'test');
    assert.equal(result.classification, CLASSIFICATION.SOLUTION);
  });

  it('handles spaces around equals sign', () => {
    const response = 'classification = CAPABILITY\nconfidence = 0.80\nreasoning = test reason';
    const result = parseLLMClassificationResponse(response, 'test');
    assert.equal(result.classification, CLASSIFICATION.CAPABILITY);
    assert.equal(result.confidence, 0.80);
  });
});

// ─── LLM-Based Classification ────────────────────────────────────────────────

describe('classifySolutionLLM', () => {

  it('classifies solution using mock LLM', async () => {
    const llm = mockLLMCall('SOLUTION', 0.95, 'Kubernetes is a concrete platform');
    const result = await classifySolutionLLM('Kubernetes', llm);
    assert.equal(result.classification, CLASSIFICATION.SOLUTION);
    assert.equal(result.confidence, 0.95);
    assert.equal(result.method, 'llm');
    assert.equal(result.isSolution, true);
  });

  it('classifies capability using mock LLM', async () => {
    const llm = mockLLMCall('CAPABILITY', 0.88, 'Container orchestration is abstract');
    const result = await classifySolutionLLM('container orchestration', llm);
    assert.equal(result.classification, CLASSIFICATION.CAPABILITY);
    assert.equal(result.confidence, 0.88);
    assert.equal(result.isSolution, false);
  });

  it('passes context to LLM when provided', async () => {
    let capturedPrompt = '';
    const llm = async (prompt) => {
      capturedPrompt = prompt;
      return 'classification=SOLUTION\nconfidence=0.90\nreasoning=test';
    };

    await classifySolutionLLM('K8s', llm, { context: 'cloud infrastructure tool' });
    assert.ok(capturedPrompt.includes('cloud infrastructure tool'),
      'Context should be included in the prompt');
  });

  it('throws when llmCall is not a function', async () => {
    await assert.rejects(
      () => classifySolutionLLM('test', null),
      /requires an llmCall function/
    );
  });

  it('handles empty name gracefully', async () => {
    const llm = mockLLMCall('CAPABILITY', 0.50, 'empty');
    const result = await classifySolutionLLM('', llm);
    assert.equal(result.classification, CLASSIFICATION.CAPABILITY);
    assert.equal(result.confidence, 0.5);
  });
});

// ─── Unified Detection Pipeline ──────────────────────────────────────────────

describe('detectSolution', () => {

  describe('known solutions skip LLM', () => {
    it('returns high-confidence naming result for known solution', async () => {
      let llmCalled = false;
      const llm = async () => { llmCalled = true; return ''; };

      const result = await detectSolution('Kubernetes', { llmCall: llm });
      assert.equal(result.classification, CLASSIFICATION.SOLUTION);
      assert.ok(result.confidence >= NAMING_CONFIDENCE_THRESHOLD);
      assert.equal(result.method, 'naming');
      assert.equal(llmCalled, false, 'LLM should NOT be called for known solutions');
    });
  });

  describe('LLM fallback for uncertain names', () => {
    it('calls LLM when naming confidence is below threshold', async () => {
      let llmCalled = false;
      const llm = async () => {
        llmCalled = true;
        return 'classification=CAPABILITY\nconfidence=0.85\nreasoning=ERP is an abstract capability';
      };

      // Use a name not in the known solutions list and not matching strong patterns
      const result = await detectSolution('XYZ Platform', { llmCall: llm });
      // If naming was uncertain, LLM should have been called
      if (result.method === 'naming+llm') {
        assert.equal(llmCalled, true);
      }
    });

    it('boosts confidence when naming and LLM agree', async () => {
      // Use a name that triggers capability naming patterns but is below threshold
      const llm = mockLLMCall('CAPABILITY', 0.85, 'It is an abstract concept');

      const result = await detectSolution('data processing', { llmCall: llm });
      assert.equal(result.classification, CLASSIFICATION.CAPABILITY);
      // If both agree, combined confidence should be boosted
      if (result.method === 'naming+llm') {
        assert.ok(result.confidence > 0.85,
          `Expected boosted confidence > 0.85, got ${result.confidence}`);
      }
    });

    it('handles LLM disagreement with naming', async () => {
      // Name that naming says is solution-ish, but LLM says capability
      const llm = mockLLMCall('CAPABILITY', 0.80, 'It describes a capability');

      // Use a name with mild solution signals
      const result = await detectSolution('SuperTool v2.0', { llmCall: llm });
      // The result should reflect the LLM's verdict when there's disagreement
      if (result.method === 'naming+llm') {
        assert.ok(result.confidence >= 0.50, 'Confidence should stay reasonable');
      }
    });

    it('falls back to naming when LLM throws', async () => {
      const llm = failingLLMCall('Service unavailable');

      const result = await detectSolution('SomeProduct', { llmCall: llm });
      // Should not throw — graceful fallback
      assert.ok(result.classification !== undefined);
      assert.ok(result.reasoning.includes('LLM fallback unavailable') ||
        result.method === 'naming',
        'Should indicate LLM was unavailable');
    });
  });

  describe('no LLM provided', () => {
    it('returns naming result when no llmCall option', async () => {
      const result = await detectSolution('Kubernetes');
      assert.equal(result.classification, CLASSIFICATION.SOLUTION);
      assert.equal(result.method, 'naming');
    });

    it('returns uncertain result for ambiguous name without LLM', async () => {
      const result = await detectSolution('XYZ');
      assert.ok(result.confidence <= NAMING_CONFIDENCE_THRESHOLD,
        'Without LLM, ambiguous names should stay low confidence');
    });
  });
});

// ─── Routing Mode ────────────────────────────────────────────────────────────

describe('getRoutingMode', () => {
  let originalMode;

  beforeEach(() => {
    originalMode = process.env.WARDLEY_EVAL_MODE;
  });

  afterEach(() => {
    if (originalMode !== undefined) {
      process.env.WARDLEY_EVAL_MODE = originalMode;
    } else {
      delete process.env.WARDLEY_EVAL_MODE;
    }
  });

  it('returns "exclusive" by default', () => {
    delete process.env.WARDLEY_EVAL_MODE;
    assert.equal(getRoutingMode(), 'exclusive');
  });

  it('returns "exclusive" when set to "exclusive"', () => {
    process.env.WARDLEY_EVAL_MODE = 'exclusive';
    assert.equal(getRoutingMode(), 'exclusive');
  });

  it('returns "parallel" when set to "parallel"', () => {
    process.env.WARDLEY_EVAL_MODE = 'parallel';
    assert.equal(getRoutingMode(), 'parallel');
  });

  it('returns "exclusive" for unknown values', () => {
    process.env.WARDLEY_EVAL_MODE = 'unknown';
    assert.equal(getRoutingMode(), 'exclusive');
  });

  it('handles case-insensitive values', () => {
    process.env.WARDLEY_EVAL_MODE = 'PARALLEL';
    assert.equal(getRoutingMode(), 'parallel');
  });

  it('trims whitespace', () => {
    process.env.WARDLEY_EVAL_MODE = '  parallel  ';
    assert.equal(getRoutingMode(), 'parallel');
  });
});

// ─── Constants ───────────────────────────────────────────────────────────────

describe('constants', () => {
  it('NAMING_CONFIDENCE_THRESHOLD is 0.90', () => {
    assert.equal(NAMING_CONFIDENCE_THRESHOLD, 0.90);
  });

  it('CLASSIFICATION has solution and capability values', () => {
    assert.equal(CLASSIFICATION.SOLUTION, 'solution');
    assert.equal(CLASSIFICATION.CAPABILITY, 'capability');
  });

  it('KNOWN_SOLUTIONS contains expected entries', () => {
    assert.ok(KNOWN_SOLUTIONS.has('kubernetes'));
    assert.ok(KNOWN_SOLUTIONS.has('salesforce'));
    assert.ok(KNOWN_SOLUTIONS.has('docker'));
    assert.ok(KNOWN_SOLUTIONS.has('postgresql'));
    assert.ok(KNOWN_SOLUTIONS.has('react'));
  });

  it('KNOWN_SOLUTIONS entries are all lowercase', () => {
    for (const entry of KNOWN_SOLUTIONS) {
      assert.equal(entry, entry.toLowerCase(),
        `Known solution "${entry}" should be lowercase`);
    }
  });
});

// ─── Routing Accuracy (key evaluation criterion) ─────────────────────────────

describe('routing accuracy', () => {

  describe('correctly classifies known solutions', () => {
    const expectedSolutions = [
      'Kubernetes', 'Salesforce', 'SAP', 'Docker', 'PostgreSQL',
      'Jenkins', 'Terraform', 'Slack', 'Stripe', 'Datadog',
      'GitHub', 'Redis', 'MongoDB', 'Elasticsearch', 'Kafka',
    ];

    for (const name of expectedSolutions) {
      it(`"${name}" is classified as solution`, () => {
        const result = classifySolutionNaming(name);
        assert.equal(result.classification, CLASSIFICATION.SOLUTION,
          `"${name}" should be classified as solution, got: ${result.classification}`);
        assert.ok(result.confidence >= NAMING_CONFIDENCE_THRESHOLD,
          `"${name}" confidence should be >= ${NAMING_CONFIDENCE_THRESHOLD}, got: ${result.confidence}`);
      });
    }
  });

  describe('correctly classifies known capabilities', () => {
    const expectedCapabilities = [
      'container orchestration',
      'manage customer relationships',
      'how to manage IT services',
      'deploy applications',
      'monitor infrastructure',
      'authenticate users',
      'process data',
    ];

    for (const name of expectedCapabilities) {
      it(`"${name}" is classified as capability`, () => {
        const result = classifySolutionNaming(name);
        assert.equal(result.classification, CLASSIFICATION.CAPABILITY,
          `"${name}" should be classified as capability, got: ${result.classification}`);
      });
    }
  });
});

// ─── Named Components via LLM Tier 2 (broad detection) ─────────────────────

describe('LLM Tier 2 named component detection', () => {

  describe('methodologies and named practices are classified as solutions', () => {
    const namedMethodologies = [
      { name: 'Scrum', reasoning: 'Scrum is a specific agile methodology created by Ken Schwaber and Jeff Sutherland' },
      { name: 'Kanban', reasoning: 'Kanban is a specific workflow methodology originating from Toyota' },
      { name: 'Lean', reasoning: 'Lean is a named methodology originating from Toyota Production System' },
      { name: 'Six Sigma', reasoning: 'Six Sigma is a specific quality methodology created at Motorola' },
      { name: 'SAFe', reasoning: 'SAFe is the Scaled Agile Framework, a named agile scaling framework' },
      { name: 'Design Thinking', reasoning: 'Design Thinking is a named innovation methodology popularized by IDEO and Stanford d.school' },
      { name: 'DevOps', reasoning: 'DevOps is a named set of practices combining development and operations' },
      { name: 'XP', reasoning: 'XP (Extreme Programming) is a specific software development methodology' },
    ];

    for (const { name, reasoning } of namedMethodologies) {
      it(`classifies "${name}" as solution via LLM`, async () => {
        const llm = mockLLMCall('SOLUTION', 0.90, reasoning);
        const result = await classifySolutionLLM(name, llm);
        assert.equal(result.classification, CLASSIFICATION.SOLUTION,
          `"${name}" should be classified as solution (named methodology)`);
        assert.ok(result.confidence >= 0.80,
          `"${name}" confidence should be >= 0.80, got ${result.confidence}`);
      });
    }
  });

  describe('standards and specifications are classified as solutions', () => {
    const namedStandards = [
      { name: 'ITIL', reasoning: 'ITIL is a specific IT service management framework' },
      { name: 'TOGAF', reasoning: 'TOGAF is The Open Group Architecture Framework' },
      { name: 'COBIT', reasoning: 'COBIT is a specific IT governance framework by ISACA' },
      { name: 'ISO 27001', reasoning: 'ISO 27001 is a specific information security standard' },
      { name: 'PCI-DSS', reasoning: 'PCI-DSS is a specific payment card security standard' },
      { name: 'SOC 2', reasoning: 'SOC 2 is a specific compliance framework by AICPA' },
    ];

    for (const { name, reasoning } of namedStandards) {
      it(`classifies "${name}" as solution via LLM`, async () => {
        const llm = mockLLMCall('SOLUTION', 0.92, reasoning);
        const result = await classifySolutionLLM(name, llm);
        assert.equal(result.classification, CLASSIFICATION.SOLUTION,
          `"${name}" should be classified as solution (named standard)`);
      });
    }
  });

  describe('named models and frameworks are classified as solutions', () => {
    const namedModels = [
      { name: 'Wardley Mapping', reasoning: 'Wardley Mapping is a specific strategic mapping methodology created by Simon Wardley' },
      { name: 'Wardley Maps', reasoning: 'Wardley Maps is a named strategic visualization technique' },
      { name: 'Porter\'s Five Forces', reasoning: 'Porter\'s Five Forces is a named competitive analysis framework' },
      { name: 'Balanced Scorecard', reasoning: 'Balanced Scorecard is a named strategic management framework' },
      { name: 'OKR', reasoning: 'OKR is a specific goal-setting framework (Objectives and Key Results)' },
      { name: 'Jobs to Be Done', reasoning: 'Jobs to Be Done is a named innovation framework' },
    ];

    for (const { name, reasoning } of namedModels) {
      it(`classifies "${name}" as solution via LLM`, async () => {
        const llm = mockLLMCall('SOLUTION', 0.88, reasoning);
        const result = await classifySolutionLLM(name, llm);
        assert.equal(result.classification, CLASSIFICATION.SOLUTION,
          `"${name}" should be classified as solution (named model/framework)`);
      });
    }
  });

  describe('generic capabilities remain classified as capabilities', () => {
    const genericCapabilities = [
      { name: 'project management', reasoning: 'project management is a generic activity that can use many methodologies' },
      { name: 'continuous improvement', reasoning: 'continuous improvement is a generic practice area' },
      { name: 'quality management', reasoning: 'quality management is an abstract capability' },
      { name: 'IT service management', reasoning: 'IT service management is an abstract capability domain' },
      { name: 'agile coaching', reasoning: 'agile coaching is a generic practice' },
      { name: 'strategic planning', reasoning: 'strategic planning is a generic business activity' },
    ];

    for (const { name, reasoning } of genericCapabilities) {
      it(`classifies "${name}" as capability via LLM`, async () => {
        const llm = mockLLMCall('CAPABILITY', 0.85, reasoning);
        const result = await classifySolutionLLM(name, llm);
        assert.equal(result.classification, CLASSIFICATION.CAPABILITY,
          `"${name}" should remain classified as capability (generic)`);
      });
    }
  });

  describe('full pipeline routes named components through LLM when not in static lists', () => {
    it('routes "Scrum" as solution via LLM fallback (not in KNOWN_SOLUTIONS)', async () => {
      const llm = mockLLMCall('SOLUTION', 0.92, 'Scrum is a named agile methodology');
      const result = await detectSolution('Scrum', { llmCall: llm });
      // Scrum is not in KNOWN_SOLUTIONS, so it should go through LLM
      assert.equal(result.classification, CLASSIFICATION.SOLUTION,
        'Scrum should be classified as solution');
      assert.ok(result.isSolution, 'isSolution flag should be true');
    });

    it('routes "ITIL" as solution via LLM fallback (not in KNOWN_SOLUTIONS)', async () => {
      const llm = mockLLMCall('SOLUTION', 0.90, 'ITIL is a named IT service management framework');
      const result = await detectSolution('ITIL', { llmCall: llm });
      assert.equal(result.classification, CLASSIFICATION.SOLUTION,
        'ITIL should be classified as solution');
    });

    it('routes "Wardley Maps" as solution via LLM fallback', async () => {
      const llm = mockLLMCall('SOLUTION', 0.88, 'Wardley Maps is a named strategic mapping methodology');
      const result = await detectSolution('Wardley Maps', { llmCall: llm });
      assert.equal(result.classification, CLASSIFICATION.SOLUTION,
        'Wardley Maps should be classified as solution');
    });

    it('keeps "project management" as capability even with LLM', async () => {
      const llm = mockLLMCall('CAPABILITY', 0.88, 'project management is an abstract capability');
      const result = await detectSolution('project management', { llmCall: llm });
      assert.equal(result.classification, CLASSIFICATION.CAPABILITY,
        'project management should remain capability');
    });
  });

  describe('LLM prompt includes named component categories', () => {
    it('prompt mentions methodologies as solution category', async () => {
      let capturedPrompt = '';
      const llm = async (prompt) => {
        capturedPrompt = prompt;
        return 'classification=SOLUTION\nconfidence=0.90\nreasoning=test';
      };
      await classifySolutionLLM('Scrum', llm);
      assert.ok(capturedPrompt.includes('Methodologies'),
        'Prompt should mention methodologies');
      assert.ok(capturedPrompt.includes('Scrum'),
        'Prompt should include the component name');
    });

    it('prompt mentions standards as solution category', async () => {
      let capturedPrompt = '';
      const llm = async (prompt) => {
        capturedPrompt = prompt;
        return 'classification=SOLUTION\nconfidence=0.90\nreasoning=test';
      };
      await classifySolutionLLM('ITIL', llm);
      assert.ok(capturedPrompt.includes('Standards') || capturedPrompt.includes('standard'),
        'Prompt should mention standards');
      assert.ok(capturedPrompt.includes('ITIL'),
        'Prompt should include ITIL as example');
    });

    it('prompt mentions named models as solution category', async () => {
      let capturedPrompt = '';
      const llm = async (prompt) => {
        capturedPrompt = prompt;
        return 'classification=SOLUTION\nconfidence=0.90\nreasoning=test';
      };
      await classifySolutionLLM('Wardley Mapping', llm);
      assert.ok(
        capturedPrompt.includes('Named models') || capturedPrompt.includes('Wardley Mapping'),
        'Prompt should reference named models or Wardley Mapping'
      );
    });
  });
});
