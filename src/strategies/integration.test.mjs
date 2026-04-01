// Integration tests: verify all 6 strategies are functional and return
// results conforming to the {evolution, confidence, method} interface.
//
// Tests cover:
//   - All 6 strategies discovered by the registry
//   - Each strategy returns a valid EvolutionResult
//   - BaseStrategy.validateResult passes for every result
//   - Interface shape: evolution (number), confidence (number 0-1), method (non-empty string)
//   - Each strategy's method identifier matches its static getter
//   - LLM-based strategies work with mock LLM functions

import assert from 'node:assert/strict';
import { loadStrategies, clearCache, listStrategies } from './registry.mjs';
import { BaseStrategy } from './base-strategy.mjs';

// ── Mock LLM functions ──────────────────────────────────────────────────────

/** Mock LLM call that returns certitude/ubiquity/evolution format */
function mockLLMCall(prompt) {
  return Promise.resolve(
    'certitude=0.75\nubiquity=0.60\nevolution=0.55'
  );
}

/** Mock LLM call for timeline-benchmark (three prompt types: capability, history, llm-direct) */
function mockTimelineLLMCall(prompt) {
  if (prompt.includes('underlying capability')) {
    // Phase 1: capability identification
    return Promise.resolve(
      'type=capability\nnature=activite\ncapability=Fournir de l\'infrastructure informatique à la demande\nconfidence=0.85'
    );
  }
  if (prompt.includes('certitude')) {
    // LLM-direct evaluation (called internally by timeline-benchmark for each milestone)
    return Promise.resolve(
      'certitude=0.75\nubiquity=0.60\nevolution=0.80'
    );
  }
  // Phase 2: history iteration — return a single milestone at current year
  return Promise.resolve(
    `milestone_name=Cloud hyperscalers\nmilestone_date=${new Date().getFullYear()}`
  );
}

/** Mock LLM logprob call returning phase classification with logprobs */
function mockLLMLogprobCall(prompt) {
  return Promise.resolve({
    text: 'Product',
    logprobs: [
      { token: 'Product', logprob: -0.2 },
      { token: 'Commodity', logprob: -1.5 },
      { token: 'Custom', logprob: -2.8 },
      { token: 'Genesis', logprob: -4.0 },
    ],
  });
}

/** Mock LLM call that returns publication proportions */
function mockPubLLMCall(prompt) {
  return Promise.resolve(
    'wonder=0.10\nbuild=0.20\noperate=0.40\nusage=0.30'
  );
}

// ── Test component fixtures ─────────────────────────────────────────────────

const COMPONENT_FULL = {
  name: 'Cloud Computing',
  certitude: 0.85,
  ubiquity: 0.80,
  wonder: 0.05,
  build: 0.10,
  operate: 0.35,
  usage: 0.50,
  description: 'IaaS/PaaS cloud infrastructure services',
};

const COMPONENT_MINIMAL = {
  name: 'Kubernetes',
  description: 'Container orchestration platform',
};

// ── Constructor options for LLM-based strategies ────────────────────────────

const STRATEGY_OPTIONS = {
  'llm-direct':            { llmCall: mockLLMCall },
  'logprob-distribution':  { llmLogprobCall: mockLLMLogprobCall },
  'sector-agent':          { llmCall: mockLLMCall },
  'publication-analysis':  { llmCall: mockPubLLMCall },
  // Analytical strategies need no special options
  's-curve':               {},
  'timeline-benchmark':    { llmCall: mockTimelineLLMCall },
};

// Components that work for each strategy
const STRATEGY_COMPONENTS = {
  's-curve':               COMPONENT_FULL,        // needs certitude + ubiquity
  'timeline-benchmark':    COMPONENT_MINIMAL,     // uses LLM (capability identification + history loop)
  'llm-direct':            COMPONENT_MINIMAL,     // uses LLM
  'logprob-distribution':  COMPONENT_MINIMAL,     // uses LLM logprobs
  'publication-analysis':  COMPONENT_FULL,        // has pub proportions
  'sector-agent':          COMPONENT_MINIMAL,     // uses LLM
};

