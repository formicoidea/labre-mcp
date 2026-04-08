// Tests for PropertiesStrategy — evaluates solutions against 12-property phase reference
//
// Covers:
//   - Auto mode: all 12 properties in single LLM call
//   - Conversational mode: one property at a time
//   - Response parsing: full, partial, fuzzy name matching
//   - Aggregation: equal weights, confidence adjustment
//   - Error handling: missing llmCall, unparseable responses
//   - Single property evaluation (external conversational API)
//   - Registry auto-discovery

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PropertiesStrategy,
  parseAutoResponse,
  parseSinglePropertyResponse,
  clearPropertiesCache,
} from './properties-strategy.mjs';
import { SolutionBaseStrategy } from './solution-base-strategy.mjs';
import { BaseStrategy } from '../strategies/base-strategy.mjs';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const PROPERTY_REF = [
  { name: 'Market', phases: { '1': 'Undefined', '2': 'Emerging', '3': 'Growing', '4': 'Mature' } },
  { name: 'Knowledge management', phases: { '1': 'Tacit', '2': 'Emerging', '3': 'Documented', '4': 'Ubiquitous' } },
  { name: 'Market perception', phases: { '1': 'Chaotic', '2': 'Promising', '3': 'Proven', '4': 'Utility' } },
  { name: 'User perception', phases: { '1': 'Novel', '2': 'Growing', '3': 'Expected', '4': 'Invisible' } },
  { name: 'Industry perception', phases: { '1': 'Niche', '2': 'Buzz', '3': 'Standard', '4': 'Commodity' } },
  { name: 'Value focus', phases: { '1': 'Exploration', '2': 'Differentiation', '3': 'Profitability', '4': 'Cost' } },
  { name: 'Understanding', phases: { '1': 'Poorly', '2': 'Growing', '3': 'Well', '4': 'Fully' } },
  { name: 'Comparison', phases: { '1': 'None', '2': 'Emerging', '3': 'Feature', '4': 'Fully comparable' } },
  { name: 'Failure/deficiency', phases: { '1': 'High tolerance', '2': 'Decreasing', '3': 'Low rate', '4': 'Unacceptable' } },
  { name: 'Market action/engagement', phases: { '1': 'Research', '2': 'Custom dev', '3': 'Competition', '4': 'Price wars' } },
  { name: 'Efficiency', phases: { '1': 'Low', '2': 'Improving', '3': 'High', '4': 'Maximum' } },
  { name: 'Decision driver', phases: { '1': 'Vision', '2': 'Learning', '3': 'Analysis', '4': 'Cost' } },
];

/**
 * Generate a mock LLM response with all 12 properties evaluated at a given phase.
 */
function mockAutoResponseAllPhase(phase) {
  return PROPERTY_REF.map(p => `${p.name}=${phase}|Test reason for ${p.name}`).join('\n');
}

/**
 * Generate a mock LLM response for a single property.
 */
function mockSingleResponse(propertyName, phase) {
  return `Based on analysis...\n${propertyName}=${phase}|Test reason`;
}

/**
 * Create a mock llmCall that returns a fixed string.
 */
function createMockLLM(response) {
  return async (prompt) => response;
}

/**
 * Create a mock llmCall that returns different responses per property.
 * Detects auto vs conversational mode: if the prompt mentions multiple
 * properties (auto prompt lists all 12), returns all; otherwise returns
 * only the single property being asked about.
 */
