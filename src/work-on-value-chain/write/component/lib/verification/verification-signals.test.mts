/**
 * Unit tests for verification-signals.mjs
 *
 * Validates the five exported functions:
 *   - raceWithTimeout
 *   - buildSuccessSignal
 *   - buildTimeoutSignal
 *   - buildErrorSignal
 *   - buildSkippedSignal
 */

import {
  raceWithTimeout,
  buildSuccessSignal,
  buildTimeoutSignal,
  buildErrorSignal,
  buildSkippedSignal,
} from './verification-signals.mjs';

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

// ─── buildSuccessSignal ────────────────────────────────────────────────────────

console.log('--- buildSuccessSignal ---');
{
  const result = { classification: 'solution', confidence: 0.95, reasoning: 'known product' };
  const signal = buildSuccessSignal(result, 'llm', 120);
  assert(signal.status === 'success', 'status should be success');
  assert(signal.classification === 'solution', 'classification should pass through');
  assert(signal.confidence === 0.95, 'confidence should pass through');
  assert(signal.method === 'llm', 'method should be llm');
  assert(signal.reasoning === 'known product', 'reasoning should pass through');
  assert(signal.durationMs === 120, 'durationMs should be 120');
  assert(signal.raw === result, 'raw should reference original result');
}
{
  // Missing fields default gracefully
  const signal = buildSuccessSignal({}, 'web-search', 50);
  assert(signal.classification === null, 'missing classification defaults to null');
  assert(signal.confidence === 0, 'missing confidence defaults to 0');
  assert(signal.reasoning === '', 'missing reasoning defaults to empty string');
}

// ─── buildTimeoutSignal ────────────────────────────────────────────────────────

console.log('--- buildTimeoutSignal ---');
{
  const signal = buildTimeoutSignal('llm', 5000, 5001);
  assert(signal.status === 'timeout', 'status should be timeout');
  assert(signal.classification === null, 'classification should be null');
  assert(signal.confidence === 0, 'confidence should be 0');
  assert(signal.method === 'llm', 'method should be llm');
  assert(signal.durationMs === 5001, 'durationMs should match');
  assert(signal.reasoning.includes('5000'), 'reasoning should mention timeout value');
  assert(signal.error.includes('5000'), 'error should mention timeout value');
}

// ─── buildErrorSignal ──────────────────────────────────────────────────────────

console.log('--- buildErrorSignal ---');
{
  const err = new Error('connection refused');
  const signal = buildErrorSignal('web-search', err, 300);
  assert(signal.status === 'error', 'status should be error');
  assert(signal.classification === null, 'classification should be null');
  assert(signal.confidence === 0, 'confidence should be 0');
  assert(signal.method === 'web-search', 'method should be web-search');
  assert(signal.durationMs === 300, 'durationMs should match');
  assert(signal.error === 'connection refused', 'error should contain message');
  assert(signal.reasoning.includes('connection refused'), 'reasoning should contain error message');
}

// ─── buildSkippedSignal ────────────────────────────────────────────────────────

console.log('--- buildSkippedSignal ---');
{
  const signal = buildSkippedSignal('llm', 'No LLM configured');
  assert(signal.status === 'skipped', 'status should be skipped');
  assert(signal.classification === null, 'classification should be null');
  assert(signal.confidence === 0, 'confidence should be 0');
  assert(signal.method === 'llm', 'method should be llm');
  assert(signal.reasoning === 'No LLM configured', 'reasoning should match');
  assert(signal.durationMs === 0, 'durationMs should be 0');
}

// ─── raceWithTimeout ───────────────────────────────────────────────────────────

console.log('--- raceWithTimeout ---');
{
  // Fast resolve
  const r1 = await raceWithTimeout(Promise.resolve('ok'), 1000, 'test');
  assert(r1.value === 'ok', 'should resolve with value');
  assert(r1.timedOut === false, 'should not be timed out');
}
{
  // Timeout
  const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 5000));
  const r2 = await raceWithTimeout(slow, 50, 'test');
  assert(r2.value === null, 'value should be null on timeout');
  assert(r2.timedOut === true, 'should be timed out');
}
{
  // Error capture
  const failing = Promise.reject(new Error('boom'));
  const r3 = await raceWithTimeout(failing, 1000, 'test');
  assert(r3.timedOut === false, 'should not be timed out');
  assert(r3.error?.message === 'boom', 'should capture error');
  assert(r3.value === null, 'value should be null on error');
}

// ─── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