// ── Expected strategies ─────────────────────────────────────────────────────

const EXPECTED_STRATEGIES = [
  's-curve',
  'timeline-benchmark',
  'llm-direct',
  'logprob-distribution',
  'publication-analysis',
  'sector-agent',
];

// ── Test helpers ─────────────────────────────────────────────────────────────

function assertEvolutionResult(result, expectedMethod) {
  // Shape check
  assert.ok(result !== null && typeof result === 'object',
    `Result must be a non-null object, got ${result}`);

  // evolution: must be a number (can be outside 0-1 for extra-competitive)
  assert.equal(typeof result.evolution, 'number',
    `evolution must be a number, got ${typeof result.evolution}`);
  assert.ok(!Number.isNaN(result.evolution),
    `evolution must not be NaN`);

  // confidence: must be a number in [0, 1]
  assert.equal(typeof result.confidence, 'number',
    `confidence must be a number, got ${typeof result.confidence}`);
  assert.ok(result.confidence >= 0 && result.confidence <= 1,
    `confidence must be in [0, 1], got ${result.confidence}`);

  // method: must be a non-empty string
  assert.equal(typeof result.method, 'string',
    `method must be a string, got ${typeof result.method}`);
  assert.ok(result.method.length > 0,
    `method must be non-empty`);

  // method matches expected
  if (expectedMethod) {
    assert.equal(result.method, expectedMethod,
      `method should be "${expectedMethod}", got "${result.method}"`);
  }

  // Must also pass BaseStrategy.validateResult without throwing
  BaseStrategy.validateResult(result);
}