function createPhaseMapLLM(phaseMap) {
  return async (prompt) => {
    // Count how many properties are mentioned in the prompt
    const mentioned = Object.keys(phaseMap).filter(name => prompt.includes(name));

    if (mentioned.length > 1) {
      // Auto mode: prompt contains all property names → return all evaluations
      return Object.entries(phaseMap)
        .map(([name, phase]) => `${name}=${phase}|Mocked reason for ${name}`)
        .join('\n');
    }

    // Conversational mode: return single property response
    for (const [name, phase] of Object.entries(phaseMap)) {
      if (prompt.includes(name)) {
        return `${name}=${phase}|Mocked reason for ${name}`;
      }
    }

    // Fallback
    return Object.entries(phaseMap)
      .map(([name, phase]) => `${name}=${phase}|Mocked reason for ${name}`)
      .join('\n');
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PropertiesStrategy', () => {

  beforeEach(() => {
    clearPropertiesCache();
  });

  describe('constructor', () => {
    it('requires an llmCall function', () => {
      assert.throws(
        () => new PropertiesStrategy(),
        /requires an llmCall function/
      );
    });

    it('requires llmCall to be a function', () => {
      assert.throws(
        () => new PropertiesStrategy({ llmCall: 'not a function' }),
        /requires an llmCall function/
      );
    });

    it('accepts valid options', () => {
      const strategy = new PropertiesStrategy({ llmCall: async () => '' });
      assert.ok(strategy instanceof SolutionBaseStrategy);
      assert.ok(strategy instanceof BaseStrategy);
    });

    it('defaults to auto mode', () => {
      const strategy = new PropertiesStrategy({ llmCall: async () => '' });
      assert.equal(strategy._mode, 'auto');
    });

    it('accepts conversational mode', () => {
      const strategy = new PropertiesStrategy({
        llmCall: async () => '',
        mode: 'conversational',
      });
      assert.equal(strategy._mode, 'conversational');
    });
  });

  describe('static method', () => {
    it('returns solution-properties', () => {
      assert.equal(PropertiesStrategy.method, 'solution-properties');
    });
  });

  describe('evaluate() — auto mode', () => {
    it('evaluates all 12 properties and returns valid EvolutionResult', async () => {
      const mockResponse = mockAutoResponseAllPhase(3);
      const strategy = new PropertiesStrategy({
        llmCall: createMockLLM(mockResponse),
      });

      const result = await strategy.evaluate({ name: 'Kubernetes' });

      // Core EvolutionResult contract
      assert.equal(typeof result.evolution, 'number');
      assert.ok(result.evolution >= 0 && result.evolution <= 1);
      assert.equal(typeof result.confidence, 'number');
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
      assert.equal(result.method, 'solution-properties');

      // Solution-specific extensions
      assert.ok(Array.isArray(result.properties));
      assert.equal(result.properties.length, 12);
      assert.ok(Array.isArray(result.trace));
    });

    it('passes BaseStrategy.validateResult', async () => {
      const mockResponse = mockAutoResponseAllPhase(3);
      const strategy = new PropertiesStrategy({
        llmCall: createMockLLM(mockResponse),
      });

      const result = await strategy.evaluate({ name: 'Kubernetes' });
      assert.doesNotThrow(() => BaseStrategy.validateResult(result));
    });

    it('all phase 1 → evolution near Genesis midpoint (0.09)', async () => {
      const strategy = new PropertiesStrategy({
        llmCall: createMockLLM(mockAutoResponseAllPhase(1)),
      });

      const result = await strategy.evaluate({ name: 'QuantumOS' });
      assert.ok(result.evolution <= 0.15, `Expected Genesis-range evolution, got ${result.evolution}`);
    });

    it('all phase 4 → evolution near Commodity midpoint (0.85)', async () => {
      const strategy = new PropertiesStrategy({
        llmCall: createMockLLM(mockAutoResponseAllPhase(4)),
      });

      const result = await strategy.evaluate({ name: 'TCP/IP' });
      assert.ok(result.evolution >= 0.75, `Expected Commodity-range evolution, got ${result.evolution}`);
    });

    it('all phase 3 → evolution near Product midpoint (0.55)', async () => {
      const strategy = new PropertiesStrategy({
        llmCall: createMockLLM(mockAutoResponseAllPhase(3)),
      });

      const result = await strategy.evaluate({ name: 'Kubernetes' });
      assert.ok(
        result.evolution >= 0.45 && result.evolution <= 0.65,
        `Expected Product-range evolution, got ${result.evolution}`
      );
    });

    it('each property has weight 1/12', async () => {
      const strategy = new PropertiesStrategy({
        llmCall: createMockLLM(mockAutoResponseAllPhase(3)),
      });

      const result = await strategy.evaluate({ name: 'Kubernetes' });
      const expectedWeight = 1 / 12;

      for (const prop of result.properties) {
        assert.ok(
          Math.abs(prop.weight - expectedWeight) < 0.001,
          `Expected weight ~${expectedWeight}, got ${prop.weight} for ${prop.property}`
        );
      }
    });

    it('passes context/description to LLM', async () => {
      let capturedPrompt = '';
      const strategy = new PropertiesStrategy({
        llmCall: async (prompt) => {
          capturedPrompt = prompt;
          return mockAutoResponseAllPhase(3);
        },
      });

      await strategy.evaluate({
        name: 'Salesforce',
        description: 'Cloud CRM platform for enterprise',
      });

      assert.ok(capturedPrompt.includes('Salesforce'));
      assert.ok(capturedPrompt.includes('Cloud CRM platform for enterprise'));
    });

    it('handles partial LLM response (fewer than 12 properties)', async () => {
      const partialResponse = [
        'Market=3|Growing market',
        'Efficiency=4|Maximum efficiency',
        'Understanding=3|Well understood',
      ].join('\n');

      const strategy = new PropertiesStrategy({
        llmCall: createMockLLM(partialResponse),
      });

      const result = await strategy.evaluate({ name: 'Docker' });

      // Should still return a result with 12 properties
      assert.equal(result.properties.length, 12);

      // 3 evaluated + 9 defaulted
      const evaluated = result.properties.filter(p => !p.reason?.includes('defaulted'));
      assert.equal(evaluated.length, 3);

      // Confidence should be lower due to partial evaluation
      assert.ok(result.confidence < 0.85, `Expected lower confidence, got ${result.confidence}`);
    });
  });

  describe('evaluate() — conversational mode', () => {
    it('evaluates properties one at a time', async () => {
      let callCount = 0;
      const strategy = new PropertiesStrategy({
        llmCall: async (prompt) => {
          callCount++;
          // Extract property name from prompt and return a response
          for (const prop of PROPERTY_REF) {
            if (prompt.includes(`"${prop.name}"`)) {
              return mockSingleResponse(prop.name, 3);
            }
          }
          return 'Market=3|Fallback';
        },
        mode: 'conversational',
      });

      const result = await strategy.evaluate({ name: 'SAP ERP' });

      // Should have made 12 separate LLM calls
      assert.equal(callCount, 12);

      assert.equal(typeof result.evolution, 'number');
      assert.equal(result.method, 'solution-properties');
      assert.ok(Array.isArray(result.properties));
    });
  });

  describe('evaluateSingleProperty()', () => {
    it('evaluates a single named property', async () => {
      const strategy = new PropertiesStrategy({
        llmCall: createMockLLM('Market=4|Mature stable market'),
      });

      const propResult = await strategy.evaluateSingleProperty(
        'AWS S3', 'Cloud storage', 'Market'
      );

      assert.ok(propResult);
      assert.equal(propResult.property, 'Market');
      assert.equal(propResult.phase, 4);
      assert.equal(propResult.label, 'Commodity');
      assert.ok(Math.abs(propResult.weight - 1 / 12) < 0.001);
    });

    it('throws for unknown property name', async () => {
      const strategy = new PropertiesStrategy({
        llmCall: createMockLLM(''),
      });

      await assert.rejects(
        () => strategy.evaluateSingleProperty('AWS S3', '', 'NonExistent'),
        /Unknown property "NonExistent"/
      );
    });
  });

  describe('getPropertyNames()', () => {
    it('returns array of 12 property names', async () => {
      const strategy = new PropertiesStrategy({
        llmCall: async () => '',
      });

      const names = await strategy.getPropertyNames();
      assert.ok(Array.isArray(names));
      assert.equal(names.length, 12);
      assert.ok(names.includes('Market'));
      assert.ok(names.includes('Knowledge management'));
      assert.ok(names.includes('Efficiency'));
    });
  });
});

