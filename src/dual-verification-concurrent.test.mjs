// Tests for the concurrent dual-verification orchestrator
//
// Validates verifyConcurrent() and verifyConcurrentFull():
//   - Concurrent invocation of LLM + web search signals
//   - Per-signal timeout handling
//   - Per-signal error handling
//   - Structured DualSignalPair contract
//   - Reconciliation logic (agreement, disagreement, partial failure)
//   - Naming pre-check short-circuit
//   - Edge cases (empty, null, both skipped, both failed)
//   - Integration with VerifiedClassificationResult (verifyConcurrentFull)
//
// All tests use mocks. No real LLM or web search calls are made.

import {
  verifyConcurrent,
  verifyConcurrentFull,
  THRESHOLDS,
  COMPONENT_TYPE,
  _internal,
} from './dual-verification-orchestrator.mjs';

const {
  buildSuccessSignal,
  buildTimeoutSignal,
  buildErrorSignal,
  buildSkippedSignal,
  reconcileSignalPair,
  raceWithTimeout,
  DEFAULT_SIGNAL_TIMEOUT_MS,
} = _internal;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertApprox(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message} (expected ~${expected}, got ${actual}, diff=${diff})`);
  }
}

console.log('=== dual-verification-concurrent test suite ===\n');

// ─── Helper mocks ──────────────────────────────────────────────────────────

/** Mock LLM that returns solution classification after a delay */
function createMockLLM(classification, confidence, delayMs = 10) {
  return async () => {
    await new Promise(r => setTimeout(r, delayMs));
    return `classification=${classification.toUpperCase()}\nconfidence=${confidence}\nreasoning=Mock LLM says ${classification}`;
  };
}

/** Mock web search that returns a structured response after a delay */
function createMockWebSearch(classification, confidence, delayMs = 10) {
  return async () => {
    await new Promise(r => setTimeout(r, delayMs));
    return `classification=${classification.toUpperCase()}\nconfidence=${confidence}\n` +
      `reasoning=Mock web search says ${classification}\n` +
      `EVIDENCE_START\ntype=product-page|description=Mock evidence|source=example.com|supports=${classification}\nEVIDENCE_END\n` +
      `REFERENCES_START\ntitle=Mock Reference|url=https://example.com|snippet=Mock snippet\nREFERENCES_END`;
  };
}

/** Mock that throws after optional delay */
function createFailingMock(message, delayMs = 5) {
  return async () => {
    await new Promise(r => setTimeout(r, delayMs));
    throw new Error(message);
  };
}

