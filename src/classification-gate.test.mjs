// Test: Classification gate correctly identifies Air as social good triggering re-questioning
// Covers AC 3: Air (atmospheric oxygen for crops)

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

console.log('AC 3: Classification gate — Air (atmospheric oxygen for crops)\n');

// ── Primary test: Air as social good ────────────────────────────────────────

const airResult = classifyComponent('Air', 'Athomospheric oxygen available to grow crops');

assert(airResult.space === 'social_good',
  `Air classified as "${airResult.space}" — expected "social_good"`);

assert(airResult.requiresReQuestion === true,
  `Air requiresReQuestion is ${airResult.requiresReQuestion} — expected true`);

assert(typeof airResult.reason === 'string' && airResult.reason.length > 0,
  `Air has a non-empty reason`);

// ── Re-questioning triggered ────────────────────────────────────────────────

const questions = buildReQuestions(airResult, 'Air');

assert(Array.isArray(questions) && questions.length > 0,
  `Re-questioning produces ${questions.length} follow-up question(s)`);

assert(questions.some(q => q.includes('social good')),
  `At least one question mentions "social good"`);

assert(questions.some(q => q.includes('commodified') || q.includes('industrialized') || q.includes('economic')),
  `At least one question suggests re-framing toward economic context`);

// ── Verify economic components are NOT caught by the gate ───────────────────

console.log('\nVerify economic components pass through gate:\n');

const economicComponents = [
  { name: 'ERP', context: 'Big corporate' },
  { name: 'CRM', context: 'Enterprise software for sales teams' },
  { name: 'LLM', context: 'Automatic text generation for coding assistance' },
  { name: 'Wardley Mapping', context: 'Decision making framework for business strategy' },
  { name: 'Electricity', context: 'Western power supply today' },
  { name: 'Electricity', context: 'Western power supply in the late 20th century' },
];

for (const comp of economicComponents) {
  const result = classifyComponent(comp.name, comp.context);
  assert(result.space === 'economic',
    `${comp.name} classified as "${result.space}" — expected "economic"`);
  assert(result.requiresReQuestion === false,
    `${comp.name} requiresReQuestion is ${result.requiresReQuestion} — expected false`);
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