describe('parseAutoResponse()', () => {
  it('parses complete response with all 12 properties', () => {
    const text = PROPERTY_REF.map(p => `${p.name}=3|Reason for ${p.name}`).join('\n');
    const results = parseAutoResponse(text, PROPERTY_REF);

    assert.equal(results.length, 12);
    for (const r of results) {
      assert.equal(r.phase, 3);
      assert.ok(r.reason.startsWith('Reason for'));
    }
  });

  it('ignores non-matching lines and preamble text', () => {
    const text = `
Here is my evaluation of Kubernetes:

Market=3|Growing competitive market
Some analysis text here...
Efficiency=4|Maximum efficiency at scale
`;
    const results = parseAutoResponse(text, PROPERTY_REF);
    assert.equal(results.length, 2);
    assert.equal(results[0].property, 'Market');
    assert.equal(results[1].property, 'Efficiency');
  });

  it('handles variations in spacing', () => {
    const text = 'Market = 3 | Reason with spaces';
    const results = parseAutoResponse(text, PROPERTY_REF);
    assert.equal(results.length, 1);
    assert.equal(results[0].phase, 3);
  });

  it('rejects phases outside 1-4 range', () => {
    const text = 'Market=5|Too high\nEfficiency=0|Too low\nUnderstanding=3|Valid';
    const results = parseAutoResponse(text, PROPERTY_REF);
    assert.equal(results.length, 1);
    assert.equal(results[0].property, 'Understanding');
  });

  it('fuzzy matches property names (case insensitive)', () => {
    const text = 'market=3|Lower case\nKNOWLEDGE MANAGEMENT=2|Upper case';
    const results = parseAutoResponse(text, PROPERTY_REF);
    assert.equal(results.length, 2);
    assert.equal(results[0].property, 'Market');
    assert.equal(results[1].property, 'Knowledge management');
  });

  it('fuzzy matches partial property names', () => {
    const text = 'Knowledge=2|Partial match\nDecision=4|Another partial';
    const results = parseAutoResponse(text, PROPERTY_REF);
    // "Knowledge" should match "Knowledge management"
    // "Decision" should match "Decision drivers"
    assert.ok(results.length >= 2, `Expected >=2 matches, got ${results.length}`);
  });

  it('returns empty array for unparseable response', () => {
    const text = 'This is just random text with no property evaluations.';
    const results = parseAutoResponse(text, PROPERTY_REF);
    assert.equal(results.length, 0);
  });
});

