// One-shot evolution estimation entry point
//
// Accepts all required parameters (name, description, space) in a single call
// and returns a complete evolution estimation result.
//
// Pipeline: validate → classify (or use provided space) → evaluate → format
//
// This module provides a high-level API on top of the MCP tool handler,
// adding explicit one-shot mode support with a `space` parameter that
// allows callers to pre-classify components and bypass the classification gate.

import { classifyComponent, buildReQuestions } from './classification-gate.mjs';
import { loadStrategies, getStrategy, listStrategies } from './strategies/registry.mjs';
import { BaseStrategy } from './strategies/base-strategy.mjs';
import { ConversationSession } from './conversation-session.mjs';
import { createLLMCall, createOpenCodeCall, createOpenCodeLogprobCall } from './llm-call.mjs';
import { identifyCapability } from './identify-capability.mjs';
import { logDebug, logInfo, logError } from './mcp-notifications.mjs';
import { createMessageResolverFromArgs } from './progress-messages.mjs';

// ─── Valid Spaces ────────────────────────────────────────────────────────────

const VALID_SPACES = ['economic', 'social_good', 'common_good'];

// ─── Input Validation ────────────────────────────────────────────────────────

/**
 * @typedef {Object} OneShotInput
 * @property {string}  name         - Component name (required)
 * @property {string}  [description] - Business/usage context (recommended)
 * @property {string}  [space]      - Pre-classification: 'economic' | 'social_good' | 'common_good'
 * @property {string}  [strategy]   - Strategy name or 'all' (default: 'all')
 * @property {number}  [certitude]  - How well-understood (0–1)
 * @property {number}  [ubiquity]   - How widespread (0–1)
 * @property {number}  [wonder]     - Publication proportion: novelty (0–1)
 * @property {number}  [build]      - Publication proportion: building (0–1)
 * @property {number}  [operate]    - Publication proportion: operations (0–1)
 * @property {number}  [usage]      - Publication proportion: commodity usage (0–1)
 */

/**
 * @typedef {Object} OneShotResult
 * @property {'oneshot'}  mode          - Always 'oneshot' for this entry point
 * @property {import('./classification-gate.mjs').ClassificationResult} classification
 * @property {string[]|null} reQuestions - Re-questioning prompts if non-economic
 * @property {Object<string, import('./strategies/base-strategy.mjs').EvolutionResult>|null} evaluations
 * @property {string}    message        - Human-readable summary
 */

/**
 * Validate one-shot input parameters.
 * Throws descriptive errors for invalid inputs.
 *
 * @param {*} input - Raw input
 * @returns {OneShotInput} Validated and normalized input
 */
function validateOneShotInput(input) {
  if (input == null || typeof input !== 'object') {
    throw new Error('Input must be a non-null object');
  }

  const {
    name, description, space, strategy,
    certitude, ubiquity, wonder, build, operate, usage,
  } = input;

  // Required: name
  if (name == null || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Required parameter "name" must be a non-empty string');
  }

  // Optional strings
  if (description != null && typeof description !== 'string') {
    throw new Error('Parameter "description" must be a string');
  }
  if (strategy != null && typeof strategy !== 'string') {
    throw new Error('Parameter "strategy" must be a string');
  }

  // Space validation
  if (space != null) {
    if (typeof space !== 'string') {
      throw new Error('Parameter "space" must be a string');
    }
    const normalizedSpace = space.trim().toLowerCase();
    if (!VALID_SPACES.includes(normalizedSpace)) {
      throw new Error(
        `Parameter "space" must be one of: ${VALID_SPACES.join(', ')}. Got: "${space}"`
      );
    }
  }

  // Optional numeric fields in [0, 1]
  const numericFields = { certitude, ubiquity, wonder, build, operate, usage };
  for (const [field, value] of Object.entries(numericFields)) {
    if (value != null) {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new Error(`Parameter "${field}" must be a number, got ${typeof value}`);
      }
      if (value < 0 || value > 1) {
        throw new Error(`Parameter "${field}" must be between 0 and 1, got ${value}`);
      }
    }
  }

  return {
    name: name.trim(),
    description: (description || '').trim(),
    space: space ? space.trim().toLowerCase() : undefined,
    strategy: (strategy || 'all').trim(),
    ...(certitude != null && { certitude }),
    ...(ubiquity != null && { ubiquity }),
    ...(wonder != null && { wonder }),
    ...(build != null && { build }),
    ...(operate != null && { operate }),
    ...(usage != null && { usage }),
  };
}

