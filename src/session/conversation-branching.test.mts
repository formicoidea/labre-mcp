// Test suite for conversational mode classification branching (Sub-AC 1)
//
// Verifies that the conversation session correctly detects solution vs capability
// inputs and branches to distinct question paths:
//   - Solutions → solution_context phase → ready
//   - Capabilities → characteristics → market_signals → ready

import { ConversationSession } from './conversation-session.mjs';

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    tests.push({ name, status: 'PASS' });
  } catch (e) {
    failed++;
    tests.push({ name, status: 'FAIL', error: e.message });
  }
}

// === ROUTING ACCURACY ===
test('Kubernetes detected as solution', () => {
  const s = new ConversationSession();
  s.update({ name: 'Kubernetes' });
  if (s.state.componentType !== 'solution') throw new Error('Expected solution');
  if (s.state.componentTypeConfidence < 0.90) throw new Error('Expected high confidence');
});

test('Salesforce detected as solution', () => {
  const s = new ConversationSession();
  s.update({ name: 'Salesforce' });
  if (s.state.componentType !== 'solution') throw new Error('Expected solution');
});

test('Docker detected as solution', () => {
  const s = new ConversationSession();
  s.update({ name: 'Docker' });
  if (s.state.componentType !== 'solution') throw new Error('Expected solution');
});

test('CRM detected as capability', () => {
  const s = new ConversationSession();
  s.update({ name: 'CRM' });
  if (s.state.componentType !== 'capability') throw new Error('Expected capability');
});

test('container orchestration detected as capability', () => {
  const s = new ConversationSession();
  s.update({ name: 'container orchestration' });
  if (s.state.componentType !== 'capability') throw new Error('Expected capability');
});

test('ERP detected as capability', () => {
  const s = new ConversationSession();
  s.update({ name: 'ERP' });
  if (s.state.componentType !== 'capability') throw new Error('Expected capability');
});

// === BRANCHING ACCURACY ===
test('Solution branches to solution_context phase', () => {
  const s = new ConversationSession();
  s.update({ name: 'Kubernetes', description: 'Container orchestration' });
  if (s.phase !== 'solution_context') throw new Error('Expected solution_context, got ' + s.phase);
});

test('Capability stays on characteristics phase', () => {
  const s = new ConversationSession();
  s.update({ name: 'CRM', description: 'Customer management' });
  if (s.phase !== 'characteristics') throw new Error('Expected characteristics, got ' + s.phase);
});

test('Non-economic component goes to ready (re-questioning)', () => {
  const s = new ConversationSession();
  s.update({ name: 'Air', description: 'Atmospheric oxygen' });
  if (s.phase !== 'ready') throw new Error('Expected ready, got ' + s.phase);
  if (!s.isNonEconomic()) throw new Error('Expected non-economic');
});

// === SOLUTION PATH COMPLETION ===
test('Solution path: solutionContext triggers ready', () => {
  const s = new ConversationSession();
  s.update({ name: 'AWS' });
  s.update({ solutionContext: 'Market leader cloud platform' });
  if (s.phase !== 'ready') throw new Error('Expected ready after solutionContext');
});

test('Solution path: marketDynamics triggers ready', () => {
  const s = new ConversationSession();
  s.update({ name: 'PostgreSQL' });
  s.update({ marketDynamics: 'Many alternatives, open source' });
  if (s.phase !== 'ready') throw new Error('Expected ready after marketDynamics');
});

test('Solution path: adoptionPattern triggers ready', () => {
  const s = new ConversationSession();
  s.update({ name: 'Docker' });
  s.update({ adoptionPattern: 'Universal adoption in dev' });
  if (s.phase !== 'ready') throw new Error('Expected ready after adoptionPattern');
});

// === CAPABILITY PATH UNCHANGED ===
test('Capability path: needs certitude/ubiquity for characteristics to market_signals', () => {
  const s = new ConversationSession();
  s.update({ name: 'monitoring' });
  if (s.phase !== 'characteristics') throw new Error('Expected characteristics');
  s.update({ certitude: 0.8 });
  if (s.phase !== 'market_signals') throw new Error('Expected market_signals after certitude');
});

test('Capability path: full flow identity-classification-characteristics-market_signals-ready', () => {
  const s = new ConversationSession();
  s.update({ name: 'data analytics', description: 'Analyzing business data' });
  if (s.phase !== 'characteristics') throw new Error('Step 1 failed: ' + s.phase);
  s.update({ certitude: 0.7, ubiquity: 0.6 });
  if (s.phase !== 'market_signals') throw new Error('Step 2 failed: ' + s.phase);
  s.update({
    phaseDistribution: {
      bins: [
        { position: 0.09, probability: 0.1 },
        { position: 0.29, probability: 0.2 },
        { position: 0.48, probability: 0.3 },
        { position: 0.85, probability: 0.4 },
      ],
    },
  });
  if (s.phase !== 'ready') throw new Error('Step 3 failed: ' + s.phase);
});

// === API METHODS ===
test('isSolution() returns true for solutions', () => {
  const s = new ConversationSession();
  s.update({ name: 'Kubernetes' });
  if (!s.isSolution()) throw new Error('Expected true');
});

test('isCapability() returns true for capabilities', () => {
  const s = new ConversationSession();
  s.update({ name: 'CRM' });
  if (!s.isCapability()) throw new Error('Expected true');
});