describe('parseSinglePropertyResponse()', () => {
  const marketProp = PROPERTY_REF[0];

  it('parses standard format', () => {
    const text = 'Market=3|Growing competitive market';
    const result = parseSinglePropertyResponse(text, marketProp);
    assert.ok(result);
    assert.equal(result.property, 'Market');
    assert.equal(result.phase, 3);
    assert.equal(result.reason, 'Growing competitive market');
  });

  it('takes last matching line (LLM preamble handling)', () => {
    const text = `
Let me analyze the Market property...

The market for this solution is...

Market=4|Mature and stable market
`;
    const result = parseSinglePropertyResponse(text, marketProp);
    assert.ok(result);
    assert.equal(result.phase, 4);
  });

  it('falls back to phase extraction when format is non-standard', () => {
    const text = 'I would say this is phase 3 for the Market property.';
    const result = parseSinglePropertyResponse(text, marketProp);
    assert.ok(result);
    assert.equal(result.phase, 3);
  });

  it('returns null for completely unparseable response', () => {
    const text = 'I cannot evaluate this property.';
    const result = parseSinglePropertyResponse(text, marketProp);
    assert.equal(result, null);
  });
});

describe('Equal-weight aggregation', () => {
  beforeEach(() => {
    clearPropertiesCache();
  });

  it('mixed phases produce correct weighted average', async () => {
    // 6 properties at phase 3 (evo 0.55) + 6 at phase 4 (evo 0.85)
    // Expected: (6*0.55 + 6*0.85) / 12 = 0.70
    const phaseMap = {};
    const phase3Props = ['Market', 'Knowledge management', 'Market perception',
      'User perception', 'Industry perception', 'Value focus'];
    const phase4Props = ['Understanding', 'Comparison', 'Failure/deficiency',
      'Market action/engagement', 'Efficiency', 'Decision driver'];

    for (const p of phase3Props) phaseMap[p] = 3;
    for (const p of phase4Props) phaseMap[p] = 4;

    const strategy = new PropertiesStrategy({
      llmCall: createPhaseMapLLM(phaseMap),
    });

    const result = await strategy.evaluate({ name: 'TestSolution' });

    assert.ok(
      Math.abs(result.evolution - 0.70) < 0.01,
      `Expected evolution ~0.70 for 6×phase3+6×phase4, got ${result.evolution}`
    );
  });

  it('single phase-4 among phase-3s shifts evolution upward', async () => {
    // 11 properties at phase 3 (evo 0.55) + 1 at phase 4 (evo 0.85)
    // Expected: (11*0.55 + 1*0.85) / 12 = 0.575
    const phaseMap = {};
    for (const p of PROPERTY_REF) phaseMap[p.name] = 3;
    phaseMap['Industry perception'] = 4; // Override one

    const strategy = new PropertiesStrategy({
      llmCall: createPhaseMapLLM(phaseMap),
    });

    const result = await strategy.evaluate({ name: 'Kubernetes' });

    assert.ok(
      Math.abs(result.evolution - 0.575) < 0.01,
      `Expected evolution ~0.575, got ${result.evolution}`
    );
  });

  it('graduated phases aggregate linearly', async () => {
    // Phase 1,1,1,2,2,2,3,3,3,4,4,4 → 3 of each
    // Expected: (3*0.09 + 3*0.29 + 3*0.55 + 3*0.85) / 12
    //         = (0.27 + 0.87 + 1.65 + 2.55) / 12 = 5.34 / 12 = 0.445
    const phases = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4];
    const phaseMap = {};
    PROPERTY_REF.forEach((p, i) => { phaseMap[p.name] = phases[i]; });

    const strategy = new PropertiesStrategy({
      llmCall: createPhaseMapLLM(phaseMap),
    });

    const result = await strategy.evaluate({ name: 'MixedSolution' });

    assert.ok(
      Math.abs(result.evolution - 0.445) < 0.01,
      `Expected evolution ~0.445 for graduated phases, got ${result.evolution}`
    );
  });

  it('each property contributes exactly 1/12 weight regardless of phase', async () => {
    const phaseMap = {};
    for (const p of PROPERTY_REF) phaseMap[p.name] = 3;

    const strategy = new PropertiesStrategy({
      llmCall: createPhaseMapLLM(phaseMap),
    });

    const result = await strategy.evaluate({ name: 'EqualWeightTest' });
    const expectedWeight = 1 / 12;

    for (const prop of result.properties) {
      assert.ok(
        Math.abs(prop.weight - expectedWeight) < 0.0001,
        `Property "${prop.property}" weight should be ${expectedWeight}, got ${prop.weight}`
      );
    }

    // Sum of weights should equal 1.0 (within floating point tolerance)
    const totalWeight = result.properties.reduce((sum, p) => sum + p.weight, 0);
    assert.ok(
      Math.abs(totalWeight - 1.0) < 0.001,
      `Total weight should be ~1.0, got ${totalWeight}`
    );
  });

  it('evolution stays within [0, 1] for all possible phase combinations', async () => {
    // Test extreme: all phase 1 (minimum)
    const strategyMin = new PropertiesStrategy({
      llmCall: createMockLLM(mockAutoResponseAllPhase(1)),
    });
    const rMin = await strategyMin.evaluate({ name: 'MinTest' });
    assert.ok(rMin.evolution >= 0 && rMin.evolution <= 1,
      `Min evolution ${rMin.evolution} out of [0,1]`);
    assert.ok(rMin.evolution <= 0.15,
      `All phase-1 should give evolution ≤ 0.15, got ${rMin.evolution}`);

    // Test extreme: all phase 4 (maximum)
    const strategyMax = new PropertiesStrategy({
      llmCall: createMockLLM(mockAutoResponseAllPhase(4)),
    });
    const rMax = await strategyMax.evaluate({ name: 'MaxTest' });
    assert.ok(rMax.evolution >= 0 && rMax.evolution <= 1,
      `Max evolution ${rMax.evolution} out of [0,1]`);
    assert.ok(rMax.evolution >= 0.75,
      `All phase-4 should give evolution ≥ 0.75, got ${rMax.evolution}`);
  });

  it('confidence reflects evaluation coverage', async () => {
    // Full coverage (12/12 evaluated): highest confidence
    const fullStrategy = new PropertiesStrategy({
      llmCall: createMockLLM(mockAutoResponseAllPhase(3)),
    });
    const fullResult = await fullStrategy.evaluate({ name: 'FullCoverage' });

    // Partial coverage (3/12 evaluated): lower confidence
    const partialResponse = [
      'Market=3|Growing market',
      'Efficiency=4|Maximum efficiency',
      'Understanding=3|Well understood',
    ].join('\n');
    const partialStrategy = new PropertiesStrategy({
      llmCall: createMockLLM(partialResponse),
    });
    const partialResult = await partialStrategy.evaluate({ name: 'PartialCoverage' });

    assert.ok(
      fullResult.confidence > partialResult.confidence,
      `Full coverage confidence (${fullResult.confidence}) should exceed partial (${partialResult.confidence})`
    );
  });
});