/** Mock that never resolves (for timeout testing) */
function createHangingMock() {
  return () => new Promise(() => {}); // never resolves
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1: Signal builder unit tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('--- Group 1: Signal builders ---');
{
  // buildSuccessSignal
  const s1 = buildSuccessSignal({ classification: 'solution', confidence: 0.88, reasoning: 'test' }, 'llm', 150);
  assert(s1.status === 'success', 'buildSuccessSignal: status is success');
  assert(s1.classification === 'solution', 'buildSuccessSignal: classification');
  assert(s1.confidence === 0.88, 'buildSuccessSignal: confidence');
  assert(s1.method === 'llm', 'buildSuccessSignal: method');
  assert(s1.durationMs === 150, 'buildSuccessSignal: durationMs');
  assert(s1.raw != null, 'buildSuccessSignal: raw present');

  // buildTimeoutSignal
  const s2 = buildTimeoutSignal('web-search', 15000, 15000);
  assert(s2.status === 'timeout', 'buildTimeoutSignal: status');
  assert(s2.classification === null, 'buildTimeoutSignal: classification null');
  assert(s2.confidence === 0, 'buildTimeoutSignal: confidence 0');
  assert(s2.error.includes('15000'), 'buildTimeoutSignal: error message includes timeout');

  // buildErrorSignal
  const s3 = buildErrorSignal('llm', new Error('Network fail'), 42);
  assert(s3.status === 'error', 'buildErrorSignal: status');
  assert(s3.classification === null, 'buildErrorSignal: classification null');
  assert(s3.error === 'Network fail', 'buildErrorSignal: error message');
  assert(s3.durationMs === 42, 'buildErrorSignal: durationMs');

  // buildSkippedSignal
  const s4 = buildSkippedSignal('web-search', 'No backend');
  assert(s4.status === 'skipped', 'buildSkippedSignal: status');
  assert(s4.durationMs === 0, 'buildSkippedSignal: durationMs 0');
  assert(s4.reasoning === 'No backend', 'buildSkippedSignal: reason');

  console.log('  Signal builder tests passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2: reconcileSignalPair unit tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 2: Signal pair reconciliation ---');
{
  // Case 1: Both agree on solution
  const r1 = reconcileSignalPair(
    buildSuccessSignal({ classification: 'solution', confidence: 0.80, reasoning: 'LLM: solution' }, 'llm', 100),
    buildSuccessSignal({ classification: 'solution', confidence: 0.85, reasoning: 'Web: solution' }, 'web-search', 200),
  );
  assert(r1.classification === 'solution', 'Agreement solution: classification');
  // Average 0.825 + 0.10 = 0.925 → capped at 0.93
  assertApprox(r1.confidence, 0.93, 0.02, 'Agreement solution: boosted confidence');
  assert(r1.method === 'llm+web-search', 'Agreement: method chain');

  // Case 1b: Both agree on capability
  const r1b = reconcileSignalPair(
    buildSuccessSignal({ classification: 'capability', confidence: 0.75, reasoning: 'LLM: cap' }, 'llm', 100),
    buildSuccessSignal({ classification: 'capability', confidence: 0.70, reasoning: 'Web: cap' }, 'web-search', 200),
  );
  assert(r1b.classification === 'capability', 'Agreement capability: classification');
  assertApprox(r1b.confidence, 0.83, 0.02, 'Agreement capability: boosted confidence');

  // Case 2: Disagree, LLM higher confidence
  const r2 = reconcileSignalPair(
    buildSuccessSignal({ classification: 'solution', confidence: 0.85, reasoning: 'LLM: solution' }, 'llm', 100),
    buildSuccessSignal({ classification: 'capability', confidence: 0.70, reasoning: 'Web: capability' }, 'web-search', 200),
  );
  assert(r2.classification === 'solution', 'Disagree: LLM wins (higher confidence)');
  assertApprox(r2.confidence, 0.75, 0.02, 'Disagree: penalized confidence');
  assert(r2.method === 'llm+web-search', 'Disagree: method chain');

  // Case 2b: Disagree, web search higher confidence
  const r2b = reconcileSignalPair(
    buildSuccessSignal({ classification: 'solution', confidence: 0.60, reasoning: 'LLM: solution' }, 'llm', 100),
    buildSuccessSignal({ classification: 'capability', confidence: 0.88, reasoning: 'Web: capability' }, 'web-search', 200),
  );
  assert(r2b.classification === 'capability', 'Disagree: web wins (higher confidence)');
  assertApprox(r2b.confidence, 0.78, 0.02, 'Disagree: web penalized confidence');

  // Case 3a: Only LLM succeeded
  const r3a = reconcileSignalPair(
    buildSuccessSignal({ classification: 'solution', confidence: 0.80, reasoning: 'LLM only' }, 'llm', 100),
    buildErrorSignal('web-search', new Error('timeout'), 15000),
  );
  assert(r3a.classification === 'solution', 'LLM only: classification');
  assert(r3a.confidence === 0.80, 'LLM only: confidence unchanged');
  assert(r3a.method === 'llm', 'LLM only: method');

  // Case 3b: Only web search succeeded
  const r3b = reconcileSignalPair(
    buildTimeoutSignal('llm', 15000, 15000),
    buildSuccessSignal({ classification: 'capability', confidence: 0.90, reasoning: 'Web only' }, 'web-search', 200),
  );
  assert(r3b.classification === 'capability', 'Web only: classification');
  assert(r3b.confidence === 0.90, 'Web only: confidence unchanged');
  assert(r3b.method === 'web-search', 'Web only: method');

  // Case 4: Neither succeeded
  const r4 = reconcileSignalPair(
    buildErrorSignal('llm', new Error('fail'), 100),
    buildTimeoutSignal('web-search', 15000, 15000),
  );
  assert(r4.classification === 'capability', 'Neither: default to capability');
  assert(r4.confidence === 0, 'Neither: 0 confidence');
  assert(r4.method === 'none', 'Neither: method is none');

  // Case 4b: Both skipped
  const r4b = reconcileSignalPair(
    buildSkippedSignal('llm', 'No llmCall'),
    buildSkippedSignal('web-search', 'No backend'),
  );
  assert(r4b.classification === 'capability', 'Both skipped: default to capability');
  assert(r4b.confidence === 0, 'Both skipped: 0 confidence');

  console.log('  Reconciliation tests passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 3: raceWithTimeout unit tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 3: raceWithTimeout ---');
{
  // Fast promise wins
  const r1 = await raceWithTimeout(
    Promise.resolve('fast'), 5000, 'test'
  );
  assert(r1.timedOut === false, 'raceWithTimeout: fast promise wins');
  assert(r1.value === 'fast', 'raceWithTimeout: value preserved');

  // Timeout wins
  const r2 = await raceWithTimeout(
    new Promise(r => setTimeout(() => r('slow'), 500)), 50, 'test'
  );
  assert(r2.timedOut === true, 'raceWithTimeout: timeout fires for slow promise');
  assert(r2.value === null, 'raceWithTimeout: value null on timeout');

  // Error captured
  const r3 = await raceWithTimeout(
    Promise.reject(new Error('boom')), 5000, 'test'
  );
  assert(r3.timedOut === false, 'raceWithTimeout: error not a timeout');
  assert(r3.error?.message === 'boom', 'raceWithTimeout: error captured');
  assert(r3.value === null, 'raceWithTimeout: value null on error');

  console.log('  raceWithTimeout tests passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 4: verifyConcurrent — basic concurrent execution
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 4: verifyConcurrent basic behavior ---');
{
  // Known solution: naming pre-check short-circuits
  const r1 = await verifyConcurrent('Kubernetes', {
    llmCall: createFailingMock('Should not be called'),
    webSearchCall: createFailingMock('Should not be called'),
  });
  assert(r1.classification === 'solution', 'Kubernetes: naming short-circuit → solution');
  assert(r1.confidence >= 0.90, `Kubernetes: confidence >= 0.90 (got ${r1.confidence})`);
  assert(r1.verified === true, 'Kubernetes: verified');
  assert(r1.llmSignal.status === 'skipped', 'Kubernetes: LLM skipped');
  assert(r1.webSearchSignal.status === 'skipped', 'Kubernetes: web search skipped');
  assert(r1.method === 'naming', 'Kubernetes: method is naming');
  assert(r1.namingResult != null, 'Kubernetes: namingResult present');

  // Known capability: naming pre-check short-circuits
  const r2 = await verifyConcurrent('CRM', {
    llmCall: createFailingMock('Should not be called'),
  });
  assert(r2.classification === 'capability', 'CRM: naming short-circuit → capability');
  assert(r2.verified === true, 'CRM: verified');
  assert(r2.llmSignal.status === 'skipped', 'CRM: LLM skipped');

  console.log('  Basic behavior tests passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 5: verifyConcurrent — concurrent LLM + web search
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 5: verifyConcurrent concurrent execution ---');
{
  // Both agree on solution
  const r1 = await verifyConcurrent('ObscureProduct', {
    llmCall: createMockLLM('solution', 0.82, 20),
    webSearchCall: createMockWebSearch('solution', 0.88, 20),
    skipNamingPrecheck: true,
  });
  assert(r1.classification === 'solution', 'Both agree: solution');
  assert(r1.confidence > 0.85, `Both agree: boosted confidence (got ${r1.confidence})`);
  assert(r1.verified === true, 'Both agree: verified');
  assert(r1.llmSignal.status === 'success', 'Both agree: LLM succeeded');
  assert(r1.webSearchSignal.status === 'success', 'Both agree: web search succeeded');
  assert(r1.method === 'llm+web-search', 'Both agree: method chain');
  assert(r1.totalDurationMs > 0, 'Both agree: totalDurationMs recorded');

  // Both disagree: LLM=solution, web=capability, web higher confidence
  const r2 = await verifyConcurrent('AmbiThing', {
    llmCall: createMockLLM('solution', 0.65, 15),
    webSearchCall: createMockWebSearch('capability', 0.85, 15),
    skipNamingPrecheck: true,
  });
  assert(r2.classification === 'capability', 'Disagree: web wins (higher conf)');
  assert(r2.confidence < 0.85, `Disagree: penalized (got ${r2.confidence})`);
  assert(r2.confidence >= 0.45, `Disagree: above floor (got ${r2.confidence})`);
  assert(r2.llmSignal.status === 'success', 'Disagree: LLM still succeeded');
  assert(r2.webSearchSignal.status === 'success', 'Disagree: web still succeeded');

  // Verify concurrency: total time should be close to the slower of the two,
  // not the sum (since they run in parallel)
  const r3 = await verifyConcurrent('ConcurrencyTest', {
    llmCall: createMockLLM('solution', 0.80, 100),
    webSearchCall: createMockWebSearch('solution', 0.85, 100),
    skipNamingPrecheck: true,
  });
  // If sequential, total would be ~200ms. Concurrent should be ~100ms + overhead
  assert(r3.totalDurationMs < 250, `Concurrent: totalDuration < 250ms (got ${r3.totalDurationMs})`);
  assert(r3.llmSignal.durationMs > 0, 'Concurrent: LLM has durationMs');
  assert(r3.webSearchSignal.durationMs > 0, 'Concurrent: web has durationMs');

  console.log('  Concurrent execution tests passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 6: verifyConcurrent — timeout handling
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 6: verifyConcurrent timeout handling ---');
{
  // LLM times out, web search succeeds
  const r1 = await verifyConcurrent('TimeoutLLM', {
    llmCall: createHangingMock(),
    webSearchCall: createMockWebSearch('solution', 0.88, 10),
    skipNamingPrecheck: true,
    llmTimeoutMs: 100,
    webSearchTimeoutMs: 5000,
  });
  assert(r1.llmSignal.status === 'timeout', 'LLM timeout: signal status');
  assert(r1.llmSignal.classification === null, 'LLM timeout: classification null');
  assert(r1.llmSignal.error.includes('100'), 'LLM timeout: error includes timeout value');
  assert(r1.webSearchSignal.status === 'success', 'LLM timeout: web succeeded');
  assert(r1.classification === 'solution', 'LLM timeout: web search result used');
  assert(r1.confidence === 0.88, `LLM timeout: web confidence used (got ${r1.confidence})`);

  // Web search times out, LLM succeeds
  const r2 = await verifyConcurrent('TimeoutWeb', {
    llmCall: createMockLLM('capability', 0.80, 10),
    webSearchCall: createHangingMock(),
    skipNamingPrecheck: true,
    llmTimeoutMs: 5000,
    webSearchTimeoutMs: 100,
  });
  assert(r2.webSearchSignal.status === 'timeout', 'Web timeout: signal status');
  assert(r2.llmSignal.status === 'success', 'Web timeout: LLM succeeded');
  assert(r2.classification === 'capability', 'Web timeout: LLM result used');

  // Both time out
  const r3 = await verifyConcurrent('BothTimeout', {
    llmCall: createHangingMock(),
    webSearchCall: createHangingMock(),
    skipNamingPrecheck: true,
    llmTimeoutMs: 100,
    webSearchTimeoutMs: 100,
  });
  assert(r3.llmSignal.status === 'timeout', 'Both timeout: LLM signal');
  assert(r3.webSearchSignal.status === 'timeout', 'Both timeout: web signal');
  assert(r3.classification === 'capability', 'Both timeout: defaults to capability');
  assert(r3.confidence === 0, 'Both timeout: 0 confidence');
  assert(r3.verified === false, 'Both timeout: not verified');

  console.log('  Timeout handling tests passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 7: verifyConcurrent — error handling
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 7: verifyConcurrent error handling ---');
{
  // LLM throws, web search succeeds
  const r1 = await verifyConcurrent('ErrorLLM', {
    llmCall: createFailingMock('LLM network error', 5),
    webSearchCall: createMockWebSearch('solution', 0.90, 10),
    skipNamingPrecheck: true,
  });
  assert(r1.llmSignal.status === 'error', 'LLM error: signal status');
  assert(r1.llmSignal.error === 'LLM network error', 'LLM error: message');
  assert(r1.webSearchSignal.status === 'success', 'LLM error: web succeeded');
  assert(r1.classification === 'solution', 'LLM error: web result used');

  // Web search throws — verifyViaWebSearch catches errors internally and
  // returns a fallback result { classification: 'capability', confidence: 0.35 },
  // so our signal sees it as 'success' with the fallback data
  const r2 = await verifyConcurrent('ErrorWeb', {
    llmCall: createMockLLM('capability', 0.85, 10),
    webSearchCall: createFailingMock('Web search 503', 5),
    skipNamingPrecheck: true,
  });
  // Web search's internal error handling returns a fallback, which appears as 'success'
  assert(r2.webSearchSignal.status === 'success', 'Web error: signal shows success (internal fallback)');
  assert(r2.webSearchSignal.confidence <= 0.40, `Web error: low fallback confidence (got ${r2.webSearchSignal.confidence})`);
  assert(r2.llmSignal.status === 'success', 'Web error: LLM succeeded');
  assert(r2.classification === 'capability', 'Web error: LLM+fallback → capability');

  // Both throw: LLM propagates error, web search returns internal fallback
  const r3 = await verifyConcurrent('BothError', {
    llmCall: createFailingMock('LLM crash', 5),
    webSearchCall: createFailingMock('Web crash', 5),
    skipNamingPrecheck: true,
  });
  assert(r3.llmSignal.status === 'error', 'Both error: LLM error (propagated)');
  // Web search catches errors internally → appears as success with fallback
  assert(r3.webSearchSignal.status === 'success', 'Both error: web shows success (internal fallback)');
  assert(r3.webSearchSignal.confidence <= 0.40, `Both error: web low confidence (got ${r3.webSearchSignal.confidence})`);
  assert(r3.classification === 'capability', 'Both error: defaults to capability');
  // LLM failed, web fallback has confidence=0.35 → only web signal used
  assert(r3.confidence <= 0.40, `Both error: low confidence (got ${r3.confidence})`);

  console.log('  Error handling tests passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 8: verifyConcurrent — skip flags
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 8: verifyConcurrent skip flags ---');
{
  // skipLLM flag: web search only
  const r1 = await verifyConcurrent('SkipLLMTest', {
    llmCall: createFailingMock('Should not be called'),
    webSearchCall: createMockWebSearch('solution', 0.85, 10),
    skipLLM: true,
    skipNamingPrecheck: true,
  });
  assert(r1.llmSignal.status === 'skipped', 'skipLLM: LLM skipped');
  assert(r1.llmSignal.reasoning === 'Forced skip', 'skipLLM: reason');
  assert(r1.webSearchSignal.status === 'success', 'skipLLM: web succeeded');
  assert(r1.classification === 'solution', 'skipLLM: web result used');

  // skipWebSearch flag: LLM only
  const r2 = await verifyConcurrent('SkipWebTest', {
    llmCall: createMockLLM('capability', 0.80, 10),
    webSearchCall: createFailingMock('Should not be called'),
    skipWebSearch: true,
    skipNamingPrecheck: true,
  });
  assert(r2.webSearchSignal.status === 'skipped', 'skipWeb: web skipped');
  assert(r2.llmSignal.status === 'success', 'skipWeb: LLM succeeded');
  assert(r2.classification === 'capability', 'skipWeb: LLM result used');

  // Both skipped
  const r3 = await verifyConcurrent('BothSkip', {
    skipLLM: true,
    skipWebSearch: true,
    skipNamingPrecheck: true,
  });
  assert(r3.llmSignal.status === 'skipped', 'Both skip: LLM skipped');
  assert(r3.webSearchSignal.status === 'skipped', 'Both skip: web skipped');
  assert(r3.classification === 'capability', 'Both skip: defaults to capability');
  assert(r3.confidence === 0, 'Both skip: 0 confidence');

  // No backends provided (same as both skipped)
  const r4 = await verifyConcurrent('NoBackends', {
    skipNamingPrecheck: true,
  });
  assert(r4.llmSignal.status === 'skipped', 'No backends: LLM skipped');
  assert(r4.webSearchSignal.status === 'skipped', 'No backends: web skipped');

  console.log('  Skip flags tests passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 9: verifyConcurrent — edge cases
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 9: verifyConcurrent edge cases ---');
{
  // Empty name
  const r1 = await verifyConcurrent('');
  assert(r1.classification === 'capability', 'Empty: defaults to capability');
  assert(r1.confidence === 0, 'Empty: 0 confidence');
  assert(r1.verified === false, 'Empty: not verified');
  assert(r1.llmSignal.status === 'skipped', 'Empty: LLM skipped');
  assert(r1.webSearchSignal.status === 'skipped', 'Empty: web skipped');

  // Null name
  const r2 = await verifyConcurrent(null);
  assert(r2.classification === 'capability', 'Null: defaults to capability');
  assert(r2.verified === false, 'Null: not verified');

  // Whitespace-only name
  const r3 = await verifyConcurrent('   ');
  assert(r3.classification === 'capability', 'Whitespace: defaults to capability');
  assert(r3.verified === false, 'Whitespace: not verified');

  // Undefined name
  const r4 = await verifyConcurrent(undefined);
  assert(r4.classification === 'capability', 'Undefined: defaults to capability');

  console.log('  Edge cases passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 10: DualSignalPair contract validation
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 10: DualSignalPair contract ---');
{
  function validateDualSignalPair(pair, label) {
    // Signal structure
    for (const sigName of ['llmSignal', 'webSearchSignal']) {
      const sig = pair[sigName];
      assert(sig != null, `${label}.${sigName}: present`);
      assert(typeof sig.method === 'string', `${label}.${sigName}: method is string`);
      assert(['success', 'timeout', 'error', 'skipped'].includes(sig.status),
        `${label}.${sigName}: valid status (got ${sig.status})`);
      assert(typeof sig.confidence === 'number', `${label}.${sigName}: confidence is number`);
      assert(typeof sig.durationMs === 'number', `${label}.${sigName}: durationMs is number`);
      assert(typeof sig.reasoning === 'string', `${label}.${sigName}: reasoning is string`);
      // classification can be null (for non-success) or string
      if (sig.status === 'success') {
        assert(sig.classification === 'solution' || sig.classification === 'capability',
          `${label}.${sigName}: success has valid classification (got ${sig.classification})`);
      }
    }

    // Reconciled fields
    assert(pair.classification === 'solution' || pair.classification === 'capability',
      `${label}: classification valid`);
    assert(typeof pair.confidence === 'number' && pair.confidence >= 0 && pair.confidence <= 1,
      `${label}: confidence in [0,1]`);
    assert(typeof pair.method === 'string', `${label}: method is string`);
    assert(typeof pair.reasoning === 'string', `${label}: reasoning is string`);
    assert(typeof pair.verified === 'boolean', `${label}: verified is boolean`);
    assert(typeof pair.totalDurationMs === 'number', `${label}: totalDurationMs is number`);
  }

  // Validate contract for various scenarios
  const scenarios = [
    {
      label: 'both-agree',
      opts: { llmCall: createMockLLM('solution', 0.80, 5), webSearchCall: createMockWebSearch('solution', 0.85, 5), skipNamingPrecheck: true },
    },
    {
      label: 'both-disagree',
      opts: { llmCall: createMockLLM('solution', 0.70, 5), webSearchCall: createMockWebSearch('capability', 0.85, 5), skipNamingPrecheck: true },
    },
    {
      label: 'llm-only',
      opts: { llmCall: createMockLLM('solution', 0.80, 5), skipWebSearch: true, skipNamingPrecheck: true },
    },
    {
      label: 'web-only',
      opts: { webSearchCall: createMockWebSearch('capability', 0.85, 5), skipLLM: true, skipNamingPrecheck: true },
    },
    {
      label: 'both-fail',
      opts: { llmCall: createFailingMock('fail'), webSearchCall: createFailingMock('fail'), skipNamingPrecheck: true },
    },
    {
      label: 'naming-shortcircuit',
      opts: { llmCall: createMockLLM('solution', 0.80, 5) },
    },
  ];

  for (const { label, opts } of scenarios) {
    const pair = await verifyConcurrent('TestComponent_' + label, opts);
    validateDualSignalPair(pair, label);
  }

  // Special: known solution naming short-circuit
  const ksPair = await verifyConcurrent('Kubernetes', {});
  validateDualSignalPair(ksPair, 'kubernetes-naming');

  console.log('  DualSignalPair contract tests passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 11: verifyConcurrentFull — integration with VerifiedClassificationResult
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 11: verifyConcurrentFull ---');
{
  // Known solution: naming short-circuit, full contract
  const r1 = await verifyConcurrentFull('Kubernetes');
  assert(r1.classification === 'solution', 'Full K8s: solution');
  assert(r1.confidence >= 0.90, `Full K8s: confidence >= 0.90 (got ${r1.confidence})`);
  assert(r1.verified === true, 'Full K8s: verified');
  assert(r1.isSolution === true, 'Full K8s: isSolution');
  assert(r1.routingDetection != null, 'Full K8s: routingDetection');
  assert(r1.routingTargets != null, 'Full K8s: routingTargets');
  assert(r1.routingTargets.useSolutionStrategies === true, 'Full K8s: solution routing');
  assert(r1.dualSignals != null, 'Full K8s: dualSignals present');
  assert(r1.dualSignals.llmSignal.status === 'skipped', 'Full K8s: LLM skipped in dualSignals');
  assert(Array.isArray(r1.tiersUsed), 'Full K8s: tiersUsed is array');
  assert(r1.tiersUsed.includes('naming'), 'Full K8s: naming in tiersUsed');

  // Known capability: CRM
  const r2 = await verifyConcurrentFull('CRM');
  assert(r2.classification === 'capability', 'Full CRM: capability');
  assert(r2.isSolution === false, 'Full CRM: not solution');
  assert(r2.routingTargets.useCapabilityStrategies === true, 'Full CRM: capability routing');

  // Ambiguous with mocks: both LLM + web agree
  const r3 = await verifyConcurrentFull('UnknownBrand', {
    llmCall: createMockLLM('solution', 0.82, 10),
    webSearchCall: createMockWebSearch('solution', 0.88, 10),
  });
  assert(r3.classification === 'solution', 'Full ambiguous: solution');
  assert(r3.tiersUsed.includes('llm'), 'Full ambiguous: LLM tier used');
  assert(r3.tiersUsed.includes('web-search'), 'Full ambiguous: web tier used');
  assert(r3.dualSignals.llmSignal.status === 'success', 'Full ambiguous: LLM signal success');
  assert(r3.dualSignals.webSearchSignal.status === 'success', 'Full ambiguous: web signal success');
  assert(r3.verified === true, `Full ambiguous: verified (confidence=${r3.confidence})`);

  // Empty name
  const r4 = await verifyConcurrentFull('');
  assert(r4.classification === 'capability', 'Full empty: capability');
  assert(r4.confidence === 0, 'Full empty: 0 confidence');
  assert(r4.verified === false, 'Full empty: not verified');
  assert(r4.dualSignals != null, 'Full empty: dualSignals present');

  // Null
  const r5 = await verifyConcurrentFull(null);
  assert(r5.classification === 'capability', 'Full null: capability');

  // Concurrent failures with naming fallback
  // LLM crash propagates as error, web crash is caught internally by verifyViaWebSearch
  const r6 = await verifyConcurrentFull('CloudFormation', {
    llmCall: createFailingMock('Crash'),
    webSearchCall: createFailingMock('Crash'),
  });
  assert(r6.classification != null, 'Full failures: still has classification');
  assert(r6.dualSignals.llmSignal.status === 'error', 'Full failures: LLM errored');
  // Web search catches errors internally → appears as success with low-confidence fallback
  assert(r6.dualSignals.webSearchSignal.status === 'success', 'Full failures: web internal fallback');
  assert(r6.dualSignals.webSearchSignal.confidence <= 0.40, 'Full failures: web low confidence fallback');

  console.log('  verifyConcurrentFull tests passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 12: verifyConcurrentFull — parallel mode routing
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 12: verifyConcurrentFull parallel mode ---');
{
  const origMode = process.env.WARDLEY_EVAL_MODE;

  // Parallel mode: both strategy sets
  process.env.WARDLEY_EVAL_MODE = 'parallel';
  const r1 = await verifyConcurrentFull('Kubernetes');
  assert(r1.routingTargets.useSolutionStrategies === true, 'Parallel K8s: solution strategies');
  assert(r1.routingTargets.useCapabilityStrategies === true, 'Parallel K8s: capability strategies');

  const r2 = await verifyConcurrentFull('CRM');
  assert(r2.routingTargets.useSolutionStrategies === true, 'Parallel CRM: solution strategies');
  assert(r2.routingTargets.useCapabilityStrategies === true, 'Parallel CRM: capability strategies');

  // Exclusive mode (default)
  process.env.WARDLEY_EVAL_MODE = 'exclusive';
  const r3 = await verifyConcurrentFull('Kubernetes');
  assert(r3.routingTargets.useSolutionStrategies === true, 'Exclusive K8s: solution only');
  assert(r3.routingTargets.useCapabilityStrategies === false, 'Exclusive K8s: no capability');

  // Reset
  if (origMode != null) {
    process.env.WARDLEY_EVAL_MODE = origMode;
  } else {
    delete process.env.WARDLEY_EVAL_MODE;
  }

  console.log('  Parallel mode routing tests passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 13: Constants and default timeout
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 13: Constants ---');
{
  assert(DEFAULT_SIGNAL_TIMEOUT_MS === 15_000, `Default timeout is 15000ms (got ${DEFAULT_SIGNAL_TIMEOUT_MS})`);
  assert(THRESHOLDS.NAMING_SKIP === 0.90, 'NAMING_SKIP is 0.90');
  assert(THRESHOLDS.LLM_SKIP === 0.85, 'LLM_SKIP is 0.85');
  assert(THRESHOLDS.MIN_VERIFIED === 0.70, 'MIN_VERIFIED is 0.70');
  assert(COMPONENT_TYPE.SOLUTION === 'solution', 'COMPONENT_TYPE.SOLUTION');
  assert(COMPONENT_TYPE.CAPABILITY === 'capability', 'COMPONENT_TYPE.CAPABILITY');

  console.log('  Constants validated');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 14: Mixed timeout and error scenarios
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 14: Mixed timeout+error scenarios ---');
{
  // LLM times out, web search errors (but verifyViaWebSearch catches → fallback)
  const r1 = await verifyConcurrent('MixedFail', {
    llmCall: createHangingMock(),
    webSearchCall: createFailingMock('503 Service Unavailable', 5),
    skipNamingPrecheck: true,
    llmTimeoutMs: 100,
  });
  assert(r1.llmSignal.status === 'timeout', 'Mixed: LLM timed out');
  // Web search catches errors internally → fallback result appears as 'success'
  assert(r1.webSearchSignal.status === 'success', 'Mixed: web internal fallback (appears success)');
  assert(r1.webSearchSignal.confidence <= 0.40, 'Mixed: web low fallback confidence');
  assert(r1.classification === 'capability', 'Mixed: defaults to capability');

  // LLM errors, web search times out (verifyViaWebSearch wrapper hangs → our timeout fires)
  const r2 = await verifyConcurrent('MixedFail2', {
    llmCall: createFailingMock('Rate limit exceeded', 5),
    webSearchCall: createHangingMock(),
    skipNamingPrecheck: true,
    webSearchTimeoutMs: 100,
  });
  assert(r2.llmSignal.status === 'error', 'Mixed2: LLM errored');
  assert(r2.webSearchSignal.status === 'timeout', 'Mixed2: web timed out');
  assert(r2.classification === 'capability', 'Mixed2: defaults to capability');

  // One timeout, one success
  const r3 = await verifyConcurrent('MixedSuccess', {
    llmCall: createHangingMock(),
    webSearchCall: createMockWebSearch('solution', 0.92, 10),
    skipNamingPrecheck: true,
    llmTimeoutMs: 100,
  });
  assert(r3.llmSignal.status === 'timeout', 'Mixed success: LLM timed out');
  assert(r3.webSearchSignal.status === 'success', 'Mixed success: web succeeded');
  assert(r3.classification === 'solution', 'Mixed success: web result used');
  assert(r3.confidence === 0.92, `Mixed success: confidence from web (got ${r3.confidence})`);

  console.log('  Mixed scenarios passed');
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 15: Backward compatibility — existing tests still pass
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n--- Group 15: Backward compatibility ---');
{
  // Import the existing sequential function
  const { verifyClassification, classifyNamingOnly } = await import('./dual-verification-orchestrator.mjs');

  // Verify existing API still works
  const r1 = await verifyClassification('Kubernetes');
  assert(r1.classification === 'solution', 'BC: verifyClassification still works');
  assert(r1.verified === true, 'BC: still verified');
  assert(r1.routingTargets.useSolutionStrategies === true, 'BC: routing targets preserved');

  const r2 = classifyNamingOnly('Salesforce');
  assert(r2.classification === 'solution', 'BC: classifyNamingOnly still works');

  // New exports exist alongside old
  const mod = await import('./dual-verification-orchestrator.mjs');
  assert(typeof mod.verifyConcurrent === 'function', 'BC: verifyConcurrent exported');
  assert(typeof mod.verifyConcurrentFull === 'function', 'BC: verifyConcurrentFull exported');
  assert(typeof mod.verifyClassification === 'function', 'BC: verifyClassification still exported');
  assert(typeof mod.classifyNamingOnly === 'function', 'BC: classifyNamingOnly still exported');
  assert(mod._internal != null, 'BC: _internal exported');
  assert(mod.THRESHOLDS != null, 'BC: THRESHOLDS still exported');
  assert(mod.COMPONENT_TYPE != null, 'BC: COMPONENT_TYPE still exported');

  console.log('  Backward compatibility confirmed');
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