// ─── Classification Resolution ──────────────────────────────────────────────

/**
 * Resolve classification: use provided space or auto-detect via classification gate.
 *
 * @param {string} name - Component name
 * @param {string} description - Context/description
 * @param {string|undefined} space - Pre-classified space or undefined
 * @returns {import('./classification-gate.mjs').ClassificationResult}
 */
function resolveClassification(name, description, space) {
  if (space) {
    // Use the provided space directly — skip the classification gate
    const requiresReQuestion = space !== 'economic';
    const reasons = {
      economic: `"${name}" pre-classified as economic — suitable for Wardley evolution evaluation.`,
      social_good: `"${name}" pre-classified as social_good — naturally available resource outside economic space.`,
      common_good: `"${name}" pre-classified as common_good — collectively managed resource beyond economic space.`,
    };

    return {
      space,
      reason: reasons[space],
      requiresReQuestion,
    };
  }

  // Auto-detect via classification gate
  return classifyComponent(name, description);
}

// ─── One-Shot Evaluation ────────────────────────────────────────────────────

/**
 * Estimate evolution of a Wardley Map component in one-shot mode.
 *
 * Accepts all parameters in a single call and returns a complete result.
 * The pipeline:
 *   1. Validate input
 *   2. Classify (or use provided space)
 *   3. If non-economic: return re-questioning prompts
 *   4. If economic: evaluate with selected strategy(ies)
 *   5. Format and return the result
 *
 * @param {OneShotInput} rawInput - All parameters for the estimation
 * @returns {Promise<OneShotResult>} Complete estimation result
 */
