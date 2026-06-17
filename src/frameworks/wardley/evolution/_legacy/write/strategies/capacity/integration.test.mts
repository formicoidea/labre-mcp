// Integration tests: verify legacy capacity strategies are functional and return
// results conforming to the {evolution, confidence, method} interface.
//
// Tests cover:
//   - Legacy BaseStrategy implementations discovered by the registry
//   - Each strategy returns a valid EvolutionResult
//   - BaseStrategy.validateResult passes for every result
//   - Interface shape: evolution (number), confidence (number 0-1), method (non-empty string)
//   - Each strategy's method identifier matches its static getter
//   - LLM-based strategies work with mock LLM functions

import assert from 'node:assert/strict';
import { loadStrategies, clearCache, listStrategies, listDisabled } from './registry.mjs';
import { BaseStrategy } from './base-strategy.mjs';

const CPC_EVOLUTION = 'write:capacity:cpc-evolution';
const LOGPROB_DISTRIBUTION = 'write:capacity:logprob-distribution';
const TIMELINE_BENCHMARK = 'write:capacity:timeline-benchmark';

// ── Mock LLM functions ──────────────────────────────────────────────────────

/** Mock LLM call that returns evolution/confidence format (for llm-direct) */
function mockLLMCall(prompt) {
  return Promise.resolve(
    'evolution=0.55\nconfidence=0.75'
  );
}

/** Mock LLM call for timeline-benchmark (three prompt types: capability, history, llm-direct) */
function mockTimelineLLMCall(prompt) {
  if (prompt.includes('underlying capability')) {
    // Phase 1: capability identification
    return Promise.resolve(
      'type=capability\nnature=activity\ncapability=Fournir de l\'infrastructure informatique à la demande\nconfidence=0.85'
    );
  }
  if (prompt.includes('NEXT chronological milestone')) {
    // Phase 2: history iteration — return a single milestone at current year
    return Promise.resolve(
      `milestone_name=Cloud hyperscalers\nmilestone_date=${new Date().getFullYear()}`
    );
  }
  // LLM-direct evaluation (called internally by timeline-benchmark for each milestone)
  return Promise.resolve(
    'evolution=0.80\nconfidence=0.85'
  );
}

