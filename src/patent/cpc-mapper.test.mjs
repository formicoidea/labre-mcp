// Test: mapCapabilityToCPC orchestrator
//
// Verifies the cascading resolution strategy:
//   1. LLM → validated CPC codes
//   2. Hardcoded fallback on empty/error
//   3. Ultimate default (G06F) guarantees non-empty
//
// Return contract: always 1-5 element array of valid CPC codes.

import assert from 'node:assert/strict';
import {
  mapCapabilityToCPC,
  llmMapCapabilityToCPC,
  lookupFallback,
  isValidCpcCode,
  CPC_PRIMARY_REGEX,
} from './cpc-mapper.mjs';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Mock LLM that returns valid CPC codes */
function mockLlmSuccess(response) {
  return async () => response;
}

/** Mock LLM that throws an error */
function mockLlmError() {
  return async () => { throw new Error('LLM unavailable'); };
}

/** Mock LLM that returns garbage (no valid codes extractable) */
function mockLlmGarbage() {
  return async () => 'Sorry, I cannot determine the CPC codes for this.';
}

/** Mock LLM returning exactly N valid codes */
function mockLlmCodes(codes) {
  return async () => codes.join('\n');
}

// ── Return contract tests ─────────────────────────────────────────────────────

console.log('── mapCapabilityToCPC: return contract ──');

// Test: always returns an array
{
  const result = await mapCapabilityToCPC('cloud computing');
  assert.ok(Array.isArray(result), 'Result must be an array');
  console.log('  ✓ returns an array');
}

// Test: array has 1-5 elements (never empty)
{
  const testCases = [
    'cloud computing',
    'blockchain',
    'quantum teleportation of cheese', // unlikely to match anything
    '', // empty string
    null, // null input
    undefined, // undefined input
  ];

  for (const cap of testCases) {
    const result = await mapCapabilityToCPC(cap);
    assert.ok(result.length >= 1, `Result for "${cap}" must have >= 1 element, got ${result.length}`);
    assert.ok(result.length <= 5, `Result for "${cap}" must have <= 5 elements, got ${result.length}`);
  }
  console.log('  ✓ always returns 1-5 elements (never empty, never >5)');
}

// Test: all returned codes are valid CPC codes
{
  const result = await mapCapabilityToCPC('machine learning');
  for (const code of result) {
    assert.ok(isValidCpcCode(code), `"${code}" must be a valid CPC code`);
  }
  console.log('  ✓ all returned codes pass isValidCpcCode');
}

// ── LLM path tests ───────────────────────────────────────────────────────────

console.log('── mapCapabilityToCPC: LLM path ──');

// Test: uses LLM codes when LLM succeeds
{
  const result = await mapCapabilityToCPC('container orchestration', {
    llmCall: mockLlmCodes(['G06F', 'H04L']),
  });
  assert.deepEqual(result, ['G06F', 'H04L'], 'Should return LLM codes when LLM succeeds');
  console.log('  ✓ uses LLM codes on success');
}

// Test: caps LLM results at 5
{
  const result = await mapCapabilityToCPC('everything tech', {
    llmCall: mockLlmCodes(['G06F', 'H04L', 'G06N', 'H01L', 'G06Q', 'B33Y', 'A61K']),
  });
  assert.ok(result.length <= 5, `LLM returned 7 codes but result should be capped at 5, got ${result.length}`);
  console.log('  ✓ caps LLM results at 5 elements');
}

// ── Fallback path tests ──────────────────────────────────────────────────────

console.log('── mapCapabilityToCPC: fallback path ──');

// Test: falls back to hardcoded map on LLM error
{
  const result = await mapCapabilityToCPC('blockchain', {
    llmCall: mockLlmError(),
  });
  assert.ok(result.length >= 1, 'Should fall back to hardcoded map on LLM error');
  assert.ok(result.includes('H04L'), 'Blockchain should map to H04L from fallback');
  console.log('  ✓ falls back to hardcoded map on LLM error');
}

// Test: falls back to hardcoded map on LLM returning garbage
{
  const result = await mapCapabilityToCPC('semiconductor', {
    llmCall: mockLlmGarbage(),
  });
  assert.ok(result.length >= 1, 'Should fall back on LLM garbage response');
  assert.ok(result.includes('H01L'), 'Semiconductor should map to H01L from fallback');
  console.log('  ✓ falls back to hardcoded map on LLM garbage');
}

// Test: falls back to hardcoded map on empty LLM result
{
  const result = await mapCapabilityToCPC('database', {
    llmCall: mockLlmCodes([]),
  });
  assert.ok(result.length >= 1, 'Should fall back on empty LLM result');
  assert.ok(result.includes('G06F'), 'Database should map to G06F from fallback');
  console.log('  ✓ falls back to hardcoded map on empty LLM result');
}

// ── Ultimate default path tests ──────────────────────────────────────────────

console.log('── mapCapabilityToCPC: ultimate default ──');

// Test: returns G06F for completely unmappable capability
{
  const result = await mapCapabilityToCPC('xyzzy plugh quantum cheese teleporter', {
    llmCall: mockLlmGarbage(),
  });
  assert.deepEqual(result, ['G06F'], 'Should return ultimate default G06F for unmappable capability');
  console.log('  ✓ returns G06F ultimate default for unmappable capability');
}

// Test: returns G06F for empty/null/undefined input
{
  for (const input of ['', null, undefined]) {
    const result = await mapCapabilityToCPC(input, {
      llmCall: mockLlmError(), // LLM should not even be called for empty input
    });
    assert.deepEqual(result, ['G06F'], `Should return G06F for "${input}" input`);
  }
  console.log('  ✓ returns G06F for empty/null/undefined input');
}

// ── Never-throws contract ────────────────────────────────────────────────────

console.log('── mapCapabilityToCPC: never throws ──');

// Test: never throws even with broken llmCall
{
  const result = await mapCapabilityToCPC('machine learning', {
    llmCall: () => { throw new TypeError('unexpected sync throw'); },
  });
  assert.ok(Array.isArray(result), 'Should not throw, should return fallback');
  assert.ok(result.length >= 1, 'Should return at least 1 code');
  console.log('  ✓ never throws on sync LLM error');
}

// Test: never throws on non-string input
{
  const result = await mapCapabilityToCPC(12345);
  assert.ok(Array.isArray(result) && result.length >= 1, 'Should handle non-string gracefully');
  console.log('  ✓ handles non-string input gracefully');
}

// ── Deduplication ────────────────────────────────────────────────────────────

console.log('── mapCapabilityToCPC: deduplication ──');

// Test: LLM codes are deduplicated
{
  const result = await mapCapabilityToCPC('networking', {
    llmCall: mockLlmCodes(['H04L', 'H04L', 'G06F', 'G06F', 'H04W']),
  });
  const unique = new Set(result);
  assert.equal(result.length, unique.size, 'Should not contain duplicates');
  console.log('  ✓ LLM codes are deduplicated');
}

console.log('\n✅ All mapCapabilityToCPC tests passed');