export async function estimateEvolutionOneShot(rawInput) {
  // Step 1: Validate input
  const validated = validateOneShotInput(rawInput);
  const { name, description, space, strategy, ...componentData } = validated;

  // ── Localized message resolver (pilot: estimateEvolution) ──────────
  const { msg, lang } = createMessageResolverFromArgs({ name, description, context: description });
  const TOOL = 'estimateEvolution';

  // Info-level: tool start (localized)
  logInfo(TOOL, msg('tool.start', { tool: TOOL, component: name }));

  const t0 = Date.now();

  logDebug(TOOL, `Input validated: component="${name}", strategy="${strategy}"${space ? `, space="${space}"` : ''} [lang=${lang}]`);

  // Step 2: Classify
  const classification = resolveClassification(name, description, space);

  logDebug(TOOL, msg('step.classification', { component: name, space: classification.space }));

  // Step 3: Non-economic → re-questioning
  if (classification.requiresReQuestion) {
    const reQuestions = buildReQuestions(classification, name);
    const duration = Date.now() - t0;
    logInfo(TOOL, msg('tool.end', { tool: TOOL, component: name, duration }));
    return {
      mode: 'oneshot',
      classification,
      reQuestions,
      evaluations: null,
      message:
        `Component "${name}" classified as ${classification.space}. ` +
        `Evolution evaluation is not applicable — please review the re-questioning prompts.`,
    };
  }

  // Step 4: Build component input for strategies
  const component = {
    name,
    context: description,
    description,
    ...componentData,
  };

  // Step 4b: Identify underlying capability for LLM strategies
  try {
    const capResult = await identifyCapability(component, getLLMCall());
    component.capability = capResult.capability;
    component.nature = capResult.nature;
    logDebug(TOOL, `Identified capability for "${name}": ${capResult.capability} (${capResult.nature})`);
  } catch {
    // LLM not available — skip capability identification (analytical strategies don't need it)
  }

  // Step 5: Evaluate with selected strategy(ies)
  const evaluations = {};

  if (strategy === 'all') {
    const strategies = await loadStrategies();
    const strategyNames = [...strategies.keys()];

    logDebug(TOOL, `Loaded ${strategyNames.length} strategies for "${name}": ${strategyNames.join(', ')}`);

    // Phase A: Run all non-s-curve strategies first (they may produce certitude/ubiquity)
    for (const [method, StrategyCls] of strategies) {
      if (method === 's-curve') continue;
      try {
        logDebug(TOOL, msg('step.strategy', { strategy: method, component: name }));
        const instance = createStrategyInstance(StrategyCls);
        const result = await Promise.resolve(instance.evaluate(component));
        evaluations[method] = result;
        logDebug(TOOL, msg('step.strategy.result', { strategy: method, evolution: result.evolution, confidence: result.confidence }));
      } catch (err) {
        evaluations[method] = { error: err.message };
        logDebug(TOOL, msg('step.strategy.error', { strategy: method, error: err.message }));
      }
    }

    // Phase B: If certitude/ubiquity not on the component, derive from LLM strategies
    const enrichedComponent = { ...component };
    if (enrichedComponent.certitude == null || enrichedComponent.ubiquity == null) {
      const llmResults = Object.values(evaluations).filter(
        e => !e.error && e.certitude != null && e.ubiquity != null
      );
      if (llmResults.length > 0) {
        // Average certitude/ubiquity from all LLM strategies that provided them
        enrichedComponent.certitude = Math.round(
          llmResults.reduce((s, r) => s + r.certitude, 0) / llmResults.length * 1000
        ) / 1000;
        enrichedComponent.ubiquity = Math.round(
          llmResults.reduce((s, r) => s + r.ubiquity, 0) / llmResults.length * 1000
        ) / 1000;
        logDebug(TOOL, `Enriched "${name}" from ${llmResults.length} LLM result(s): certitude=${enrichedComponent.certitude}, ubiquity=${enrichedComponent.ubiquity}`);
      }
    }

    // Phase C: Run s-curve with enriched component
    const scurveCls = strategies.get('s-curve');
    if (scurveCls) {
      try {
        logDebug(TOOL, msg('step.strategy', { strategy: 's-curve', component: name }));
        const instance = createStrategyInstance(scurveCls);
        const result = await Promise.resolve(instance.evaluate(enrichedComponent));
        evaluations['s-curve'] = result;
        logDebug(TOOL, msg('step.strategy.result', { strategy: 's-curve', evolution: result.evolution, confidence: result.confidence }));
      } catch (err) {
        evaluations['s-curve'] = { error: err.message };
        logDebug(TOOL, msg('step.strategy.error', { strategy: 's-curve', error: err.message }));
      }
    }
  } else {
    try {
      logDebug(TOOL, msg('step.strategy', { strategy, component: name }));
      const StrategyCls = await getStrategy(strategy);
      const instance = createStrategyInstance(StrategyCls);
      const result = await Promise.resolve(instance.evaluate(component));
      evaluations[strategy] = result;
      logDebug(TOOL, msg('step.strategy.result', { strategy, evolution: result.evolution, confidence: result.confidence }));
    } catch (err) {
      evaluations[strategy] = { error: err.message };
      logDebug(TOOL, msg('step.strategy.error', { strategy, error: err.message }));
    }
  }

  // Step 6: Format result
  const successCount = Object.values(evaluations).filter(e => !e.error).length;
  const errorCount = Object.values(evaluations).filter(e => e.error).length;
  const duration = Date.now() - t0;

  logDebug(TOOL, `Results for "${name}": ${successCount} succeeded, ${errorCount} failed out of ${Object.keys(evaluations).length} strategies`);

  // Info-level: tool end (localized)
  logInfo(TOOL, msg('tool.end', { tool: TOOL, component: name, duration }));

  let message = `Component "${name}" classified as ${classification.space}. `;
  message += `Evaluated with ${successCount} strategy(ies)`;
  if (errorCount > 0) {
    message += ` (${errorCount} strategy(ies) returned errors)`;
  }
  message += '.';

  return {
    mode: 'oneshot',
    classification,
    reQuestions: null,
    evaluations,
    message,
  };
}

// ─── Lazy LLM Singletons ────────────────────────────────────────────────────

let _llmCall = null;
function getLLMCall() {
  if (!_llmCall) {
    // Detection auto du contexte :
    // - _WARDLEY_NESTED=1 → subprocess MCP → Agent SDK fonctionne (process isole)
    // - sinon → session Claude Code interactive → OpenCode (evite conflit subprocess)
    if (process.env._WARDLEY_NESTED) {
      const model = process.env.WARDLEY_LLM_MODEL || 'claude-sonnet-4-6';
      logDebug('estimateEvolution', `LLM backend: Agent SDK, model="${model}"`);
      _llmCall = createLLMCall({
        model,
        effort: 'high',
        maxBudgetUsd: 0.10,
      });
    } else {
      const model = process.env.WARDLEY_LLM_MODEL || 'kimi-k2.5';
      logDebug('estimateEvolution', `LLM backend: OpenCode API, model="${model}"`);
      _llmCall = createOpenCodeCall({
        model,
      });
    }
  }
  return _llmCall;
}