/** Mock LLM call for timeline-benchmark stalling scenario (never reaches current year) */
function mockTimelineLLMCallStalling(prompt) {
  if (prompt.includes('underlying capability')) {
    return Promise.resolve(
      'type=capability\nnature=activity\ncapability=Test capability\nconfidence=0.85'
    );
  }
  if (prompt.includes('NEXT chronological milestone')) {
    // Always return dates in the past — simulates stalling
    if (!mockTimelineLLMCallStalling._count) mockTimelineLLMCallStalling._count = 0;
    mockTimelineLLMCallStalling._count++;
    const year = 1900 + mockTimelineLLMCallStalling._count * 5;
    return Promise.resolve(`milestone_name=Milestone ${mockTimelineLLMCallStalling._count}\nmilestone_date=${year}`);
  }
  // LLM-direct evaluation
  return Promise.resolve('evolution=0.45\nconfidence=0.60');
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

/** Mock LLM call that returns phase probabilities */
function mockPubLLMCall(prompt) {
  return Promise.resolve(
    'phase1=0.10\nphase2=0.20\nphase3=0.40\nphase4=0.30'
  );
}

// ── Test component fixtures ─────────────────────────────────────────────────

const COMPONENT_FULL = {
  name: 'Cloud Computing',
  certitude: 0.85,
  ubiquity: 0.80,
  phaseDistribution: {
    bins: [
      { position: 0.09, probability: 0.05 },
      { position: 0.29, probability: 0.10 },
      { position: 0.48, probability: 0.35 },
      { position: 0.85, probability: 0.50 },
    ],
  },
  description: 'IaaS/PaaS cloud infrastructure services',
};

const COMPONENT_MINIMAL = {
  name: 'Kubernetes',
  description: 'Container orchestration platform',
};

// ── Constructor options for LLM-based strategies ────────────────────────────

const STRATEGY_OPTIONS = {
  'llm-direct':            { llmCall: mockLLMCall },
  [LOGPROB_DISTRIBUTION]:  { llmLogprobCall: mockLLMLogprobCall },
  'publication-analysis':  { llmCall: mockPubLLMCall },
  // Analytical strategies need no special options
  's-curve':               {},
  [TIMELINE_BENCHMARK]:    { llmCall: mockTimelineLLMCall },
  // CPC evolution: no external dependencies required (graceful degradation)
  [CPC_EVOLUTION]:         {},
};

// Components that work for each strategy
const STRATEGY_COMPONENTS = {
  's-curve':               COMPONENT_FULL,        // needs certitude + ubiquity
  [TIMELINE_BENCHMARK]:    COMPONENT_MINIMAL,     // uses LLM (capability identification + history loop)
  'llm-direct':            COMPONENT_MINIMAL,     // uses LLM
  [LOGPROB_DISTRIBUTION]:  COMPONENT_MINIMAL,     // uses LLM logprobs
  'publication-analysis':  COMPONENT_FULL,        // has pub proportions
  [CPC_EVOLUTION]:         COMPONENT_MINIMAL,     // graceful degradation without BigQuery
};

// ── Expected strategies ─────────────────────────────────────────────────────
// Full catalogue, including strategies that may be disabled at runtime.
// The registry filters disabled entries out of listStrategies(); tests that
// iterate over "active" strategies should use listStrategies() directly.
const ALL_KNOWN_STRATEGIES = [
  CPC_EVOLUTION,
  LOGPROB_DISTRIBUTION,
  TIMELINE_BENCHMARK,
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
  console.log('=== Integration Tests: Legacy Capacity Strategies ===\n');

  // Reset registry cache
  clearCache();

  // ── Test 1: Registry discovers exactly 6 strategies ──────────────────

  console.log('Registry Discovery:');

  await runTest('active + disabled strategies sum to the known catalogue', async () => {
    const active = await listStrategies();
    const disabled = (await listDisabled()).map(d => d.method);
    const total = active.length + disabled.length;
    assert.equal(total, ALL_KNOWN_STRATEGIES.length,
      `Expected ${ALL_KNOWN_STRATEGIES.length} strategies total, found ${total} ` +
      `(active=[${active.join(', ')}], disabled=[${disabled.join(', ')}])`);
  });

  await runTest('every known strategy is either active or disabled', async () => {
    const active = await listStrategies();
    const disabled = (await listDisabled()).map(d => d.method);
    for (const method of ALL_KNOWN_STRATEGIES) {
      assert.ok(active.includes(method) || disabled.includes(method),
        `Strategy "${method}" is neither active nor disabled`);
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

  const ACTIVE_STRATEGIES = await listStrategies();
  for (const method of ACTIVE_STRATEGIES) {
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

    const cpc = new (strategies.get(CPC_EVOLUTION))();
    const cpcResult = await cpc.evaluate(COMPONENT_MINIMAL);
    assertEvolutionResult(cpcResult, CPC_EVOLUTION);

    const logprob = new (strategies.get(LOGPROB_DISTRIBUTION))({ llmLogprobCall: mockLLMLogprobCall });
    const logprobResult = await logprob.evaluate(COMPONENT_MINIMAL);
    assertEvolutionResult(logprobResult, LOGPROB_DISTRIBUTION);

    // timeline-benchmark is exercised only when active
    if (strategies.has(TIMELINE_BENCHMARK)) {
      const timeline = new (strategies.get(TIMELINE_BENCHMARK))({ llmCall: mockTimelineLLMCall });
      const timelineResult = await timeline.evaluate(COMPONENT_FULL);
      assertEvolutionResult(timelineResult, TIMELINE_BENCHMARK);
      assert.ok(timelineResult.trace.length > 0,
        'timeline should have at least one milestone in trace');
      assert.equal(typeof timelineResult.evolution, 'number');
    }
  });

  // ── Test 4: LLM strategies handle mock responses correctly ────────────

  console.log('\nLLM Strategy Mock Integration:');

  await runTest('llm-direct: returns direct evolution estimate', async () => {
    const strategies = await loadStrategies();
    const Cls = strategies.get('llm-direct');
    if (!Cls) {
      console.log('    (skipped — llm-direct is registered in the core evolution registry)');
      return;
    }
    const instance = new Cls({ llmCall: mockLLMCall });
    const result = await instance.evaluate(COMPONENT_MINIMAL);
    assertEvolutionResult(result, 'llm-direct');
    // With mock returning evo=0.55, cert=0.75, ubiq=0.60 -> blend should be reasonable
    assert.ok(result.evolution >= 0 && result.evolution <= 1,
      `Blended evolution should be in [0, 1], got ${result.evolution}`);
  });

  await runTest('logprob-distribution: computes centroid from mock logprobs', async () => {
    const strategies = await loadStrategies();
    const Cls = strategies.get(LOGPROB_DISTRIBUTION);
    const instance = new Cls({ llmLogprobCall: mockLLMLogprobCall });
    const result = await instance.evaluate(COMPONENT_MINIMAL);
    assertEvolutionResult(result, LOGPROB_DISTRIBUTION);
    // Product phase has highest logprob, so evolution should lean toward product centroid (0.48)
    assert.ok(result.evolution > 0.3 && result.evolution < 0.7,
      `Logprob evolution should be in product range, got ${result.evolution}`);
  });

  await runTest('publication-analysis: works with LLM fallback', async () => {
    const strategies = await loadStrategies();
    const Cls = strategies.get('publication-analysis');
    if (!Cls) {
      console.log('    (skipped — publication-analysis is registered in the core evolution registry)');
      return;
    }
    const instance = new Cls({ llmCall: mockPubLLMCall });
    // Component without pub proportions → triggers LLM fallback
    const result = await instance.evaluate(COMPONENT_MINIMAL);
    assertEvolutionResult(result, 'publication-analysis');
  });

  await runTest('timeline-benchmark: fallback reaches present when loop stalls', async () => {
    const strategies = await loadStrategies();
    if (!strategies.has(TIMELINE_BENCHMARK)) {
      console.log('    (skipped — timeline-benchmark disabled)');
      return;
    }
    mockTimelineLLMCallStalling._count = 0; // reset counter
    const Cls = strategies.get(TIMELINE_BENCHMARK);
    const instance = new Cls({ llmCall: mockTimelineLLMCallStalling });
    const result = await instance.evaluate({ name: 'Test', description: 'Test capability' });
    assertEvolutionResult(result, TIMELINE_BENCHMARK);
    const lastTrace = result.trace[result.trace.length - 1];
    assert.equal(lastTrace.date, new Date().getFullYear(),
      `Last milestone should be at current year via fallback, got ${lastTrace.date}`);
    assert.strictEqual(lastTrace._fallback, true, 'Last milestone should be marked as fallback');
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
    const Cls = strategies.get('s-curve');
    if (!Cls) {
      console.log('    (skipped — s-curve is registered in the core evolution registry)');
      return;
    }
    const instance = new Cls();
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
      if (!Cls) {
        console.log('    (skipped — llm-direct is registered in the core evolution registry)');
        return;
      }
      assert.throws(
        () => new Cls({}),
        /llmCall/i,
        'llm-direct should throw without llmCall'
      );
    });
  });

  await runTest('logprob-distribution: requires llmLogprobCall function', () => {
    return loadStrategies().then(s => {
      const Cls = s.get(LOGPROB_DISTRIBUTION);
      assert.throws(
        () => new Cls({}),
        /llmLogprobCall/i,
        'logprob-distribution should throw without llmLogprobCall'
      );
    });
  });

  // ── Test 7: S-curve out-of-band behavior ──────────────────────────────

  console.log('\nS-curve out-of-band projection:');

  await runTest('s-curve: out-of-band point returns evolution in [0,1] with confidence < 0.90', async () => {
    const strategies = await loadStrategies();
    const Cls = strategies.get('s-curve');
    if (!Cls) {
      console.log('    (skipped — s-curve is registered in the core evolution registry)');
      return;
    }
    const instance = new Cls();
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
    const Cls = strategies.get('s-curve');
    if (!Cls) {
      console.log('    (skipped — s-curve is registered in the core evolution registry)');
      return;
    }
    const instance = new Cls();
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