describe('Structured result with per-property detail', () => {
  beforeEach(() => {
    clearPropertiesCache();
  });

  it('result includes all 12 properties with complete PropertyEvaluation shape', async () => {
    const strategy = new PropertiesStrategy({
      llmCall: createMockLLM(mockAutoResponseAllPhase(3)),
    });

    const result = await strategy.evaluate({ name: 'Salesforce' });

    assert.equal(result.properties.length, 12);
    for (const prop of result.properties) {
      // Each PropertyEvaluation has required fields
      assert.equal(typeof prop.property, 'string', 'property name must be string');
      assert.ok(prop.property.length > 0, 'property name must be non-empty');
      assert.equal(typeof prop.phase, 'number', 'phase must be number');
      assert.ok(prop.phase >= 1 && prop.phase <= 4, `phase must be 1-4, got ${prop.phase}`);
      assert.equal(typeof prop.label, 'string', 'label must be string');
      assert.ok(['Genesis', 'Custom', 'Product', 'Commodity'].includes(prop.label),
        `label must be a valid phase label, got "${prop.label}"`);
      assert.equal(typeof prop.weight, 'number', 'weight must be number');
    }
  });

  it('result property names match evolution-properties.json reference', async () => {
    const strategy = new PropertiesStrategy({
      llmCall: createMockLLM(mockAutoResponseAllPhase(3)),
    });

    const result = await strategy.evaluate({ name: 'Docker' });
    const resultNames = new Set(result.properties.map(p => p.property));
    const refNames = new Set(PROPERTY_REF.map(p => p.name));

    // Every reference property should appear in the result
    for (const name of refNames) {
      assert.ok(
        resultNames.has(name),
        `Expected property "${name}" in result. Got: ${[...resultNames].join(', ')}`
      );
    }
  });

  it('phase labels match phase numbers correctly', async () => {
    const phaseMap = {
      'Market': 1, 'Knowledge management': 2,
      'Market perception': 3, 'User perception': 4,
      'Industry perception': 1, 'Value focus': 2,
      'Understanding': 3, 'Comparison': 4,
      'Failure/deficiency': 1, 'Market action/engagement': 2,
      'Efficiency': 3, 'Decision driver': 4,
    };
    const expectedLabels = {
      1: 'Genesis', 2: 'Custom', 3: 'Product', 4: 'Commodity',
    };

    const strategy = new PropertiesStrategy({
      llmCall: createPhaseMapLLM(phaseMap),
    });

    const result = await strategy.evaluate({ name: 'LabelTest' });

    for (const prop of result.properties) {
      const expected = expectedLabels[prop.phase];
      assert.equal(
        prop.label, expected,
        `Phase ${prop.phase} for "${prop.property}" should have label "${expected}", got "${prop.label}"`
      );
    }
  });

  it('trace includes load-reference and evaluate-properties steps', async () => {
    const strategy = new PropertiesStrategy({
      llmCall: createMockLLM(mockAutoResponseAllPhase(3)),
    });

    const result = await strategy.evaluate({ name: 'TraceTest' });

    assert.ok(Array.isArray(result.trace), 'trace must be an array');

    // Should include reference loading step
    const loadStep = result.trace.find(t => t.step === 'load-reference');
    assert.ok(loadStep, 'trace must include load-reference step');
    assert.equal(loadStep.propertyCount, 12);

    // Should include evaluation summary step
    const evalStep = result.trace.find(t => t.step === 'evaluate-properties');
    assert.ok(evalStep, 'trace must include evaluate-properties step');
    assert.equal(evalStep.mode, 'auto');
    assert.equal(evalStep.total, 12);

    // Should include per-property results
    const propSteps = result.trace.filter(t => t.step === 'property-result');
    assert.ok(propSteps.length > 0, 'trace must include property-result steps');
    for (const ps of propSteps) {
      assert.equal(typeof ps.property, 'string');
      assert.equal(typeof ps.phase, 'number');
      assert.equal(typeof ps.reason, 'string');
    }
  });

  it('result passes SolutionBaseStrategy.validateSolutionResult', async () => {
    const strategy = new PropertiesStrategy({
      llmCall: createMockLLM(mockAutoResponseAllPhase(3)),
    });

    const result = await strategy.evaluate({ name: 'ValidationTest' });

    // Should not throw — validates both core EvolutionResult and solution extensions
    assert.doesNotThrow(() => SolutionBaseStrategy.validateSolutionResult(result));
  });

  it('properties include reason text from LLM response', async () => {
    const response = PROPERTY_REF
      .map(p => `${p.name}=3|Detailed reason for ${p.name}`)
      .join('\n');

    const strategy = new PropertiesStrategy({
      llmCall: createMockLLM(response),
    });

    const result = await strategy.evaluate({ name: 'ReasonTest' });

    const evaluated = result.properties.filter(p => p.reason && !p.reason.includes('defaulted'));
    for (const prop of evaluated) {
      assert.ok(
        prop.reason.includes('Detailed reason for'),
        `Expected reason with LLM text for "${prop.property}", got: "${prop.reason}"`
      );
    }
  });
});