test('needsComponentTypeFallback() false for known solutions', () => {
  const s = new ConversationSession();
  s.update({ name: 'Kubernetes' });
  if (s.needsComponentTypeFallback()) throw new Error('Expected false');
});

test('needsComponentTypeFallback() true for unknown components', () => {
  const s = new ConversationSession();
  s.update({ name: 'MyCustomApp' });
  if (!s.needsComponentTypeFallback()) throw new Error('Expected true');
});

test('getComponentTypeDetection() returns correct shape', () => {
  const s = new ConversationSession();
  s.update({ name: 'Kubernetes' });
  const d = s.getComponentTypeDetection();
  if (d.type !== 'solution') throw new Error('Wrong type');
  if (d.confidence !== 0.98) throw new Error('Wrong confidence');
  if (d.needsFallback !== false) throw new Error('Wrong fallback');
});

// === SERIALIZATION ===
test('Serialization preserves componentType fields', () => {
  const s = new ConversationSession();
  s.update({ name: 'Docker', solutionContext: 'Leading containerization tool' });
  const json = s.serialize();
  const r = ConversationSession.deserialize(json);
  if (r.state.componentType !== 'solution') throw new Error('componentType lost');
  if (r.state.componentTypeConfidence !== 0.98) throw new Error('confidence lost');
  if (r.state.solutionContext !== 'Leading containerization tool') throw new Error('solutionContext lost');
});

// === COMPONENT INPUT ===
test('buildComponentInput() includes solution fields for solutions', () => {
  const s = new ConversationSession();
  s.update({ name: 'Kafka', solutionContext: 'Event streaming platform' });
  const input = s.buildComponentInput();
  if (input.kind !== 'solution') throw new Error('Wrong kind: ' + input.kind);
  if (input.componentType !== 'solution') throw new Error('Missing componentType');
  if (!input.context || !input.context.includes('Event streaming platform')) {
    throw new Error('Missing market position in composed context, got: ' + input.context);
  }
});

test('buildComponentInput() yields kind=capability for capabilities', () => {
  const s = new ConversationSession();
  s.update({ name: 'CRM', certitude: 0.9, ubiquity: 0.8 });
  const input = s.buildComponentInput();
  if (input.kind !== 'capability') throw new Error('Wrong kind: ' + input.kind);
  if (input.componentType !== 'capability') throw new Error('Wrong componentType');
});

// === NEXT QUESTION ===
test('nextQuestion() returns solution_context template for solutions', () => {
  const s = new ConversationSession();
  s.update({ name: 'Kubernetes' });
  const q = s.nextQuestion();
  if (q.phase !== 'solution_context') throw new Error('Wrong phase: ' + q.phase);
  if (!q.prompt.includes('12-property')) throw new Error('Missing 12-property reference');
});

test('nextQuestion() returns characteristics template for capabilities', () => {
  const s = new ConversationSession();
  s.update({ name: 'CRM' });
  const q = s.nextQuestion();
  if (q.phase !== 'characteristics') throw new Error('Wrong phase: ' + q.phase);
});

// === SUMMARY ===
test('getSummary() includes componentType', () => {
  const s = new ConversationSession();
  s.update({ name: 'Kubernetes' });
  const sum = s.getSummary();
  if (sum.componentType !== 'solution') throw new Error('Missing componentType');
  if (!sum.gathered.componentType) throw new Error('Missing gathered componentType');
});

test('getSummary() shows solution-specific missing fields for solutions', () => {
  const s = new ConversationSession();
  s.update({ name: 'Kubernetes' });
  const sum = s.getSummary();
  // Solution path should NOT list certitude/ubiquity as missing
  if (sum.missing.includes('certitude')) throw new Error('Should not list certitude for solutions');
  if (sum.missing.includes('ubiquity')) throw new Error('Should not list ubiquity for solutions');
});

test('getSummary() shows capability-specific missing fields for capabilities', () => {
  const s = new ConversationSession();
  s.update({ name: 'CRM' });
  const sum = s.getSummary();
  // Capability path should list certitude/ubiquity as missing
  if (!sum.missing.includes('certitude')) throw new Error('Should list certitude for capabilities');
  if (!sum.missing.includes('ubiquity')) throw new Error('Should list ubiquity for capabilities');
  // Capability path should NOT list solutionContext as missing
  if (sum.missing.includes('solutionContext')) throw new Error('Should not list solutionContext for capabilities');
});

// === HISTORY TRACKING ===
test('History records solution branching decision', () => {
  const s = new ConversationSession();
  s.update({ name: 'Kubernetes', description: 'Container orchestration' });
  const hasBranchLog = s.state.history.some(h => h.includes('branching to solution path'));
  if (!hasBranchLog) throw new Error('Missing branching history entry');
});

// === PRINT RESULTS ===
console.log('\n=== Conversational Mode Classification Branching Test Suite ===\n');
for (const t of tests) {
  const icon = t.status === 'PASS' ? '\u2713' : '\u2717';
  console.log(`  ${icon} ${t.name}${t.error ? ' \u2014 ' + t.error : ''}`);
}
console.log(`\n  Result: ${passed} passed, ${failed} failed out of ${tests.length} tests\n`);

if (failed > 0) {
  process.exit(1);
}