let _logprobCall = null;
function getLogprobCall() {
  if (!_logprobCall) {
    const model = process.env.WARDLEY_LOGPROB_MODEL || 'kimi-k2.5';
    logDebug('estimateEvolution', `Logprob backend: OpenCode API, model="${model}"`);
    _logprobCall = createOpenCodeLogprobCall({ model });
  }
  return _logprobCall;
}

/**
 * Create a strategy instance with LLM dependencies injected.
 *
 * - s-curve: analytical only, no LLM
 * - publication-analysis: enriched with LLM for deep research
 * - timeline-benchmark: enriched with LLM for historical reasoning
 * - llm-direct, sector-agent: require LLM call
 * - logprob-distribution: uses OpenCode/kimi for real logprobs
 *
 * @param {typeof BaseStrategy} StrategyCls
 * @returns {BaseStrategy}
 */
function createStrategyInstance(StrategyCls) {
  const method = StrategyCls.method;

  // s-curve: purely analytical
  if (method === 's-curve') {
    return new StrategyCls();
  }

  // Enriched analytical strategies: inject LLM for deeper analysis
  if (method === 'publication-analysis' || method === 'timeline-benchmark') {
    return new StrategyCls({ llmCall: getLLMCall() });
  }

  // LLM-required strategies: inject Agent SDK llmCall
  if (method === 'llm-direct' || method === 'sector-agent') {
    return new StrategyCls({ llmCall: getLLMCall() });
  }

  // Logprob strategy: inject OpenCode/kimi logprob call
  if (method === 'logprob-distribution') {
    return new StrategyCls({ llmLogprobCall: getLogprobCall() });
  }

  // Unknown strategy type — try default constructor
  return new StrategyCls();
}

// ─── Conversational Mode ────────────────────────────────────────────────────

/**
 * @typedef {Object} ConversationalResult
 * @property {'conversational'} mode
 * @property {string} phase - Current conversation phase
 * @property {import('./conversation-session.mjs').QuestionSet | null} nextQuestion
 * @property {import('./classification-gate.mjs').ClassificationResult | null} classification
 * @property {string[] | null} reQuestions
 * @property {Object<string, import('./strategies/base-strategy.mjs').EvolutionResult> | null} evaluations
 * @property {Object} summary - Gathered/missing data summary
 * @property {string} sessionState - Serialized session for persistence
 * @property {string} message
 */

/**
 * Start or continue a conversational evolution estimation session.
 *
 * This function handles multi-turn interaction:
 *   - First call (no sessionState): creates a new session, returns first question
 *   - Subsequent calls (with sessionState): updates session with new data, returns next question or result
 *   - When enough context is gathered: runs evaluation and returns final result
 *
 * @param {Object} input - Exchange data
 * @param {string} [input.sessionState] - Serialized session from previous exchange (null for first call)
 * @param {Object} [input.data] - New data gathered in this exchange (key-value pairs)
 * @param {boolean} [input.forceEstimate] - Force estimation with available data
 * @param {string} [input.strategy] - Strategy to use (default: 'all')
 * @returns {Promise<ConversationalResult>}
 */