describe('SolutionBaseStrategy.aggregateProperties() — direct unit tests', () => {
  it('all phase 1 → evolution 0.09', () => {
    const props = Array(12).fill(null).map((_, i) => ({
      property: `P${i}`, phase: 1, label: 'Genesis', weight: 1/12,
    }));
    const { evolution, confidence } = SolutionBaseStrategy.aggregateProperties(props);
    assert.equal(evolution, 0.09);
    assert.equal(confidence, 0.85);
  });

  it('all phase 2 → evolution 0.29', () => {
    const props = Array(12).fill(null).map((_, i) => ({
      property: `P${i}`, phase: 2, label: 'Custom', weight: 1/12,
    }));
    const { evolution } = SolutionBaseStrategy.aggregateProperties(props);
    assert.equal(evolution, 0.29);
  });

  it('all phase 3 → evolution 0.55', () => {
    const props = Array(12).fill(null).map((_, i) => ({
      property: `P${i}`, phase: 3, label: 'Product', weight: 1/12,
    }));
    const { evolution } = SolutionBaseStrategy.aggregateProperties(props);
    assert.equal(evolution, 0.55);
  });

  it('all phase 4 → evolution 0.85', () => {
    const props = Array(12).fill(null).map((_, i) => ({
      property: `P${i}`, phase: 4, label: 'Commodity', weight: 1/12,
    }));
    const { evolution } = SolutionBaseStrategy.aggregateProperties(props);
    assert.equal(evolution, 0.85);
  });

  it('6×phase3 + 6×phase4 → evolution 0.70', () => {
    const props = [];
    for (let i = 0; i < 6; i++) props.push({ property: `P${i}`, phase: 3, label: 'Product', weight: 1/12 });
    for (let i = 6; i < 12; i++) props.push({ property: `P${i}`, phase: 4, label: 'Commodity', weight: 1/12 });
    const { evolution } = SolutionBaseStrategy.aggregateProperties(props);
    assert.equal(evolution, 0.70);
  });

  it('3×each phase → evolution 0.445', () => {
    const phases = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4];
    const labels = { 1: 'Genesis', 2: 'Custom', 3: 'Product', 4: 'Commodity' };
    const props = phases.map((p, i) => ({
      property: `P${i}`, phase: p, label: labels[p], weight: 1/12,
    }));
    const { evolution } = SolutionBaseStrategy.aggregateProperties(props);
    assert.equal(evolution, 0.445);
  });

  it('single property → that phase midpoint', () => {
    const props = [{ property: 'P0', phase: 3, label: 'Product', weight: 1 }];
    const { evolution } = SolutionBaseStrategy.aggregateProperties(props);
    assert.equal(evolution, 0.55);
  });

  it('throws on empty array', () => {
    assert.throws(() => SolutionBaseStrategy.aggregateProperties([]),
      /non-empty array/);
  });

  it('throws on non-array', () => {
    assert.throws(() => SolutionBaseStrategy.aggregateProperties(null),
      /non-empty array/);
  });

  it('coverage-based confidence: full coverage → 0.85', () => {
    const props = Array(12).fill(null).map((_, i) => ({
      property: `P${i}`, phase: 3, label: 'Product', weight: 1/12,
    }));
    const { confidence } = SolutionBaseStrategy.aggregateProperties(props);
    assert.equal(confidence, 0.85);
  });
});

