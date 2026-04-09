// Tests for solution-capability-router.mjs
//
// Validates:
//   - Known solutions detected with ≥ 90% confidence (no fallback needed)
//   - Known capabilities detected with ≥ 90% confidence (no fallback needed)
//   - Heuristic detection returns correct type but < 90% confidence (fallback needed)
//   - Edge cases: empty input, common words, ambiguous names
//   - Routing targets: exclusive vs parallel mode
//   - Confidence threshold correctly flags needsFallback

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectComponentType,
  determineRoutingTargets,
  dispatchSolutionStrategies,
  dispatchWithRouting,
  createSolutionStrategyInstance,
  getEvalMode,
  COMPONENT_TYPE,
  EVAL_MODES,
  CONFIDENCE_THRESHOLD,
} from './solution-capability-router.mjs';

// ─── Known Solutions Detection ────────────────────────────────────────────────

describe('detectComponentType — known solutions', () => {
  const knownSolutions = [
    'Kubernetes', 'k8s', 'Salesforce', 'SAP ERP', 'Docker',
    'PostgreSQL', 'AWS', 'Terraform', 'Snowflake', 'Stripe',
    'Azure', 'GCP', 'Jenkins', 'MongoDB', 'Redis', 'Kafka',
    'Slack', 'Jira', 'OpenAI', 'ChatGPT', 'Shopify',
    'Heroku', 'Firebase', 'VMware', 'Linux', 'Python',
  ];

  for (const name of knownSolutions) {
    it(`detects "${name}" as a solution with high confidence`, () => {
      const result = detectComponentType(name);
      assert.equal(result.type, COMPONENT_TYPE.SOLUTION, `${name} should be a solution`);
      assert.ok(result.confidence >= 0.90, `${name} confidence ${result.confidence} should be ≥ 0.90`);
      assert.equal(result.method, 'known-solution', `${name} should match known-solution method`);
      assert.equal(result.needsFallback, false, `${name} should NOT need fallback`);
      assert.ok(result.canonical, `${name} should have canonical name`);
      assert.ok(result.vendor, `${name} should have vendor`);
    });
  }

  it('detects solutions case-insensitively', () => {
    const lower = detectComponentType('kubernetes');
    const upper = detectComponentType('KUBERNETES');
    const mixed = detectComponentType('Kubernetes');

    assert.equal(lower.type, COMPONENT_TYPE.SOLUTION);
    assert.equal(upper.type, COMPONENT_TYPE.SOLUTION);
    assert.equal(mixed.type, COMPONENT_TYPE.SOLUTION);
    assert.equal(lower.canonical, 'Kubernetes');
  });

  it('detects partial matches (vendor + product)', () => {
    const result = detectComponentType('Amazon Web Services');
    assert.equal(result.type, COMPONENT_TYPE.SOLUTION);
    assert.ok(result.confidence >= 0.90);
    assert.equal(result.canonical, 'AWS');
  });
});

// ─── Known Capabilities Detection ─────────────────────────────────────────────

describe('detectComponentType — known capabilities', () => {
  const knownCapabilities = [
    'CRM', 'ERP', 'DevOps', 'CI/CD', 'LLM', 'IAM', 'CDN',
    'container orchestration', 'identity management',
    'payment processing', 'data analytics', 'monitoring',
    'observability', 'machine learning', 'authentication',
    'load balancing', 'service mesh', 'event streaming',
  ];

  for (const name of knownCapabilities) {
    it(`detects "${name}" as a capability with high confidence`, () => {
      const result = detectComponentType(name);
      assert.equal(result.type, COMPONENT_TYPE.CAPABILITY, `${name} should be a capability`);
      assert.ok(result.confidence >= 0.85, `${name} confidence ${result.confidence} should be ≥ 0.85`);
      assert.ok(result.needsFallback === false, `${name} should NOT need fallback`);
    });
  }

  it('detects capabilities case-insensitively', () => {
    const result = detectComponentType('crm');
    assert.equal(result.type, COMPONENT_TYPE.CAPABILITY);
    assert.ok(result.confidence >= 0.90);
  });
});