export async function estimateEvolutionConversational(input = {}) {
  const { sessionState, data = {}, forceEstimate = false, strategy } = input;
  const TOOL = 'estimateEvolution';

  // Create or restore session
  let session;
  if (sessionState) {
    try {
      session = ConversationSession.deserialize(sessionState);
      logDebug(TOOL, `Session restored (phase: ${session.phase})`);
    } catch {
      session = new ConversationSession();
      logDebug(TOOL, 'Session deserialization failed — new session created');
    }
  } else {
    session = new ConversationSession();
    logDebug(TOOL, 'New conversational session created');
  }

  // Apply strategy preference if provided
  if (strategy) {
    session.update({ strategy });
    logDebug(TOOL, `Strategy preference set: "${strategy}"`);
  }

  // Update session with new data
  if (data && Object.keys(data).length > 0) {
    session.update(data);
    logDebug(TOOL, `Session updated with ${Object.keys(data).length} field(s): ${Object.keys(data).join(', ')}`);
  }

  // Force estimation if requested
  if (forceEstimate && !session.isReadyForEstimation()) {
    session.forceReady();
    logDebug(TOOL, 'Force estimation requested — session marked as ready');
  }

  // Check for non-economic classification (triggers re-questioning)
  if (session.isReadyForEstimation() && session.isNonEconomic()) {
    const classification = session.getClassification();
    const reQuestions = session.getReQuestions();

    logDebug(TOOL, `Component "${session.state.name}" classified as ${classification.space} — re-questioning`);

    return {
      mode: 'conversational',
      phase: 'complete',
      nextQuestion: null,
      classification,
      reQuestions,
      evaluations: null,
      summary: session.getSummary(),
      sessionState: session.serialize(),
      message:
        `Component "${session.state.name}" classified as ${classification.space}. ` +
        `Evolution evaluation is not applicable — the component is outside the economic space. ` +
        `Please review the re-questioning prompts to reframe the component.`,
    };
  }

  // If ready for estimation, run the strategies
  if (session.isReadyForEstimation()) {
    const classification = session.getClassification();
    const component = session.buildComponentInput();
    const selectedStrategy = session.state.strategy || 'all';
    const evaluations = {};

    logDebug(TOOL, `Conversational estimation ready for "${session.state.name}", strategy="${selectedStrategy}"`);

    if (selectedStrategy === 'all') {
      const strategies = await loadStrategies();
      const strategyNames = [...strategies.keys()];
      logDebug(TOOL, `Running ${strategyNames.length} strategies: ${strategyNames.join(', ')}`);

      for (const [method, StrategyCls] of strategies) {
        try {
          logDebug(TOOL, `Running strategy "${method}" on "${session.state.name}"...`);
          const instance = createStrategyInstance(StrategyCls);
          const result = await Promise.resolve(instance.evaluate(component));
          evaluations[method] = result;
          logDebug(TOOL, `Strategy "${method}": evolution=${result.evolution}, confidence=${result.confidence}`);
        } catch (err) {
          evaluations[method] = { error: err.message };
          logDebug(TOOL, `Strategy "${method}" failed: ${err.message}`);
        }
      }
    } else {
      try {
        logDebug(TOOL, `Running single strategy "${selectedStrategy}" on "${session.state.name}"...`);
        const StrategyCls = await getStrategy(selectedStrategy);
        const instance = createStrategyInstance(StrategyCls);
        const result = await Promise.resolve(instance.evaluate(component));
        evaluations[selectedStrategy] = result;
        logDebug(TOOL, `Strategy "${selectedStrategy}": evolution=${result.evolution}, confidence=${result.confidence}`);
      } catch (err) {
        evaluations[selectedStrategy] = { error: err.message };
        logDebug(TOOL, `Strategy "${selectedStrategy}" failed: ${err.message}`);
      }
    }

    const successCount = Object.values(evaluations).filter(e => !e.error).length;
    const errorCount = Object.values(evaluations).filter(e => e.error).length;
    const summary = session.getSummary();

    logDebug(TOOL, `Conversational results for "${session.state.name}": ${successCount} succeeded, ${errorCount} failed, ${summary.exchangeCount} exchange(s)`);

    let message = `Component "${session.state.name}" — conversational estimation complete after ${summary.exchangeCount} exchange(s). `;
    message += `Evaluated with ${successCount} strategy(ies)`;
    if (errorCount > 0) {
      message += ` (${errorCount} returned errors)`;
    }
    message += '.';

    return {
      mode: 'conversational',
      phase: 'complete',
      nextQuestion: null,
      classification,
      reQuestions: null,
      evaluations,
      summary,
      sessionState: session.serialize(),
      message,
    };
  }

  // Not ready yet — return the next question
  const nextQuestion = session.nextQuestion();
  const summary = session.getSummary();

  logDebug(TOOL, `Conversational phase "${session.phase}": ${summary.missing.length} field(s) still missing, gathered=${summary.gathered.length}`);

  return {
    mode: 'conversational',
    phase: session.phase,
    nextQuestion,
    classification: session.getClassification(),
    reQuestions: null,
    evaluations: null,
    summary,
    sessionState: session.serialize(),
    message:
      `Gathering information for evolution estimation (phase: ${session.phase}). ` +
      `${summary.missing.length} field(s) still available to gather. ` +
      `You can provide more data or use forceEstimate to proceed with what's available.`,
  };
}

// ─── Re-export ConversationSession for external use ─────────────────────────

export { ConversationSession };

// ─── Convenience: list available strategies ──────────────────────────────────

export { listStrategies };