describe('SolutionBaseStrategy.buildPropertyEvaluation()', () => {
  it('builds correct shape with default weight 1/12', () => {
    const pe = SolutionBaseStrategy.buildPropertyEvaluation('Market', 3, 'Test reason');
    assert.deepEqual(pe, {
      property: 'Market',
      phase: 3,
      label: 'Product',
      weight: 1/12,
      reason: 'Test reason',
    });
  });

  it('clamps phase to 1-4 range', () => {
    const low = SolutionBaseStrategy.buildPropertyEvaluation('P', 0, 'too low');
    assert.equal(low.phase, 1);
    const high = SolutionBaseStrategy.buildPropertyEvaluation('P', 5, 'too high');
    assert.equal(high.phase, 4);
  });

  it('omits reason field when not provided', () => {
    const pe = SolutionBaseStrategy.buildPropertyEvaluation('Market', 2);
    assert.ok(!('reason' in pe), 'reason should be omitted when undefined');
  });

  it('labels map correctly to phases', () => {
    assert.equal(SolutionBaseStrategy.buildPropertyEvaluation('P', 1).label, 'Genesis');
    assert.equal(SolutionBaseStrategy.buildPropertyEvaluation('P', 2).label, 'Custom');
    assert.equal(SolutionBaseStrategy.buildPropertyEvaluation('P', 3).label, 'Product');
    assert.equal(SolutionBaseStrategy.buildPropertyEvaluation('P', 4).label, 'Commodity');
  });
});

