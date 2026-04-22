// Tests for mode-router.mjs — mode selection logic
//
// Verifies:
//   1. Explicit mode parameter routing
//   2. Auto-detection heuristics
//   3. Shared response formatting across modes
//   4. Session continuity in guided mode
//   5. Edge cases and aliases

import { detectMode, routeEstimateEvolution, MODES } from './mode-router.mjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${message}`);
  }
}

console.log('=== mode-router.test.mjs ===\n');

// ── 1. Explicit Mode Parameter ─────────────────────────────────────────

console.log('--- 1. Explicit mode parameter ---');

assert(detectMode({ name: 'X', mode: 'oneshot' }).mode === MODES.ONESHOT, 'mode=oneshot → ONESHOT');
assert(detectMode({ name: 'X', mode: 'guided' }).mode === MODES.GUIDED, 'mode=guided → GUIDED');
assert(detectMode({ name: 'X', mode: 'conversational' }).mode === MODES.GUIDED, 'mode=conversational → GUIDED');
assert(detectMode({ name: 'X', mode: 'one-shot' }).mode === MODES.ONESHOT, 'mode=one-shot → ONESHOT');
assert(detectMode({ name: 'X', mode: 'interactive' }).mode === MODES.GUIDED, 'mode=interactive → GUIDED');
assert(detectMode({ name: 'X', mode: 'multi-turn' }).mode === MODES.GUIDED, 'mode=multi-turn → GUIDED');
assert(detectMode({ name: 'X', mode: 'single' }).mode === MODES.ONESHOT, 'mode=single → ONESHOT');
assert(detectMode({ name: 'X', mode: 'direct' }).mode === MODES.ONESHOT, 'mode=direct → ONESHOT');

// ── 2. Auto-Detection Heuristics ───────────────────────────────────────

console.log('\n--- 2. Auto-detection heuristics ---');

// sessionState → guided
assert(
  detectMode({ name: 'X', sessionState: '{}' }).mode === MODES.GUIDED,
  'sessionState present → guided'
);

// space provided → oneshot
assert(
  detectMode({ name: 'X', space: 'economic' }).mode === MODES.ONESHOT,
  'space=economic → oneshot'
);
assert(
  detectMode({ name: 'X', space: 'social_good' }).mode === MODES.ONESHOT,
  'space=social_good → oneshot (classification handles re-question)'
);

// Sufficient s-curve params → oneshot
assert(
  detectMode({ name: 'X', certitude: 0.8, ubiquity: 0.7 }).mode === MODES.ONESHOT,
  'certitude+ubiquity → oneshot'
);

// Sufficient phase distribution → oneshot
assert(
  detectMode({
    name: 'X',
    phaseDistribution: {
      bins: [
        { position: 0.09, probability: 0.1 },
        { position: 0.29, probability: 0.2 },
        { position: 0.48, probability: 0.3 },
        { position: 0.85, probability: 0.4 },
      ],
    },
  }).mode === MODES.ONESHOT,
  'phaseDistribution → oneshot',
);

// Partial params → guided
assert(
  detectMode({ name: 'X', certitude: 0.8 }).mode === MODES.GUIDED,
  'only certitude (no ubiquity) → guided'
);
assert(
  detectMode({ name: 'X', phaseDistribution: { bins: [] } }).mode === MODES.GUIDED,
  'empty phaseDistribution bins → guided',
);

// Minimal input → guided
assert(
  detectMode({ name: 'X' }).mode === MODES.GUIDED,
  'only name → guided'
);
assert(
  detectMode({ name: 'X', description: 'Something' }).mode === MODES.GUIDED,
  'name+description → guided'
);

// ── 3. mode=auto and mode=default trigger auto-detection ───────────────

console.log('\n--- 3. Auto/default mode triggers auto-detection ---');

assert(
  detectMode({ name: 'X', mode: 'auto', certitude: 0.8, ubiquity: 0.7 }).mode === MODES.ONESHOT,
  'mode=auto with params → auto-detects oneshot'
);
assert(
  detectMode({ name: 'X', mode: 'default', certitude: 0.8, ubiquity: 0.7 }).mode === MODES.ONESHOT,
  'mode=default with params → auto-detects oneshot'
);
assert(
  detectMode({ name: 'X', mode: 'auto' }).mode === MODES.GUIDED,
  'mode=auto without params → auto-detects guided'
);

// ── 4. Mode reason is always provided ──────────────────────────────────

console.log('\n--- 4. Mode reason provided ---');