// ─── Self-test ───────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== estimateEvolutionOneShot self-test ===\n');

  // Test 1: Economic component with certitude/ubiquity (s-curve strategy)
  console.log('--- Test 1: ERP with s-curve strategy (one-shot) ---');
  const erpResult = await estimateEvolutionOneShot({
    name: 'ERP',
    description: 'Enterprise resource planning for large corporations',
    space: 'economic',
    strategy: 's-curve',
    certitude: 0.9,
    ubiquity: 0.85,
  });
  console.log(JSON.stringify(erpResult, null, 2));
  console.assert(erpResult.mode === 'oneshot', 'Mode should be oneshot');
  console.assert(erpResult.classification.space === 'economic', 'Space should be economic');
  console.assert(erpResult.evaluations['s-curve']?.evolution != null, 'Should have s-curve evolution');
  console.log();

  // Test 2: Social good component with explicit space
  console.log('--- Test 2: Air with explicit social_good space ---');
  const airResult = await estimateEvolutionOneShot({
    name: 'Air',
    description: 'Atmospheric oxygen available to grow crops',
    space: 'social_good',
  });
  console.log(JSON.stringify(airResult, null, 2));
  console.assert(airResult.mode === 'oneshot', 'Mode should be oneshot');
  console.assert(airResult.classification.space === 'social_good', 'Space should be social_good');
  console.assert(airResult.evaluations === null, 'Evaluations should be null');
  console.assert(airResult.reQuestions.length > 0, 'Should have re-questions');
  console.log();

  // Test 3: Auto-detected social good (no space param)
  console.log('--- Test 3: Air with auto-detection ---');
  const airAutoResult = await estimateEvolutionOneShot({
    name: 'Air',
    description: 'Atmospheric oxygen available to grow crops',
  });
  console.log(JSON.stringify(airAutoResult, null, 2));
  console.assert(airAutoResult.classification.space === 'social_good', 'Should auto-detect social_good');
  console.log();

  // Test 4: Common good with explicit space
  console.log('--- Test 4: Public Domain with explicit common_good space ---');
  const pdResult = await estimateEvolutionOneShot({
    name: 'Public Domain',
    description: 'Shared knowledge collectively managed',
    space: 'common_good',
  });
  console.log(JSON.stringify(pdResult, null, 2));
  console.assert(pdResult.classification.space === 'common_good', 'Space should be common_good');
  console.assert(pdResult.reQuestions.length > 0, 'Should have re-questions');
  console.log();

  // Test 5: All strategies on economic component
  console.log('--- Test 5: ERP with all strategies ---');
  const allResult = await estimateEvolutionOneShot({
    name: 'ERP',
    description: 'Enterprise resource planning for large corporations',
    certitude: 0.9,
    ubiquity: 0.85,
    wonder: 0.02,
    build: 0.08,
    operate: 0.25,
    usage: 0.65,
  });
  console.log(`Mode: ${allResult.mode}`);
  console.log(`Strategies evaluated:`);
  for (const [method, ev] of Object.entries(allResult.evaluations)) {
    if (ev.error) {
      console.log(`  ${method}: error - ${ev.error}`);
    } else {
      console.log(`  ${method}: evolution=${ev.evolution}, confidence=${ev.confidence}`);
    }
  }
  console.log();

  // Test 6: Input validation
  console.log('--- Test 6: Input validation ---');
  const validationTests = [
    { input: null, expectError: 'non-null object' },
    { input: {}, expectError: 'non-empty string' },
    { input: { name: 'X', space: 'invalid' }, expectError: 'must be one of' },
    { input: { name: 'X', certitude: 2 }, expectError: 'between 0 and 1' },
  ];
  for (const vt of validationTests) {
    try {
      await estimateEvolutionOneShot(vt.input);
      console.log(`  ✗ Expected error for ${JSON.stringify(vt.input)}`);
    } catch (err) {
      const ok = err.message.includes(vt.expectError);
      console.log(`  ${ok ? '✓' : '✗'} ${JSON.stringify(vt.input)} → ${err.message}`);
    }
  }

  // Test 7: Timeline benchmark strategy one-shot
  console.log('\n--- Test 7: Electricity with timeline-benchmark strategy ---');
  const elecResult = await estimateEvolutionOneShot({
    name: 'Electricity',
    description: 'Western power supply today',
    strategy: 'timeline-benchmark',
  });
  console.log(JSON.stringify(elecResult, null, 2));
  console.assert(
    elecResult.evaluations['timeline-benchmark']?.evolution >= 0.7,
    'Electricity should be commodity-level'
  );

  console.log('\n=== All self-tests completed ===');
}