describe('SolutionBaseStrategy.phaseToEvolution()', () => {
  it('maps phases to correct midpoints', () => {
    assert.equal(SolutionBaseStrategy.phaseToEvolution(1), 0.09);
    assert.equal(SolutionBaseStrategy.phaseToEvolution(2), 0.29);
    assert.equal(SolutionBaseStrategy.phaseToEvolution(3), 0.55);
    assert.equal(SolutionBaseStrategy.phaseToEvolution(4), 0.85);
  });

  it('rounds fractional phases to nearest integer', () => {
    assert.equal(SolutionBaseStrategy.phaseToEvolution(2.6), 0.55); // rounds to 3
    assert.equal(SolutionBaseStrategy.phaseToEvolution(3.4), 0.55); // rounds to 3
  });

  it('throws for phases outside 1-4 range', () => {
    assert.throws(() => SolutionBaseStrategy.phaseToEvolution(0), /between 1 and 4/);
    assert.throws(() => SolutionBaseStrategy.phaseToEvolution(5), /between 1 and 4/);
  });
});

describe('Registry auto-discovery', () => {
  it('PropertiesStrategy is discoverable by registry pattern', async () => {
    // The registry expects files matching *-strategy.mjs
    // properties-strategy.mjs should match
    const { loadSolutionStrategies } = await import('./registry.mjs');
    const strategies = await loadSolutionStrategies();

    assert.ok(
      strategies.has('solution-properties'),
      `Expected registry to contain "solution-properties". Found: ${[...strategies.keys()].join(', ')}`
    );

    const Cls = strategies.get('solution-properties');
    assert.ok(Cls.prototype instanceof SolutionBaseStrategy);
    assert.equal(Cls.method, 'solution-properties');
  });
});
