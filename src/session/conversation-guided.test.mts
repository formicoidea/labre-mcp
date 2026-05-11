// Test: Conversational guided interaction mode
//
// Verifies that the multi-turn conversational flow:
//   1. Progressively asks clarifying questions across phases
//   2. Accumulates context across multiple exchanges
//   3. Produces a final estimation when enough data is gathered
//   4. Handles non-economic components with re-questioning
//   5. Supports force-estimate with partial data
//   6. Preserves session state across serialization

import { ConversationSession, inferFromMaturitySignals, inferFromMarketSignals } from './conversation-session.mjs';
import { estimateEvolutionConversational } from '#work-on-evolution/write/estimate-evolution.mjs';
import { handleConversationalInvocation, formatConversationalTurn } from '#work-on-evolution/write/skill-handler.mjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.log(`  \u2717 ${message}`);
  }
}

console.log('=== Conversational Guided Interaction Tests ===\n');

// ────────────────────────────────────────────────────────────────────────────
// Test 1: Full multi-turn conversation for an economic component
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 1: Full multi-turn conversation (ERP) ---');
{
  // Turn 1: Start fresh — no session, no data → should ask for identity
  const turn1 = await estimateEvolutionConversational({});
  assert(turn1.mode === 'conversational', 'Turn 1: mode is conversational');
  assert(turn1.phase === 'identity', 'Turn 1: phase is identity');
  assert(turn1.nextQuestion !== null, 'Turn 1: has next question');
  assert(turn1.nextQuestion.phase === 'identity', 'Turn 1: question is about identity');
  assert(turn1.evaluations === null, 'Turn 1: no evaluations yet');
  assert(typeof turn1.sessionState === 'string', 'Turn 1: has serialized session state');

  // Turn 2: Provide name and description → should auto-classify as economic → ask characteristics
  const turn2 = await estimateEvolutionConversational({
    sessionState: turn1.sessionState,
    data: { name: 'ERP', description: 'Enterprise resource planning for large corporations' },
  });
  assert(turn2.phase === 'characteristics', 'Turn 2: phase advanced to characteristics');
  assert(turn2.nextQuestion !== null, 'Turn 2: has next question');
  assert(turn2.nextQuestion.fields.includes('certitude'), 'Turn 2: asks for certitude');
  assert(turn2.evaluations === null, 'Turn 2: no evaluations yet');
  assert(turn2.summary.gathered.name === 'ERP', 'Turn 2: name is gathered');

  // Turn 3: Provide certitude and ubiquity → should advance to market_signals
  const turn3 = await estimateEvolutionConversational({
    sessionState: turn2.sessionState,
    data: { certitude: 0.9, ubiquity: 0.85 },
  });
  assert(turn3.phase === 'market_signals', 'Turn 3: phase advanced to market_signals');
  assert(turn3.nextQuestion !== null, 'Turn 3: has next question about market signals');
  assert(turn3.summary.gathered.certitude === 0.9, 'Turn 3: certitude is gathered');
  assert(turn3.summary.gathered.ubiquity === 0.85, 'Turn 3: ubiquity is gathered');
  assert(turn3.summary.exchangeCount >= 2, `Turn 3: exchange count is ${turn3.summary.exchangeCount} (>=2)`);

  // Turn 4: Provide a phase distribution → should complete with evaluation
  const turn4 = await estimateEvolutionConversational({
    sessionState: turn3.sessionState,
    data: {
      phaseDistribution: {
        bins: [
          { position: 0.09, probability: 0.02 },
          { position: 0.29, probability: 0.08 },
          { position: 0.48, probability: 0.25 },
          { position: 0.85, probability: 0.65 },
        ],
      },
    },
  });
  assert(turn4.phase === 'complete', 'Turn 4: phase is complete');
  assert(turn4.evaluations !== null, 'Turn 4: has evaluations');
  assert(turn4.nextQuestion === null, 'Turn 4: no more questions');
  assert(turn4.reQuestions === null, 'Turn 4: no re-questions');
  assert(turn4.summary.exchangeCount >= 3, `Turn 4: exchange count is ${turn4.summary.exchangeCount} (>=3)`);

  // Verify at least the analytical strategies produced results
  const evalKeys = Object.keys(turn4.evaluations);
  assert(evalKeys.length > 0, `Turn 4: has ${evalKeys.length} strategy results`);
  const sCurveResult = turn4.evaluations['write:capacity:s-curve'];
  if (sCurveResult && !sCurveResult.error) {
    assert(typeof sCurveResult.evolution === 'number', 'Turn 4: s-curve has numeric evolution');
    assert(typeof sCurveResult.confidence === 'number', 'Turn 4: s-curve has numeric confidence');
    assert(sCurveResult.method === 'write:capacity:s-curve', 'Turn 4: s-curve method identifier matches');
  }
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Test 2: Social good component triggers re-questioning
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 2: Social good triggers re-questioning (Air) ---');
{
  const turn1 = await estimateEvolutionConversational({
    data: { name: 'Air', description: 'Atmospheric oxygen available to grow crops' },
  });
  assert(turn1.phase === 'complete', 'Air: phase is complete (early exit)');
  assert(turn1.reQuestions !== null, 'Air: has re-questions');
  assert(turn1.reQuestions.length > 0, `Air: has ${turn1.reQuestions.length} re-question(s)`);
  assert(turn1.evaluations === null, 'Air: no evaluations (non-economic)');
  assert(turn1.classification.space === 'social_good', 'Air: classified as social_good');
  assert(turn1.classification.requiresReQuestion === true, 'Air: requires re-questioning');
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Test 3: Common good triggers re-questioning
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 3: Common good triggers re-questioning (Public Domain) ---');
{
  const turn1 = await estimateEvolutionConversational({
    data: { name: 'Public Domain', description: 'Shared knowledge collectively managed' },
  });
  assert(turn1.phase === 'complete', 'Public Domain: phase is complete (early exit)');
  assert(turn1.reQuestions !== null, 'Public Domain: has re-questions');
  assert(turn1.evaluations === null, 'Public Domain: no evaluations');
  assert(turn1.classification.space === 'common_good', 'Public Domain: classified as common_good');
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Test 4: Force estimate with partial data
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 4: Force estimate with partial data ---');
{
  // Start with just a name
  const turn1 = await estimateEvolutionConversational({
    data: { name: 'LLM', description: 'Large language model for text generation' },
  });
  assert(turn1.phase === 'characteristics', 'LLM turn 1: at characteristics phase');
  assert(turn1.evaluations === null, 'LLM turn 1: no evaluations yet');

  // Force estimation without providing characteristics
  const turn2 = await estimateEvolutionConversational({
    sessionState: turn1.sessionState,
    forceEstimate: true,
  });
  assert(turn2.phase === 'complete', 'LLM forced: phase is complete');
  assert(turn2.evaluations !== null, 'LLM forced: has evaluations');
  assert(turn2.message.includes('conversational estimation complete'), 'LLM forced: message confirms completion');
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Test 5: Session serialization and restoration
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 5: Session serialization round-trip ---');
{
  const session = new ConversationSession();
  session.update({ name: 'CRM', description: 'Customer relationship management for sales' });
  session.update({ certitude: 0.8, ubiquity: 0.75 });

  const serialized = session.serialize();
  assert(typeof serialized === 'string', 'Serialized to string');

  const restored = ConversationSession.deserialize(serialized);
  assert(restored.state.name === 'CRM', 'Restored name');
  assert(restored.state.certitude === 0.8, 'Restored certitude');
  assert(restored.state.ubiquity === 0.75, 'Restored ubiquity');
  assert(restored.phase === session.phase, 'Restored phase matches');
  assert(restored.state.history.length === session.state.history.length, 'Restored history length matches');

  // Continue from restored session
  restored.update({
    phaseDistribution: {
      bins: [
        { position: 0.09, probability: 0.05 },
        { position: 0.29, probability: 0.15 },
        { position: 0.48, probability: 0.30 },
        { position: 0.85, probability: 0.50 },
      ],
    },
  });
  assert(restored.isReadyForEstimation(), 'Restored session progresses to ready');
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Test 6: Maturity signal inference from free text
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 6: Free-text inference ---');
{
  const inferred = inferFromMaturitySignals(
    'Well understood technology with established best practices, widely adopted by enterprises'
  );
  assert(typeof inferred.certitude === 'number', 'Inferred certitude from maturity signals');
  assert(inferred.certitude > 0.5, `Certitude is high (${inferred.certitude})`);
  assert(typeof inferred.ubiquity === 'number', 'Inferred ubiquity from maturity signals');
  assert(inferred.ubiquity > 0.5, `Ubiquity is high (${inferred.ubiquity})`);

  const marketInferred = inferFromMarketSignals(
    'Many competitors, feature differentiation, dominant players',
    'Mass adoption in enterprise, mainstream'
  );
  assert(marketInferred !== null, 'Inferred phase distribution from market signals');
  const phase3or4 = marketInferred.bins[2].probability + marketInferred.bins[3].probability;
  assert(phase3or4 > 0, 'Market signals map to phase3 or phase4 mass');
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Test 7: Context accumulation across multiple exchanges
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 7: Context accumulation across exchanges ---');
{
  const session = new ConversationSession();

  // Exchange 1: just name (use a capability name, not a solution name like "Kubernetes",
  // because solutions take a different path where certitude is not tracked)
  session.update({ name: 'container orchestration' });
  const summary1 = session.getSummary();
  assert(summary1.exchangeCount === 1, 'Exchange 1: count is 1');
  assert(summary1.gathered.name === 'container orchestration', 'Exchange 1: name gathered');
  assert(summary1.missing.includes('certitude'), 'Exchange 1: certitude still missing');

  // Exchange 2: description
  session.update({ description: 'Container orchestration platform' });
  const summary2 = session.getSummary();
  assert(summary2.exchangeCount === 2, 'Exchange 2: count is 2');
  assert(summary2.gathered.description === 'Container orchestration platform', 'Exchange 2: description gathered');

  // Exchange 3: characteristics
  session.update({ certitude: 0.8 });
  const summary3 = session.getSummary();
  assert(summary3.exchangeCount === 3, 'Exchange 3: count is 3');
  assert(summary3.gathered.certitude === 0.8, 'Exchange 3: certitude gathered');

  // Exchange 4: more characteristics
  session.update({ ubiquity: 0.7 });
  assert(session.phase === 'market_signals', 'Exchange 4: phase advanced to market_signals');

  // Exchange 5: market signals via free text
  session.update({
    marketDynamics: 'Many competitors like AWS EKS and Google GKE, feature differentiation',
    adoptionPattern: 'Mass adoption in enterprise',
  });
  assert(session.isReadyForEstimation(), 'Exchange 5: ready for estimation');
  assert(session.getSummary().exchangeCount === 5, 'Exchange 5: count is 5');

  // Verify all data is available in component input
  const input = session.buildComponentInput();
  assert(input.name === 'container orchestration', 'Component input has name');
  assert(input.certitude === 0.8, 'Component input has certitude');
  assert(input.ubiquity === 0.7, 'Component input has ubiquity');
  assert(input.metadata.marketDynamics != null, 'Component input has market dynamics');
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Test 8: Phase progression is correct
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 8: Phase progression order ---');
{
  const session = new ConversationSession();
  assert(session.phase === 'identity', 'Start: identity phase');

  session.update({ name: 'CRM', description: 'Sales software' });
  // Classification auto-detects as economic → skip to characteristics
  assert(session.phase === 'characteristics', 'After name: characteristics phase');

  session.update({ certitude: 0.85 });
  assert(session.phase === 'market_signals', 'After certitude: market_signals phase');

  session.update({
    phaseDistribution: {
      bins: [
        { position: 0.09, probability: 0.05 },
        { position: 0.29, probability: 0.10 },
        { position: 0.48, probability: 0.35 },
        { position: 0.85, probability: 0.50 },
      ],
    },
  });
  assert(session.phase === 'ready', 'After phase distribution: ready phase');
  assert(session.isReadyForEstimation(), 'Is ready for estimation');
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Test 9: Skill handler conversational invocation
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 9: handleConversationalInvocation multi-turn ---');
{
  // Turn 1: Start with natural language
  const turn1 = await handleConversationalInvocation({
    userMessage: 'ERP - enterprise resource planning for corporations',
  });
  assert(turn1.mode === 'conversational', 'Skill turn 1: conversational mode');
  assert(turn1.formatted && turn1.formatted.length > 0, 'Skill turn 1: has formatted output');
  assert(turn1.formatted.includes('Phase'), 'Skill turn 1: formatted shows phase');
  assert(turn1.sessionState != null, 'Skill turn 1: has session state');

  // Turn 2: Provide characteristics via structured input
  const turn2 = await handleConversationalInvocation({
    userMessage: 'Certitude: 0.9\nUbiquity: 0.85',
    sessionState: turn1.sessionState,
  });
  assert(turn2.phase === 'market_signals', 'Skill turn 2: at market_signals phase');
  assert(turn2.formatted.includes('Market'), 'Skill turn 2: formatted mentions market');

  // Turn 3: Force estimate
  const turn3 = await handleConversationalInvocation({
    sessionState: turn2.sessionState,
    forceEstimate: true,
  });
  assert(turn3.phase === 'complete', 'Skill turn 3: complete');
  assert(turn3.evaluations !== null, 'Skill turn 3: has evaluations');
  assert(turn3.formatted.includes('Strategy Results'), 'Skill turn 3: formatted has results table');
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Test 10: Formatting for each conversation state
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 10: formatConversationalTurn for all states ---');
{
  // Intermediate state (asking questions)
  const intermediateResult = {
    mode: 'conversational',
    phase: 'characteristics',
    nextQuestion: {
      phase: 'characteristics',
      prompt: 'Let me understand the maturity characteristics of this component.',
      hints: ['**Certitude** (0-1): How well-understood?', '**Ubiquity** (0-1): How widespread?'],
      fields: ['certitude', 'ubiquity'],
    },
    classification: null,
    reQuestions: null,
    evaluations: null,
    summary: {
      phase: 'characteristics',
      gathered: { name: 'ERP', description: 'Enterprise software' },
      missing: ['certitude', 'ubiquity'],
      history: ['Exchange 1: gathered name, description'],
      readyForEstimation: false,
      exchangeCount: 1,
    },
    sessionState: '{}',
  };

  const intermediateFormatted = formatConversationalTurn(intermediateResult);
  assert(intermediateFormatted.includes('Phase'), 'Intermediate: shows phase');
  assert(intermediateFormatted.includes('Progress'), 'Intermediate: shows progress');
  assert(intermediateFormatted.includes('maturity'), 'Intermediate: shows question');
  assert(intermediateFormatted.includes('Already gathered'), 'Intermediate: shows gathered data');
  assert(intermediateFormatted.includes('Tip'), 'Intermediate: shows tip');

  // Re-questioning state (social good)
  const reQuestionResult = {
    mode: 'conversational',
    phase: 'complete',
    nextQuestion: null,
    classification: { space: 'social_good', reason: 'Naturally available', requiresReQuestion: true },
    reQuestions: ['Did you mean bottled oxygen?', 'Is this a market product?'],
    evaluations: null,
    summary: { gathered: { name: 'Air' }, missing: [], history: [], exchangeCount: 1, readyForEstimation: true },
    sessionState: '{}',
  };

  const reQuestionFormatted = formatConversationalTurn(reQuestionResult);
  assert(reQuestionFormatted.includes('Re-Questioning Required'), 'ReQuestion: shows re-questioning');
  assert(reQuestionFormatted.includes('social_good'), 'ReQuestion: shows space');
  assert(reQuestionFormatted.includes('bottled oxygen'), 'ReQuestion: shows specific re-questions');

  // Complete state (with evaluations)
  const completeResult = {
    mode: 'conversational',
    phase: 'complete',
    nextQuestion: null,
    classification: { space: 'economic', reason: 'Economic component', requiresReQuestion: false },
    reQuestions: null,
    evaluations: {
      'write:capacity:s-curve': { evolution: 0.72, confidence: 0.85, method: 'write:capacity:s-curve' },
      'write:capacity:llm-direct': { evolution: 0.68, confidence: 0.70, method: 'write:capacity:llm-direct' },
    },
    summary: {
      gathered: { name: 'ERP', certitude: 0.9, ubiquity: 0.85 },
      missing: [],
      history: ['Exchange 1', 'Exchange 2'],
      readyForEstimation: true,
      exchangeCount: 2,
    },
    sessionState: '{}',
  };

  const completeFormatted = formatConversationalTurn(completeResult);
  assert(completeFormatted.includes('Evolution Estimation: ERP'), 'Complete: shows component name');
  assert(completeFormatted.includes('Strategy Results'), 'Complete: shows results table');
  assert(completeFormatted.includes('0.720'), 'Complete: shows evolution value');
  assert(completeFormatted.includes('Consensus range'), 'Complete: shows consensus');
  assert(completeFormatted.includes('Wardley Phase'), 'Complete: shows Wardley phase');
  assert(completeFormatted.includes('2 exchange(s)'), 'Complete: shows exchange count');
  assert(completeFormatted.includes('Context gathered'), 'Complete: shows gathered context details');
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Test 11: Strategy selection in conversational mode
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 11: Strategy selection ---');
{
  const result = await estimateEvolutionConversational({
    data: { name: 'ERP', description: 'Enterprise resource planning', certitude: 0.9, ubiquity: 0.85 },
    strategy: 'write:capacity:s-curve',
  });
  // The session should gather the data and advance; let's force if needed
  const final = result.phase === 'complete'
    ? result
    : await estimateEvolutionConversational({
        sessionState: result.sessionState,
        forceEstimate: true,
        strategy: 'write:capacity:s-curve',
      });

  assert(final.phase === 'complete', 'Strategy selection: completed');
  if (final.evaluations) {
    const keys = Object.keys(final.evaluations);
    assert(keys.includes('write:capacity:s-curve'), 'Strategy selection: s-curve was evaluated');
  }
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Test 12: Empty session returns identity question
// ────────────────────────────────────────────────────────────────────────────

console.log('--- Test 12: Empty session start ---');
{
  const session = new ConversationSession();
  const q = session.nextQuestion();
  assert(q !== null, 'Empty session: has a question');
  assert(q.phase === 'identity', 'Empty session: asks for identity');
  assert(q.prompt.includes('component'), 'Empty session: prompt asks about component');
  assert(q.hints.length > 0, 'Empty session: has hints');
  assert(q.fields.includes('name'), 'Empty session: wants name');
  assert(!session.isReadyForEstimation(), 'Empty session: not ready');
}
console.log();

// ────────────────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
