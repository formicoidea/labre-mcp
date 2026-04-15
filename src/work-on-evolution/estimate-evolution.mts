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

import { buildReQuestions } from './routing/classification-gate.mjs';
import { loadStrategies, getStrategy, listStrategies } from './strategies/capacity/registry.mjs';
import { BaseStrategy } from './strategies/capacity/base-strategy.mjs';
import { ConversationSession } from '../session/conversation-session.mjs';
import { createLLMCall, createOpenCodeCall, createOpenCodeLogprobCall } from '../lib/llm/llm-call.mjs';
import { identifyCapability } from '../work-on-value-chain/identify-capability.mjs';
import { logDebug, logInfo, logError } from '../lib/mcp-notifications.mjs';
import { createMessageResolverFromArgs } from '../lib/progress-messages.mjs';
import {
  detectComponentType,
  COMPONENT_TYPE,
  CONFIDENCE_THRESHOLD,
} from '../lib/component-detection.mjs';
import {
  determineRoutingTargets,
  dispatchSolutionStrategies,
} from './routing/solution-dispatch.mjs';
import { classifyWardleyType } from './routing/wardley-type-classification.mjs';
import { verifyClassification } from './pipeline/dual-verification-orchestrator.mjs';
import { runEnrichedPipeline } from './pipeline/pipeline-enriched.mjs';
import { validateOneShotInput, resolveClassification, VALID_SPACES } from './lib/evolution-input-validation.mjs';