const d1 = detectMode({ name: 'X', mode: 'oneshot' });
assert(d1.reason.includes('explicit'), 'explicit mode has reason with "explicit"');

const d2 = detectMode({ name: 'X', sessionState: '{}' });
assert(d2.reason.includes('sessionState'), 'sessionState detection has reason');

const d3 = detectMode({ name: 'X', space: 'economic' });
assert(d3.reason.includes('space'), 'space detection has reason');

const d4 = detectMode({ name: 'X', certitude: 0.8, ubiquity: 0.7 });
assert(d4.reason.includes('sufficient'), 'param detection has reason with "sufficient"');

const d5 = detectMode({ name: 'X' });
assert(d5.reason.includes('insufficient'), 'minimal input has reason with "insufficient"');

// ── 5. Edge Cases ──────────────────────────────────────────────────────

console.log('\n--- 5. Edge cases ---');

assert(detectMode(null).mode === MODES.GUIDED, 'null input → guided');
assert(detectMode({}).mode === MODES.GUIDED, 'empty object → guided');
assert(detectMode(undefined).mode === MODES.GUIDED, 'undefined → guided');

// Unknown mode string
const unknownMode = detectMode({ name: 'X', mode: 'foobar' });
assert(unknownMode.mode === MODES.GUIDED, 'unknown mode string → guided');

// ── 6. Full Route: One-Shot ────────────────────────────────────────────

console.log('\n--- 6. Full route: one-shot ---');

const r1 = await routeEstimateEvolution({
  name: 'ERP',
  description: 'Enterprise resource planning',
  space: 'economic',
  strategy: 'write:capacity:s-curve',
  certitude: 0.9,
  ubiquity: 0.85,
});
assert(r1.mode === MODES.ONESHOT, 'one-shot route returns mode=oneshot');
assert(r1.modeReason != null && r1.modeReason.length > 0, 'one-shot has modeReason');
assert(r1.classification != null, 'one-shot has classification');
assert(r1.evaluations != null, 'one-shot has evaluations');
assert(r1.formatted != null && r1.formatted.length > 0, 'one-shot has formatted output');
assert(r1.sessionState === null, 'one-shot has no sessionState');
assert(r1.nextQuestion === null, 'one-shot has no nextQuestion');
assert(r1.phase === null, 'one-shot has no phase');

// ── 7. Full Route: Guided First Turn ───────────────────────────────────

console.log('\n--- 7. Full route: guided first turn ---');

const r2 = await routeEstimateEvolution({
  name: 'Kubernetes',
  description: 'Container orchestration platform',
});
assert(r2.mode === MODES.GUIDED, 'guided route returns mode=guided');
assert(r2.modeReason != null, 'guided has modeReason');
assert(r2.sessionState != null, 'guided has sessionState');
assert(r2.formatted != null && r2.formatted.length > 0, 'guided has formatted output');
// Guided intermediate: might have nextQuestion or be complete depending on auto-classification
assert(r2.phase != null, 'guided has a phase');

// ── 8. Full Route: Guided Continuation ─────────────────────────────────

console.log('\n--- 8. Full route: guided continuation ---');

const r3 = await routeEstimateEvolution({
  sessionState: r2.sessionState,
  certitude: 0.7,
  ubiquity: 0.6,
});
assert(r3.mode === MODES.GUIDED, 'continuation is guided');
assert(r3.sessionState != null, 'continuation has sessionState');

// ── 9. Shared Response Shape ───────────────────────────────────────────

console.log('\n--- 9. Shared response shape ---');

const sharedKeys = ['mode', 'modeReason', 'classification', 'reQuestions', 'evaluations', 'message', 'formatted', 'sessionState', 'nextQuestion', 'phase'];
for (const key of sharedKeys) {
  assert(key in r1, `one-shot response has key: ${key}`);
  assert(key in r2, `guided response has key: ${key}`);
}

// ── 10. Social Good via Mode Router ────────────────────────────────────

console.log('\n--- 10. Social good handling ---');

const r4 = await routeEstimateEvolution({
  name: 'Air',
  description: 'Atmospheric oxygen',
  mode: 'oneshot',
});
assert(r4.mode === MODES.ONESHOT, 'social good in oneshot mode');
assert(r4.classification?.space === 'social_good', 'classified as social_good');
assert(r4.reQuestions != null && r4.reQuestions.length > 0, 'has re-questions');
assert(r4.evaluations === null, 'no evaluations for social good');
assert(r4.formatted.includes('Outside Economic Space') || r4.formatted.includes('social'), 'formatted mentions non-economic');

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
