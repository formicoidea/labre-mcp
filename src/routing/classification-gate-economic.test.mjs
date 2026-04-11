// Test: Classification gate correctly identifies economic space components
// Covers AC 4: ERP, CRM, LLM, Wardley Mapping, Electricity pass to evaluation strategies

import { classifyComponent, buildReQuestions } from './classification-gate.mjs';

let failures = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failures++;
  } else {
    console.log(`  PASS: ${message}`);
  }
}

console.log('AC 4: Classification gate — Economic space components\n');

// ── Test all 5 economic components from the promptfoo test cases ────────────

const economicComponents = [
  { name: 'ERP', context: 'Big corporate' },
  { name: 'CRM', context: 'Enterprise software for sales teams' },
  { name: 'LLM', context: 'Automatic text generation for coding assistance' },
  { name: 'Wardley Mapping', context: 'Decision making framework for business strategy' },
  { name: 'Electricity', context: 'Western power supply today' },
  { name: 'Electricity', context: 'Western power supply in the late 20th century' },
];

for (const comp of economicComponents) {
  console.log(`── ${comp.name} (${comp.context}) ──`);
  const result = classifyComponent(comp.name, comp.context);

  // Must be classified as economic
  assert(result.space === 'economic',
    `${comp.name} classified as "${result.space}" — expected "economic"`);

  // Must NOT require re-questioning (passes directly to evaluation)
  assert(result.requiresReQuestion === false,
    `${comp.name} requiresReQuestion is ${result.requiresReQuestion} — expected false`);

  // Must have a reason string
  assert(typeof result.reason === 'string' && result.reason.length > 0,
    `${comp.name} has a non-empty reason`);

  // buildReQuestions must return empty array for economic components
  const questions = buildReQuestions(result, comp.name);
  assert(Array.isArray(questions) && questions.length === 0,
    `${comp.name} produces 0 re-questions (got ${questions.length})`);

  console.log();
}

// ── Verify interface shape matches what strategies expect ────────────────────

console.log('── Interface shape verification ──');
const sample = classifyComponent('ERP', 'Big corporate');
assert('space' in sample, 'Result has "space" property');
assert('reason' in sample, 'Result has "reason" property');
assert('requiresReQuestion' in sample, 'Result has "requiresReQuestion" property');
assert(typeof sample.space === 'string', '"space" is a string');
assert(typeof sample.reason === 'string', '"reason" is a string');
assert(typeof sample.requiresReQuestion === 'boolean', '"requiresReQuestion" is a boolean');

// ── Verify these components are NOT confused with social/common goods ───────

console.log('\n── Negative tests: no false positives ──');
const allResults = economicComponents.map(c => classifyComponent(c.name, c.context));
assert(allResults.every(r => r.space !== 'social_good'),
  'No economic component is misclassified as social_good');
assert(allResults.every(r => r.space !== 'common_good'),
  'No economic component is misclassified as common_good');

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