// ── Tests ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log('=== Integration Tests: All 6 Strategies ===\n');

  // Reset registry cache
  clearCache();

  // ── Test 1: Registry discovers exactly 6 strategies ──────────────────

  console.log('Registry Discovery:');

  await runTest('discovers exactly 6 strategies', async () => {
    const strategies = await loadStrategies();
    assert.equal(strategies.size, 6,
      `Expected 6 strategies, found ${strategies.size}: [${[...strategies.keys()].join(', ')}]`);
  });

  await runTest('all expected strategy methods are present', async () => {
    const list = await listStrategies();
    for (const method of EXPECTED_STRATEGIES) {
      assert.ok(list.includes(method),
        `Missing strategy: ${method}. Found: [${list.join(', ')}]`);
    }
  });

  await runTest('all strategies extend BaseStrategy', async () => {
    const strategies = await loadStrategies();
    for (const [method, Cls] of strategies) {
      assert.ok(Cls.prototype instanceof BaseStrategy,
        `${method} strategy does not extend BaseStrategy`);
    }
  });

  await runTest('all strategies have a static method getter', async () => {
    const strategies = await loadStrategies();
    for (const [method, Cls] of strategies) {
      assert.equal(Cls.method, method,
        `Strategy key "${method}" does not match static method "${Cls.method}"`);
    }
  });

  // ── Test 2: Each strategy evaluates and returns valid result ──────────

  console.log('\nStrategy Evaluation & Interface Conformance:');

  for (const method of EXPECTED_STRATEGIES) {
    await runTest(`${method}: evaluate() returns valid {evolution, confidence, method}`, async () => {
      const strategies = await loadStrategies();
      const Cls = strategies.get(method);
      assert.ok(Cls, `Strategy "${method}" not found`);

      const options = STRATEGY_OPTIONS[method] || {};
      const instance = new Cls(options);
      const component = STRATEGY_COMPONENTS[method];

      const result = await instance.evaluate(component);
      assertEvolutionResult(result, method);
    });
  }

  // ── Test 3: Cross-strategy consistency with same component ────────────

  console.log('\nCross-Strategy Consistency:');

  await runTest('analytical strategies return valid results for same component', async () => {
    const strategies = await loadStrategies();

    // s-curve with high certitude/ubiquity — may return extra-competitive (outside band)
    const sCurve = new (strategies.get('s-curve'))();
    const sCurveResult = sCurve.evaluate(COMPONENT_FULL);
    assertEvolutionResult(sCurveResult, 's-curve');

    // timeline-benchmark for "Cloud Computing" — LLM-based (capability + history loop)
    const timeline = new (strategies.get('timeline-benchmark'))({ llmCall: mockTimelineLLMCall });
    const timelineResult = await timeline.evaluate(COMPONENT_FULL);
    assertEvolutionResult(timelineResult, 'timeline-benchmark');

    // publication-analysis with usage-heavy distribution
    const pub = new (strategies.get('publication-analysis'))();
    const pubResult = await pub.evaluate(COMPONENT_FULL);
    assertEvolutionResult(pubResult, 'publication-analysis');

    // publication-analysis should indicate high evolution (> 0.5) for Cloud Computing
    // (usage-heavy distribution in COMPONENT_FULL); timeline-benchmark uses LLM-direct
    // internally which blends S-curve and LLM estimate — mock values may produce
    // different results depending on S-curve band positioning
    assert.ok(pubResult.evolution > 0.5,
      `publication evolution ${pubResult.evolution} should be > 0.5 for Cloud Computing`);
    assert.ok(timelineResult.trace.length > 0,
      'timeline should have at least one milestone in trace');

    // All results must be valid numbers (including extra-competitive negative values)
    assert.equal(typeof sCurveResult.evolution, 'number');
    assert.equal(typeof timelineResult.evolution, 'number');
    assert.equal(typeof pubResult.evolution, 'number');
  });

  // ── Test 4: LLM strategies handle mock responses correctly ────────────

  console.log('\nLLM Strategy Mock Integration:');

  await runTest('llm-direct: blends S-curve and LLM estimates', async () => {
    const strategies = await loadStrategies();
    const Cls = strategies.get('llm-direct');
    const instance = new Cls({ llmCall: mockLLMCall });
    const result = await instance.evaluate(COMPONENT_MINIMAL);
    assertEvolutionResult(result, 'llm-direct');
    // With mock returning evo=0.55, cert=0.75, ubiq=0.60 -> blend should be reasonable
    assert.ok(result.evolution >= 0 && result.evolution <= 1,
      `Blended evolution should be in [0, 1], got ${result.evolution}`);
  });

  await runTest('logprob-distribution: computes centroid from mock logprobs', async () => {
    const strategies = await loadStrategies();
    const Cls = strategies.get('logprob-distribution');
    const instance = new Cls({ llmLogprobCall: mockLLMLogprobCall });
    const result = await instance.evaluate(COMPONENT_MINIMAL);
    assertEvolutionResult(result, 'logprob-distribution');
    // Product phase has highest logprob, so evolution should lean toward product centroid (0.48)
    assert.ok(result.evolution > 0.3 && result.evolution < 0.7,
      `Logprob evolution should be in product range, got ${result.evolution}`);
  });

  await runTest('sector-agent: blends sector analysis with S-curve', async () => {
    const strategies = await loadStrategies();
    const Cls = strategies.get('sector-agent');
    const instance = new Cls({ llmCall: mockLLMCall });
    const result = await instance.evaluate(COMPONENT_MINIMAL);
    assertEvolutionResult(result, 'sector-agent');
    assert.ok(result.evolution >= 0 && result.evolution <= 1,
      `Sector agent evolution should be in [0, 1], got ${result.evolution}`);
  });

  await runTest('publication-analysis: works with LLM fallback', async () => {
    const strategies = await loadStrategies();
    const Cls = strategies.get('publication-analysis');
    const instance = new Cls({ llmCall: mockPubLLMCall });
    // Component without pub proportions → triggers LLM fallback
    const result = await instance.evaluate(COMPONENT_MINIMAL);
    assertEvolutionResult(result, 'publication-analysis');
  });

  // ── Test 5: Strategy method names are unique ──────────────────────────

  console.log('\nUniqueness:');

  await runTest('no duplicate method names across strategies', async () => {
    const strategies = await loadStrategies();
    const methods = [...strategies.keys()];
    const unique = new Set(methods);
    assert.equal(methods.length, unique.size,
      `Duplicate methods found: ${methods.join(', ')}`);
  });

  // ── Test 6: Error handling ────────────────────────────────────────────

  console.log('\nError Handling:');

  await runTest('s-curve: throws on missing certitude/ubiquity', async () => {
    const strategies = await loadStrategies();
    const instance = new (strategies.get('s-curve'))();
    await assert.rejects(
      async () => instance.evaluate({ name: 'Test' }),
      /certitude|ubiquity/i,
      's-curve should throw when certitude/ubiquity missing'
    );
  });

  await runTest('llm-direct: requires llmCall function', () => {
    const strategies = loadStrategies();
    return strategies.then(s => {
      const Cls = s.get('llm-direct');
      assert.throws(
        () => new Cls({}),
        /llmCall/i,
        'llm-direct should throw without llmCall'
      );
    });
  });

  await runTest('logprob-distribution: requires llmLogprobCall function', () => {
    return loadStrategies().then(s => {
      const Cls = s.get('logprob-distribution');
      assert.throws(
        () => new Cls({}),
        /llmLogprobCall/i,
        'logprob-distribution should throw without llmLogprobCall'
      );
    });
  });

  await runTest('sector-agent: requires llmCall function', () => {
    return loadStrategies().then(s => {
      const Cls = s.get('sector-agent');
      assert.throws(
        () => new Cls({}),
        /llmCall/i,
        'sector-agent should throw without llmCall'
      );
    });
  });

  // ── Test 7: S-curve out-of-band behavior ──────────────────────────────

  console.log('\nS-curve out-of-band projection:');

  await runTest('s-curve: out-of-band point returns evolution in [0,1] with confidence < 0.90', async () => {
    const strategies = await loadStrategies();
    const instance = new (strategies.get('s-curve'))();
    // Point clearly above the band (high ubiquity, low certitude)
    const result = instance.evaluate({ name: 'Test', certitude: 0.2, ubiquity: 0.95 });
    assertEvolutionResult(result, 's-curve');
    assert.ok(result.evolution >= 0 && result.evolution <= 1,
      `Out-of-band evolution should be in [0, 1], got ${result.evolution}`);
    assert.ok(result.confidence < 0.9,
      `Out-of-band confidence should be < 0.90, got ${result.confidence}`);
  });

  await runTest('s-curve: in-band point has confidence 0.90, higher than out-of-band', async () => {
    const strategies = await loadStrategies();
    const instance = new (strategies.get('s-curve'))();
    const inBand = instance.evaluate({ name: 'Test', certitude: 0.63, ubiquity: 0.74 });
    const outBand = instance.evaluate({ name: 'Test', certitude: 0.2, ubiquity: 0.95 });
    assert.strictEqual(inBand.confidence, 0.9,
      `In-band confidence should be 0.90, got ${inBand.confidence}`);
    assert.ok(inBand.confidence > outBand.confidence,
      `In-band confidence (${inBand.confidence}) should be > out-of-band (${outBand.confidence})`);
  });

  // ── Summary ───────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'═'.repeat(50)}`);

  if (failed > 0) {
    console.error('\n✗ Integration tests FAILED\n');
    process.exit(1);
  } else {
    console.log('\n✓ All integration tests PASSED\n');
  }
}

main().catch(err => {
  console.error('\n✗ Integration tests CRASHED:', err);
  process.exit(1);
});