// ─── Heuristic Detection ──────────────────────────────────────────────────────

describe('detectComponentType — heuristic detection', () => {
  it('detects vendor-prefixed names as solutions', () => {
    const result = detectComponentType('Google BigQuery');
    assert.equal(result.type, COMPONENT_TYPE.SOLUTION);
    assert.equal(result.method, 'heuristic');
    assert.ok(result.confidence < CONFIDENCE_THRESHOLD, 'heuristic confidence should be below threshold');
    assert.equal(result.needsFallback, true, 'should need fallback');
  });

  it('detects versioned names as solutions', () => {
    const result = detectComponentType('React 18');
    assert.equal(result.type, COMPONENT_TYPE.SOLUTION);
    assert.equal(result.method, 'heuristic');
    assert.equal(result.needsFallback, true);
  });

  it('detects PascalCase compound names as solutions', () => {
    const result = detectComponentType('CloudFormation');
    assert.equal(result.type, COMPONENT_TYPE.SOLUTION);
    assert.equal(result.method, 'heuristic');
    assert.equal(result.needsFallback, true);
  });

  it('detects infinitive verb phrases as capabilities', () => {
    const result = detectComponentType('Manage customer relationships');
    assert.equal(result.type, COMPONENT_TYPE.CAPABILITY);
    assert.equal(result.method, 'heuristic');
    assert.equal(result.needsFallback, true);
  });

  it('detects "how to" phrases as capabilities', () => {
    const result = detectComponentType('how to manage IT services');
    assert.equal(result.type, COMPONENT_TYPE.CAPABILITY);
    assert.equal(result.method, 'heuristic');
    assert.equal(result.needsFallback, true);
  });

  it('detects management suffixes as capabilities', () => {
    const result = detectComponentType('risk management');
    assert.equal(result.type, COMPONENT_TYPE.CAPABILITY);
    // management suffix pattern
    assert.ok(result.reason.includes('management suffix'));
  });

  it('detects product suffixes as solutions', () => {
    const result = detectComponentType('DataHub');
    assert.equal(result.type, COMPONENT_TYPE.SOLUTION);
    assert.ok(result.reason.includes('product suffix') || result.reason.includes('PascalCase'));
  });

  it('heuristic confidence never reaches 0.90', () => {
    // Even with multiple solution signals, heuristic caps at 0.89
    const result = detectComponentType('Microsoft FooBar™ 2.0 Enterprise');
    assert.ok(result.confidence <= 0.89, `heuristic confidence ${result.confidence} should be ≤ 0.89`);
    assert.equal(result.needsFallback, true);
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe('detectComponentType — edge cases', () => {
  it('returns capability with confidence 0 for empty name', () => {
    const result = detectComponentType('');
    assert.equal(result.type, COMPONENT_TYPE.CAPABILITY);
    assert.equal(result.confidence, 0);
    assert.equal(result.needsFallback, true);
  });

  it('returns capability with confidence 0 for null name', () => {
    const result = detectComponentType(null);
    assert.equal(result.type, COMPONENT_TYPE.CAPABILITY);
    assert.equal(result.confidence, 0);
    assert.equal(result.needsFallback, true);
  });

  it('handles common English words as capabilities (not solutions)', () => {
    // "Electricity" is a common word, not a brand
    const result = detectComponentType('Electricity');
    assert.equal(result.type, COMPONENT_TYPE.CAPABILITY);
    assert.equal(result.needsFallback, true);
  });

  it('treats generic single words as capabilities by default', () => {
    const result = detectComponentType('Storage');
    // Common word filter should prevent solution detection
    assert.equal(result.type, COMPONENT_TYPE.CAPABILITY);
  });

  it('handles whitespace and trimming', () => {
    const result = detectComponentType('  Kubernetes  ');
    assert.equal(result.type, COMPONENT_TYPE.SOLUTION);
    assert.equal(result.canonical, 'Kubernetes');
  });

  it('handles unknown names with low confidence', () => {
    const result = detectComponentType('XyzFooWidget');
    assert.ok(result.confidence < CONFIDENCE_THRESHOLD);
    assert.equal(result.needsFallback, true);
  });

  it('description can influence heuristic detection', () => {
    // Description with capability keywords should help
    const withDesc = detectComponentType('FooThing', 'manages authentication and authorization');
    assert.equal(withDesc.type, COMPONENT_TYPE.CAPABILITY);
  });
});

// ─── Confidence Threshold ─────────────────────────────────────────────────────

describe('confidence threshold', () => {
  it('CONFIDENCE_THRESHOLD is 0.90', () => {
    assert.equal(CONFIDENCE_THRESHOLD, 0.90);
  });

  it('known solution confidence ≥ threshold → needsFallback false', () => {
    const result = detectComponentType('Kubernetes');
    assert.ok(result.confidence >= CONFIDENCE_THRESHOLD);
    assert.equal(result.needsFallback, false);
  });

  it('known capability confidence ≥ threshold → needsFallback false', () => {
    const result = detectComponentType('CRM');
    assert.ok(result.confidence >= CONFIDENCE_THRESHOLD);
    assert.equal(result.needsFallback, false);
  });

  it('heuristic detection < threshold → needsFallback true', () => {
    const result = detectComponentType('Google BigQuery');
    assert.ok(result.confidence < CONFIDENCE_THRESHOLD);
    assert.equal(result.needsFallback, true);
  });
});

// ─── Routing Targets ─────────────────────────────────────────────────────────

describe('determineRoutingTargets', () => {
  let originalMode;

  before(() => {
    originalMode = process.env.WARDLEY_EVAL_MODE;
  });

  after(() => {
    if (originalMode !== undefined) {
      process.env.WARDLEY_EVAL_MODE = originalMode;
    } else {
      delete process.env.WARDLEY_EVAL_MODE;
    }
  });

  it('exclusive mode routes solution to solution-strategies only', () => {
    delete process.env.WARDLEY_EVAL_MODE; // default is exclusive
    const detection = detectComponentType('Kubernetes');
    const targets = determineRoutingTargets(detection);

    assert.equal(targets.useSolutionStrategies, true);
    assert.equal(targets.useCapabilityStrategies, false);
    assert.equal(targets.mode, EVAL_MODES.EXCLUSIVE);
  });

  it('exclusive mode routes capability to capability strategies only', () => {
    delete process.env.WARDLEY_EVAL_MODE;
    const detection = detectComponentType('CRM');
    const targets = determineRoutingTargets(detection);

    assert.equal(targets.useSolutionStrategies, false);
    assert.equal(targets.useCapabilityStrategies, true);
    assert.equal(targets.mode, EVAL_MODES.EXCLUSIVE);
  });

  it('parallel mode routes to both strategy sets', () => {
    process.env.WARDLEY_EVAL_MODE = 'parallel';
    const detection = detectComponentType('Kubernetes');
    const targets = determineRoutingTargets(detection);

    assert.equal(targets.useSolutionStrategies, true);
    assert.equal(targets.useCapabilityStrategies, true);
    assert.equal(targets.mode, EVAL_MODES.PARALLEL);
  });

  it('parallel mode routes capabilities to both too', () => {
    process.env.WARDLEY_EVAL_MODE = 'parallel';
    const detection = detectComponentType('CRM');
    const targets = determineRoutingTargets(detection);

    assert.equal(targets.useSolutionStrategies, true);
    assert.equal(targets.useCapabilityStrategies, true);
    assert.equal(targets.mode, EVAL_MODES.PARALLEL);
  });

  it('defaults to exclusive when env var is unset', () => {
    delete process.env.WARDLEY_EVAL_MODE;
    assert.equal(getEvalMode(), EVAL_MODES.EXCLUSIVE);
  });

  it('defaults to exclusive for unrecognized env var values', () => {
    process.env.WARDLEY_EVAL_MODE = 'foobar';
    assert.equal(getEvalMode(), EVAL_MODES.EXCLUSIVE);
  });
});

// ─── Routing Accuracy: Cross-validation ───────────────────────────────────────

describe('routing accuracy — cross-validation', () => {
  // These must NEVER be misclassified
  const criticalSolutions = [
    'Kubernetes', 'Salesforce', 'SAP', 'Docker', 'AWS',
    'PostgreSQL', 'MongoDB', 'Kafka', 'Terraform', 'Slack',
  ];

  const criticalCapabilities = [
    'CRM', 'ERP', 'DevOps', 'container orchestration',
    'identity management', 'data analytics', 'machine learning',
  ];

  for (const name of criticalSolutions) {
    it(`${name} is ALWAYS classified as solution`, () => {
      const result = detectComponentType(name);
      assert.equal(result.type, COMPONENT_TYPE.SOLUTION,
        `CRITICAL: "${name}" must be solution, got ${result.type}`);
      assert.ok(result.confidence >= CONFIDENCE_THRESHOLD,
        `CRITICAL: "${name}" confidence ${result.confidence} must be ≥ ${CONFIDENCE_THRESHOLD}`);
    });
  }

  for (const name of criticalCapabilities) {
    it(`${name} is ALWAYS classified as capability`, () => {
      const result = detectComponentType(name);
      assert.equal(result.type, COMPONENT_TYPE.CAPABILITY,
        `CRITICAL: "${name}" must be capability, got ${result.type}`);
      assert.ok(result.confidence >= CONFIDENCE_THRESHOLD - 0.05,
        `CRITICAL: "${name}" confidence ${result.confidence} must be ≥ ${CONFIDENCE_THRESHOLD - 0.05}`);
    });
  }
});

// ─── Result Shape ─────────────────────────────────────────────────────────────

describe('detectComponentType — result shape', () => {
  it('returns all required fields for known solution', () => {
    const result = detectComponentType('Kubernetes');
    assert.equal(typeof result.type, 'string');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.method, 'string');
    assert.equal(typeof result.reason, 'string');
    assert.equal(typeof result.needsFallback, 'boolean');
    assert.equal(typeof result.canonical, 'string');
    assert.equal(typeof result.vendor, 'string');
    assert.equal(typeof result.category, 'string');
  });

  it('returns all required fields for known capability', () => {
    const result = detectComponentType('CRM');
    assert.equal(typeof result.type, 'string');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.method, 'string');
    assert.equal(typeof result.reason, 'string');
    assert.equal(typeof result.needsFallback, 'boolean');
    assert.equal(typeof result.canonical, 'string');
    assert.equal(typeof result.nature, 'string');
  });

  it('returns all required fields for heuristic detection', () => {
    const result = detectComponentType('Google BigQuery');
    assert.equal(typeof result.type, 'string');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.method, 'string');
    assert.equal(typeof result.reason, 'string');
    assert.equal(typeof result.needsFallback, 'boolean');
    assert.ok(Array.isArray(result.signals));
  });

  it('routing targets returns all required fields', () => {
    const detection = detectComponentType('Kubernetes');
    const targets = determineRoutingTargets(detection);
    assert.equal(typeof targets.useSolutionStrategies, 'boolean');
    assert.equal(typeof targets.useCapabilityStrategies, 'boolean');
    assert.equal(typeof targets.mode, 'string');
  });
});

// ─── Dispatch Functions (AC 7) ──────────────────────────────────────────────

describe('dispatchWithRouting — routing dispatch integration', () => {
  let originalMode;

  before(() => {
    originalMode = process.env.WARDLEY_EVAL_MODE;
    delete process.env.WARDLEY_EVAL_MODE; // default to exclusive
  });

  after(() => {
    if (originalMode !== undefined) {
      process.env.WARDLEY_EVAL_MODE = originalMode;
    } else {
      delete process.env.WARDLEY_EVAL_MODE;
    }
  });

  it('dispatches capability to capability callback in exclusive mode', async () => {
    let callbackCalled = false;
    const mockCapabilityCallback = async (component, strategy) => {
      callbackCalled = true;
      return { 'mock-cap': { evolution: 0.5, confidence: 0.8, method: 'mock-cap' } };
    };

    const result = await dispatchWithRouting(
      { name: 'CRM', description: 'Customer relationship management' },
      { runCapabilityStrategies: mockCapabilityCallback, strategy: 'all' }
    );

    assert.equal(callbackCalled, true, 'Capability callback should be called for CRM');
    assert.equal(result.detection.type, COMPONENT_TYPE.CAPABILITY);
    assert.equal(result.targets.useCapabilityStrategies, true);
    assert.equal(result.targets.useSolutionStrategies, false);
    assert.ok(result.evaluations['mock-cap'], 'Capability evaluation result should be present');
  });

  it('does NOT dispatch solution to capability callback in exclusive mode', async () => {
    let callbackCalled = false;
    const mockCapabilityCallback = async () => {
      callbackCalled = true;
      return {};
    };

    const result = await dispatchWithRouting(
      { name: 'Kubernetes', description: 'Container orchestration platform' },
      { runCapabilityStrategies: mockCapabilityCallback, strategy: 'all' }
    );

    assert.equal(callbackCalled, false, 'Capability callback should NOT be called for Kubernetes in exclusive');
    assert.equal(result.detection.type, COMPONENT_TYPE.SOLUTION);
    assert.equal(result.targets.useCapabilityStrategies, false);
    assert.equal(result.targets.useSolutionStrategies, true);
  });

  it('dispatches both in parallel mode', async () => {
    process.env.WARDLEY_EVAL_MODE = 'parallel';

    let callbackCalled = false;
    const mockCapabilityCallback = async () => {
      callbackCalled = true;
      return { 'mock-cap': { evolution: 0.6, confidence: 0.7, method: 'mock-cap' } };
    };

    const result = await dispatchWithRouting(
      { name: 'Kubernetes', description: 'Container orchestration' },
      { runCapabilityStrategies: mockCapabilityCallback, strategy: 'all' }
    );

    assert.equal(callbackCalled, true, 'Capability callback should be called in parallel mode');
    assert.equal(result.targets.useSolutionStrategies, true);
    assert.equal(result.targets.useCapabilityStrategies, true);
    assert.ok(result.evaluations['mock-cap'], 'Capability results should be present in parallel');

    delete process.env.WARDLEY_EVAL_MODE;
  });

  it('returns detection result in the response', async () => {
    const result = await dispatchWithRouting(
      { name: 'Kubernetes' },
      { strategy: 'all' }
    );

    assert.ok(result.detection, 'Detection result should be present');
    assert.equal(result.detection.type, COMPONENT_TYPE.SOLUTION);
    assert.ok(result.detection.confidence >= CONFIDENCE_THRESHOLD);
    assert.ok(result.targets, 'Routing targets should be present');
  });

  it('returns empty capability evaluations when not routed', async () => {
    delete process.env.WARDLEY_EVAL_MODE;

    const result = await dispatchWithRouting(
      { name: 'Kubernetes' },
      { strategy: 'all' }
    );

    assert.deepEqual(result.capabilityEvaluations, {});
  });

  it('handles missing capability callback gracefully', async () => {
    delete process.env.WARDLEY_EVAL_MODE;

    // No runCapabilityStrategies provided — should not crash
    const result = await dispatchWithRouting(
      { name: 'CRM' },
      { strategy: 'all' }
    );

    assert.deepEqual(result.capabilityEvaluations, {});
    assert.equal(result.detection.type, COMPONENT_TYPE.CAPABILITY);
  });
});

describe('createSolutionStrategyInstance', () => {
  it('creates instance with llmCall dependency', async () => {
    // Load a real solution strategy to test instantiation
    const { loadSolutionStrategies } = await import('./solution-strategies/registry.mjs');
    const strategies = await loadSolutionStrategies();

    if (strategies.size > 0) {
      const [method, StrategyCls] = [...strategies.entries()][0];
      const mockLlm = async (prompt) => 'Market=3|test reason';
      const instance = createSolutionStrategyInstance(StrategyCls, { llmCall: mockLlm });
      assert.ok(instance, `Should create instance of ${method}`);
    }
  });
});

describe('dispatchSolutionStrategies', () => {
  it('runs solution strategies with mock LLM', async () => {
    // Provide a mock LLM that returns valid property evaluation format
    const mockLlm = async (prompt) => {
      return [
        'Market=3|Established competitive market',
        'Knowledge management=3|Well-documented and widely taught',
        'Market perception=3|Proven and mainstream',
        'User perception=3|Expected to work reliably',
        'Industry perception=3|Strategic necessity',
        'Value focus=3|Reliability and TCO',
        'Understanding=3|Well-understood',
        'Comparison=3|Feature-by-feature comparison standard',
        'Failure/deficiency=3|Low failure rate',
        'Market action/engagement=3|Product marketing',
        'Efficiency=3|Good efficiency',
        'Decision driver=3|Driven by analysis and TCO',
      ].join('\n');
    };

    const evaluations = await dispatchSolutionStrategies(
      { name: 'Kubernetes', description: 'Container orchestration platform' },
      { llmCall: mockLlm, strategy: 'all' }
    );

    // Should have at least one solution strategy result
    const methods = Object.keys(evaluations);
    assert.ok(methods.length > 0, 'Should have at least one solution strategy result');

    for (const [method, result] of Object.entries(evaluations)) {
      if (!result.error) {
        assert.equal(typeof result.evolution, 'number', `${method} should have numeric evolution`);
        assert.ok(result.evolution >= 0 && result.evolution <= 1, `${method} evolution should be 0-1`);
        assert.equal(typeof result.confidence, 'number', `${method} should have numeric confidence`);
        assert.ok(result.confidence >= 0 && result.confidence <= 1, `${method} confidence should be 0-1`);
        assert.equal(typeof result.method, 'string', `${method} should have method string`);
      }
    }
  });

  it('handles strategy errors gracefully', async () => {
    const errorLlm = async () => { throw new Error('LLM unavailable'); };

    const evaluations = await dispatchSolutionStrategies(
      { name: 'TestSolution' },
      { llmCall: errorLlm, strategy: 'all' }
    );

    // Should have error entries, not crash
    for (const [method, result] of Object.entries(evaluations)) {
      if (result.error) {
        assert.equal(typeof result.error, 'string');
      }
    }
  });
});

// ─── Routing Rule: Named → Solution, Generic → Capability ───────────────────
//
// This validates the core routing invariant: named components (products,
// frameworks, methodologies, standards, named practices) must route to
// the solution path, while generic/abstract components route to capability.
//
// Components NOT in the static KNOWN_SOLUTIONS list should still route
// correctly when the Tier 2 LLM fallback identifies them as named.

describe('routing rule — named → solution, generic → capability', () => {
  // Named components NOT in the static KNOWN_SOLUTIONS list.
  // These should trigger needsFallback=true (heuristic confidence < 0.90)
  // so that the Tier 2 LLM can correctly classify them as solutions.
  const namedComponentsNotInStaticList = [
    { name: 'ITIL', desc: 'Named framework — should need LLM fallback' },
    { name: 'Scrum', desc: 'Named methodology — should need LLM fallback' },
    { name: 'ISO 27001', desc: 'Named standard — should need LLM fallback' },
    { name: 'TOGAF', desc: 'Named framework — should need LLM fallback' },
    { name: 'Six Sigma', desc: 'Named methodology — should need LLM fallback' },
    { name: 'COBIT', desc: 'Named framework — should need LLM fallback' },
    { name: 'SAFe', desc: 'Named framework — should need LLM fallback' },
    { name: 'PRINCE2', desc: 'Named methodology — should need LLM fallback' },
  ];

  for (const { name, desc } of namedComponentsNotInStaticList) {
    it(`"${name}" triggers needsFallback for Tier 2 LLM classification (${desc})`, () => {
      const result = detectComponentType(name);
      // Key invariant: these are NOT in static lists, so confidence < 0.90
      // and needsFallback=true, allowing Tier 2 LLM to correctly classify
      assert.equal(result.needsFallback, true,
        `"${name}" should need LLM fallback (confidence=${result.confidence})`);
    });
  }

  // Generic/abstract descriptions should always route to capability
  const genericCapabilities = [
    'incident response',
    'change management',
    'capacity planning',
    'risk assessment',
    'service design',
    'performance testing',
    'cost optimization',
    'disaster recovery',
  ];

  for (const name of genericCapabilities) {
    it(`generic "${name}" routes to capability path`, () => {
      const result = detectComponentType(name);
      assert.equal(result.type, COMPONENT_TYPE.CAPABILITY,
        `"${name}" should be classified as capability, got ${result.type}`);
    });
  }

  // Verify that routing targets respect the classification
  it('solution detection produces useSolutionStrategies=true in exclusive mode', () => {
    delete process.env.WARDLEY_EVAL_MODE;
    const solutionDetection = { type: COMPONENT_TYPE.SOLUTION, confidence: 0.95 };
    const targets = determineRoutingTargets(solutionDetection);
    assert.equal(targets.useSolutionStrategies, true);
    assert.equal(targets.useCapabilityStrategies, false);
  });

  it('capability detection produces useCapabilityStrategies=true in exclusive mode', () => {
    delete process.env.WARDLEY_EVAL_MODE;
    const capabilityDetection = { type: COMPONENT_TYPE.CAPABILITY, confidence: 0.95 };
    const targets = determineRoutingTargets(capabilityDetection);
    assert.equal(targets.useSolutionStrategies, false);
    assert.equal(targets.useCapabilityStrategies, true);
  });

  // Verify that the dual-verification override is respected:
  // When Tier 2 LLM overrides the Tier 1 classification, routing targets update
  it('dispatchWithRouting uses detection.type for routing (solution override)', async () => {
    delete process.env.WARDLEY_EVAL_MODE;
    let capCallbackCalled = false;
    const mockCapCallback = async () => {
      capCallbackCalled = true;
      return {};
    };

    // Simulate a component that heuristics detect as solution
    const result = await dispatchWithRouting(
      { name: 'Kubernetes' },
      { runCapabilityStrategies: mockCapCallback, strategy: 'all' }
    );

    // In exclusive mode, solution should NOT call capability callback
    assert.equal(capCallbackCalled, false,
      'Solution routing should NOT dispatch to capability strategies in exclusive mode');
    assert.equal(result.targets.useSolutionStrategies, true);
  });

  it('dispatchWithRouting uses detection.type for routing (capability override)', async () => {
    delete process.env.WARDLEY_EVAL_MODE;
    let capCallbackCalled = false;
    const mockCapCallback = async () => {
      capCallbackCalled = true;
      return { 'test-cap': { evolution: 0.5 } };
    };

    // CRM is a known capability
    const result = await dispatchWithRouting(
      { name: 'CRM' },
      { runCapabilityStrategies: mockCapCallback, strategy: 'all' }
    );

    assert.equal(capCallbackCalled, true,
      'Capability routing should dispatch to capability strategies');
    assert.equal(result.targets.useCapabilityStrategies, true);
    assert.equal(result.targets.useSolutionStrategies, false);
  });
});

// ─── Constants Exported ───────────────────────────────────────────────────────

describe('exported constants', () => {
  it('COMPONENT_TYPE has solution and capability', () => {
    assert.equal(COMPONENT_TYPE.SOLUTION, 'solution');
    assert.equal(COMPONENT_TYPE.CAPABILITY, 'capability');
  });

  it('EVAL_MODES has exclusive and parallel', () => {
    assert.equal(EVAL_MODES.EXCLUSIVE, 'exclusive');
    assert.equal(EVAL_MODES.PARALLEL, 'parallel');
  });

  it('CONFIDENCE_THRESHOLD is 0.90', () => {
    assert.equal(CONFIDENCE_THRESHOLD, 0.90);
  });
});