/**
 * @typedef {Object} OneShotResult
 * @property {'oneshot'}  mode          - Always 'oneshot' for this entry point
 * @property {import('./routing/classification-gate.mjs').ClassificationResult} classification
 * @property {string[]|null} reQuestions - Re-questioning prompts if non-economic
 * @property {Object<string, import('./strategies/capacity/base-strategy.mjs').EvolutionResult>|null} evaluations
 * @property {Object}    [routing]      - Solution/capability routing metadata
 * @property {{ type: string, confidence: number, reason: string }} [wardleyType] - Wardley component type (activity/practice/data/knowledge) — informative metadata only
 * @property {string}    message        - Human-readable summary
 */

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
  const { name, description, space, strategy, pipeline, ...componentData } = validated;

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
  const component: any = {
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

  // Step 4c: Route component to solution or capability strategies
  //   Tier 1: Fast naming convention detection
  const detection = detectComponentType(name, description);
  let routingTargets = determineRoutingTargets(detection);
  let verifiedDetection = null;

  logDebug(TOOL, `Routing "${name}": type=${detection.type}, confidence=${detection.confidence}, ` +
    `needsFallback=${detection.needsFallback}, evalMode=${routingTargets.mode}`);

  // Fallback: when naming convention confidence < 90%, delegate to the
  // dual-verification orchestrator (LLM + web search) for higher accuracy.
  // Forwards the component name plus any partial classification context
  // accumulated so far (description, capability, nature).
  if (detection.needsFallback) {
    logDebug(TOOL, `Naming confidence ${detection.confidence} < 0.90 for "${name}" — triggering dual-verification fallback`);

    try {
      const partialContext = {
        description,
        llmCall: getLLMCall(),
        ...(component.capability && { capability: component.capability }),
        ...(component.nature && { nature: component.nature }),
      };

      verifiedDetection = await verifyClassification(name, partialContext);

      // Use verified result for routing (overrides naming-only detection)
      routingTargets = verifiedDetection.routingTargets;

      logDebug(TOOL,
        `Dual-verification result for "${name}": type=${verifiedDetection.classification}, ` +
        `confidence=${verifiedDetection.confidence}, method=${verifiedDetection.method}, ` +
        `verified=${verifiedDetection.verified}, tiers=${verifiedDetection.tiersUsed.join('+')}`);
    } catch (err) {
      // Fallback failed — continue with the naming-only detection
      logDebug(TOOL,
        `Dual-verification fallback failed for "${name}": ${err.message} — using naming-only routing`);
    }
  }

  logDebug(TOOL, `Final routing "${name}": solution=${routingTargets.useSolutionStrategies}, ` +
    `capability=${routingTargets.useCapabilityStrategies}`);

  // Step 5: Evaluate with selected strategy(ies) — dispatched via routing
  const evaluations = {};

  // Step 5a: Run capability strategies (existing pipeline) if routed
  if (routingTargets.useCapabilityStrategies) {
    logDebug(TOOL, `Dispatching "${name}" to capability strategies`);

    if (strategy === 'all') {
      const strategies = await loadStrategies();
      const strategyNames = [...strategies.keys()];

      logDebug(TOOL, `Loaded ${strategyNames.length} capability strategies for "${name}": ${strategyNames.join(', ')}`);

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
      const enrichedComponent: any = { ...component };
      if (enrichedComponent.certitude == null || enrichedComponent.ubiquity == null) {
        const llmResults = (Object.values(evaluations) as any[]).filter(
          e => !e.error && e.certitude != null && e.ubiquity != null
        );
        if (llmResults.length > 0) {
          // Average certitude/ubiquity from all LLM strategies that provided them
          enrichedComponent.certitude = Math.round(
            llmResults.reduce((s: number, r: any) => s + r.certitude, 0) / llmResults.length * 1000
          ) / 1000;
          enrichedComponent.ubiquity = Math.round(
            llmResults.reduce((s: number, r: any) => s + r.ubiquity, 0) / llmResults.length * 1000
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
  }

  // Step 5b: Run solution strategies if routed
  if (routingTargets.useSolutionStrategies) {
    logDebug(TOOL, `Dispatching "${name}" to solution strategies`);
    try {
      const solutionEvals = await dispatchSolutionStrategies(component, {
        llmCall: getLLMCall(),
        strategy: strategy === 'all' ? 'all' : strategy,
        mode: 'auto',
      });
      // Merge solution evaluations (prefix to avoid key collisions)
      for (const [method, result] of Object.entries(solutionEvals)) {
        const key = evaluations[method] ? `solution:${method}` : method;
        evaluations[key] = result;
      }
    } catch (err) {
      evaluations['solution-dispatch-error'] = { error: err.message };
      logDebug(TOOL, `Solution strategy dispatch failed: ${err.message}`);
    }
  }

  // Step 6: Format result
  const successCount = (Object.values(evaluations) as any[]).filter(e => !e.error).length;
  const errorCount = (Object.values(evaluations) as any[]).filter(e => e.error).length;
  const duration = Date.now() - t0;

  logDebug(TOOL, `Results for "${name}": ${successCount} succeeded, ${errorCount} failed out of ${Object.keys(evaluations).length} strategies`);

  // Info-level: tool end (localized)
  logInfo(TOOL, msg('tool.end', { tool: TOOL, component: name, duration }));

  // Build routing metadata — use verified detection if available, else naming-only
  const effectiveType = verifiedDetection ? verifiedDetection.classification : detection.type;
  const effectiveConfidence = verifiedDetection ? verifiedDetection.confidence : detection.confidence;
  const effectiveMethod = verifiedDetection ? verifiedDetection.method : detection.method;

  // Classify Wardley component type (activity/practice/data/knowledge) — informative metadata only
  const wardleyTypeResult = classifyWardleyType(name, {
    description,
    nature: detection.nature,
    category: detection.category,
  });

  logDebug(TOOL, `Wardley type for "${name}": ${wardleyTypeResult.wardleyType} (confidence=${wardleyTypeResult.confidence}, ${wardleyTypeResult.reason})`);

  let message = `Component "${name}" classified as ${classification.space}`;
  if (effectiveType === COMPONENT_TYPE.SOLUTION) {
    message += ` (detected as solution, confidence=${effectiveConfidence})`;
  }
  message += `. Evaluated with ${successCount} strategy(ies)`;
  if (errorCount > 0) {
    message += ` (${errorCount} strategy(ies) returned errors)`;
  }
  message += '.';

  const standardResult = {
    mode: 'oneshot',
    classification,
    reQuestions: null,
    evaluations,
    routing: {
      type: effectiveType,
      confidence: effectiveConfidence,
      method: effectiveMethod,
      evalMode: routingTargets.mode,
      usedSolutionStrategies: routingTargets.useSolutionStrategies,
      usedCapabilityStrategies: routingTargets.useCapabilityStrategies,
      ...(verifiedDetection && {
        verified: verifiedDetection.verified,
        tiersUsed: verifiedDetection.tiersUsed,
      }),
    },
    wardleyType: {
      type: wardleyTypeResult.wardleyType,
      confidence: wardleyTypeResult.confidence,
      reason: wardleyTypeResult.reason,
    },
    message,
  };

  // ── Pipeline enrichment: when pipeline=true, orchestrate the 3-step evaluation
  if (pipeline) {
    logDebug(TOOL, `Pipeline mode enabled for "${name}" — running enriched pipeline`);

    // Provide a capability evaluation function that re-uses estimateEvolutionOneShot
    // but forces capability path (no pipeline recursion)
    const evaluateCapabilityFn = (capInput) =>
      estimateEvolutionOneShot({ ...capInput, pipeline: false });

    const pipelineResult = await runEnrichedPipeline(standardResult, component, {
      evaluateCapabilityFn,
      llmCall: getLLMCall(),
    });

    logDebug(TOOL, `Pipeline complete for "${name}": capability evolution=${pipelineResult.capabilityPivot?.evolution}`);

    return pipelineResult;
  }

  return standardResult;
}

// ─── Lazy LLM Singletons ────────────────────────────────────────────────────

let _llmCall = null;
function getLLMCall() {
  if (!_llmCall) {
    const model = process.env.WARDLEY_LLM_MODEL || 'claude-sonnet-4-6';
    logDebug('estimateEvolution', `LLM backend: Agent SDK, model="${model}"`);
    _llmCall = createLLMCall({
      model,
      effort: 'high',
      maxBudgetUsd: 0.10,
    });
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
 * - llm-direct: requires LLM call
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
  if (method === 'llm-direct') {
    return new StrategyCls({ llmCall: getLLMCall() });
  }

  // CPC evolution strategy: inject LLM for CPC mapper (patent source uses env vars)
  if (method === 'cpc-evolution') {
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
 * @property {import('../session/conversation-session.mjs').QuestionSet | null} nextQuestion
 * @property {import('./routing/classification-gate.mjs').ClassificationResult | null} classification
 * @property {string[] | null} reQuestions
 * @property {Object<string, import('./strategies/capacity/base-strategy.mjs').EvolutionResult> | null} evaluations
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
export async function estimateEvolutionConversational(input: any = {}): Promise<any> {
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

  // If ready for estimation, run the strategies with routing
  if (session.isReadyForEstimation()) {
    const classification = session.getClassification();
    const component = session.buildComponentInput();
    const selectedStrategy = session.state.strategy || 'all';
    const evaluations = {};

    logDebug(TOOL, `Conversational estimation ready for "${session.state.name}", strategy="${selectedStrategy}"`);

    // Route component to solution or capability strategies.
    //
    // The conversation session already detected the component type during the
    // classification phase (stored in session.state.componentType). We reuse
    // that detection here instead of re-running detectComponentType() — this
    // ensures routing is consistent with the conversation branching the user
    // experienced (solution_context vs characteristics/market_signals path).
    //
    // When the session detection confidence is below the 90% threshold,
    // we still trigger the dual-verification fallback for higher accuracy.

    let convDetection;
    const sessionDetection = session.getComponentTypeDetection();

    if (sessionDetection.type && sessionDetection.confidence >= CONFIDENCE_THRESHOLD) {
      // Session already has high-confidence detection — reuse it directly
      convDetection = {
        type: sessionDetection.type,
        confidence: sessionDetection.confidence,
        method: sessionDetection.method,
        needsFallback: false,
      };
      logDebug(TOOL,
        `Reusing session detection for "${session.state.name}": type=${convDetection.type}, ` +
        `confidence=${convDetection.confidence}, method=${convDetection.method} (no fallback needed)`);
    } else {
      // Re-detect (session had low confidence or no detection)
      convDetection = detectComponentType(
        session.state.name,
        session.state.description || ''
      );
      logDebug(TOOL,
        `Conversational routing "${session.state.name}": type=${convDetection.type}, ` +
        `confidence=${convDetection.confidence}, needsFallback=${convDetection.needsFallback}`);
    }

    let convRoutingTargets = determineRoutingTargets(convDetection);
    let convVerifiedDetection = null;

    logDebug(TOOL, `Routing targets "${session.state.name}": ` +
      `solution=${convRoutingTargets.useSolutionStrategies}, ` +
      `capability=${convRoutingTargets.useCapabilityStrategies}, mode=${convRoutingTargets.mode}`);

    // Fallback: when naming convention confidence < 90%, delegate to the
    // dual-verification orchestrator (LLM + web search) for higher accuracy.
    // Forwards component name plus partial classification context from session.
    if (convDetection.needsFallback) {
      logDebug(TOOL,
        `Naming confidence ${convDetection.confidence} < 0.90 for "${session.state.name}" — ` +
        `triggering dual-verification fallback (conversational)`);

      try {
        const convPartialContext = {
          description: session.state.description || '',
          llmCall: getLLMCall(),
          ...(component.capability && { capability: component.capability }),
          ...(component.nature && { nature: component.nature }),
        };

        convVerifiedDetection = await verifyClassification(session.state.name, convPartialContext);

        // Use verified result for routing (overrides naming-only detection)
        convRoutingTargets = convVerifiedDetection.routingTargets;

        logDebug(TOOL,
          `Dual-verification result for "${session.state.name}": type=${convVerifiedDetection.classification}, ` +
          `confidence=${convVerifiedDetection.confidence}, method=${convVerifiedDetection.method}, ` +
          `verified=${convVerifiedDetection.verified}, tiers=${convVerifiedDetection.tiersUsed.join('+')}`);
      } catch (err) {
        logDebug(TOOL,
          `Dual-verification fallback failed for "${session.state.name}": ${err.message} — ` +
          `using naming-only routing`);
      }
    }

    logDebug(TOOL, `Final conversational routing "${session.state.name}": ` +
      `solution=${convRoutingTargets.useSolutionStrategies}, capability=${convRoutingTargets.useCapabilityStrategies}`);

    // Run capability strategies if routed
    if (convRoutingTargets.useCapabilityStrategies) {
      if (selectedStrategy === 'all') {
        const strategies = await loadStrategies();
        const strategyNames = [...strategies.keys()];
        logDebug(TOOL, `Running ${strategyNames.length} capability strategies: ${strategyNames.join(', ')}`);

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
    }

    // Run solution strategies if routed
    if (convRoutingTargets.useSolutionStrategies) {
      logDebug(TOOL, `Dispatching "${session.state.name}" to solution strategies (conversational)`);
      try {
        const solutionEvals = await dispatchSolutionStrategies(component, {
          llmCall: getLLMCall(),
          strategy: selectedStrategy === 'all' ? 'all' : selectedStrategy,
          mode: 'conversational',
        });
        for (const [method, result] of Object.entries(solutionEvals)) {
          const key = evaluations[method] ? `solution:${method}` : method;
          evaluations[key] = result;
        }
      } catch (err) {
        evaluations['solution-dispatch-error'] = { error: err.message };
        logDebug(TOOL, `Solution strategy dispatch failed: ${err.message}`);
      }
    }

    const successCount = (Object.values(evaluations) as any[]).filter(e => !e.error).length;
    const errorCount = (Object.values(evaluations) as any[]).filter(e => e.error).length;
    const summary = session.getSummary();

    logDebug(TOOL, `Conversational results for "${session.state.name}": ${successCount} succeeded, ${errorCount} failed, ${summary.exchangeCount} exchange(s)`);

    // Build routing metadata — use verified detection if available
    const convEffectiveType = convVerifiedDetection ? convVerifiedDetection.classification : convDetection.type;
    const convEffectiveConfidence = convVerifiedDetection ? convVerifiedDetection.confidence : convDetection.confidence;
    const convEffectiveMethod = convVerifiedDetection ? convVerifiedDetection.method : convDetection.method;

    let message = `Component "${session.state.name}" — conversational estimation complete after ${summary.exchangeCount} exchange(s)`;
    if (convEffectiveType === COMPONENT_TYPE.SOLUTION) {
      message += ` (detected as solution, confidence=${convEffectiveConfidence})`;
    }
    message += `. Evaluated with ${successCount} strategy(ies)`;
    if (errorCount > 0) {
      message += ` (${errorCount} returned errors)`;
    }
    message += '.';

    // Classify Wardley component type (activity/practice/data/knowledge) — informative metadata
    const convWardleyType = classifyWardleyType(session.state.name, {
      description: session.state.description || '',
      nature: convDetection.nature,
      category: convDetection.category,
    });

    logDebug(TOOL, `Wardley type for "${session.state.name}": ${convWardleyType.wardleyType} (${convWardleyType.reason})`);

    return {
      mode: 'conversational',
      phase: 'complete',
      nextQuestion: null,
      classification,
      reQuestions: null,
      evaluations,
      routing: {
        type: convEffectiveType,
        confidence: convEffectiveConfidence,
        method: convEffectiveMethod,
        evalMode: convRoutingTargets.mode,
        usedSolutionStrategies: convRoutingTargets.useSolutionStrategies,
        usedCapabilityStrategies: convRoutingTargets.useCapabilityStrategies,
        ...(convVerifiedDetection && {
          verified: convVerifiedDetection.verified,
          tiersUsed: convVerifiedDetection.tiersUsed,
        }),
      },
      wardleyType: {
        type: convWardleyType.wardleyType,
        confidence: convWardleyType.confidence,
        reason: convWardleyType.reason,
      },
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
  for (const [method, ev] of Object.entries(allResult.evaluations) as [string, any][]) {
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
