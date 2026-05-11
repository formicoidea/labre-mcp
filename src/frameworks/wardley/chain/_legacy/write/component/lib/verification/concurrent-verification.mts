// Concurrent dual-verification orchestrator
//
// Extracted from dual-verification-orchestrator.mjs to enforce
// single-responsibility: this module handles launching LLM and web search
// verification signals in parallel, with per-signal timeouts and
// reconciliation of the concurrent pair.
//
// Usage:
//   import { verifyConcurrent, verifyConcurrentFull } from './concurrent-verification.mjs';

import {
  detectComponentType,
  COMPONENT_TYPE,
} from '#lib/component-detection.mjs';
import { classifySolutionLLM } from '#work-on-evolution/write/routing/detect-solution.mjs';
import { verifyViaWebSearch, combineWithPriorResult } from './web-search-verification.mjs';
import { logDebug } from '#lib/mcp-notifications.mjs';
import {
  raceWithTimeout,
  buildSuccessSignal,
  buildTimeoutSignal,
  buildErrorSignal,
  buildSkippedSignal,
} from './verification-signals.mjs';
import {
  toIntermediateResult,
  reconcileTwoTiers,
  reconcileSignalPair,
  buildResult,
} from './verification-reconciliation.mjs';

// Re-import thresholds from the orchestrator to avoid circular dependency —
// we define our own copy of the constants we need.
import { CONFIDENCE_THRESHOLD } from '#lib/component-detection.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Confidence thresholds for concurrent verification tiers.
 * Mirrors the THRESHOLDS from the sequential orchestrator.
 */
export const THRESHOLDS = {
  NAMING_SKIP: CONFIDENCE_THRESHOLD,  // 0.90
  LLM_SKIP: 0.85,
  MIN_VERIFIED: 0.70,
};

const TOOL = 'dual-verification';

/** Default timeout per verification signal (ms). Overridable via context. */
export const DEFAULT_SIGNAL_TIMEOUT_MS = 15_000;

// ─── Type Definitions ────────────────────────────────────────────────────────

/**
 * @typedef {Object} VerificationSignal
 * @property {'solution'|'capability'|null} classification
 * @property {number}    confidence
 * @property {string}    method
 * @property {string}    reasoning
 * @property {'success'|'timeout'|'error'|'skipped'} status
 * @property {number}    durationMs
 * @property {Object}    [raw]
 * @property {string}    [error]
 */

/**
 * @typedef {Object} DualSignalPair
 * @property {VerificationSignal}       llmSignal
 * @property {VerificationSignal}       webSearchSignal
 * @property {'solution'|'capability'}  classification
 * @property {number}                   confidence
 * @property {string}                   method
 * @property {string}                   reasoning
 * @property {boolean}                  verified
 * @property {number}                   totalDurationMs
 * @property {Object}                   [namingResult]
 */

// ─── verifyConcurrent ─────────────────────────────────────────────────────────

/**
 * Concurrent dual-verification orchestrator.
 *
 * Runs LLM verification and web search verification **in parallel** using
 * `Promise.allSettled` with per-signal timeouts. This minimizes total latency
 * compared to the sequential `verifyClassification` pipeline.
 *
 * Lifecycle:
 *   1. (Optional) Tier 1 naming convention check — if confidence >= 90%, returns
 *      immediately without invoking LLM or web search (cost optimization).
 *   2. Launches LLM and web search concurrently (each with independent timeout).
 *   3. Collects both signals (success / timeout / error / skipped).
 *   4. Reconciles the pair into a single classification.
 *   5. Returns structured DualSignalPair with both raw signals and reconciled result.
 *
 * @param {string} componentName - Component name to classify
 * @param {Object} [context={}]
 * @param {string}   [context.description]
 * @param {function} [context.llmCall]
 * @param {function} [context.webSearchCall]
 * @param {boolean}  [context.skipLLM=false]
 * @param {boolean}  [context.skipWebSearch=false]
 * @param {boolean}  [context.skipNamingPrecheck=false]
 * @param {number}   [context.llmTimeoutMs]
 * @param {number}   [context.webSearchTimeoutMs]
 * @returns {Promise<DualSignalPair>}
 */
// any: context bag carries description, llmCall, webSearchCall, timeoutMs, useLlmFallback, useWebSearch, etc.
export async function verifyConcurrent(componentName: string, context: any = {}): Promise<any> {
  const name = (componentName || '').trim();
  const concurrentStart = Date.now();

  if (!name) {
    const skippedSignal = buildSkippedSignal('llm', 'Empty component name');
    const skippedWeb = buildSkippedSignal('web-search', 'Empty component name');
    const reconciled = reconcileSignalPair(skippedSignal, skippedWeb);

    return {
      llmSignal: skippedSignal,
      webSearchSignal: skippedWeb,
      ...reconciled,
      verified: false,
      totalDurationMs: Date.now() - concurrentStart,
    };
  }

  const description = context.description || '';

  // ── Optional Tier 1: Naming convention pre-check ──────────────────────
  if (!context.skipNamingPrecheck) {
    const namingResult = detectComponentType(name, description);

    logDebug(TOOL, `Concurrent: Tier 1 (naming) for "${name}" → ` +
      `type=${namingResult.type}, confidence=${namingResult.confidence}`);

    if (namingResult.confidence >= THRESHOLDS.NAMING_SKIP) {
      logDebug(TOOL, `Concurrent: Tier 1 sufficient — skipping concurrent verification`);

      const llmSkipped = buildSkippedSignal('llm', 'Naming confidence sufficient');
      const webSkipped = buildSkippedSignal('web-search', 'Naming confidence sufficient');

      return {
        llmSignal: llmSkipped,
        webSearchSignal: webSkipped,
        classification: namingResult.type,
        confidence: namingResult.confidence,
        method: 'naming',
        reasoning: namingResult.reason,
        verified: true,
        totalDurationMs: Date.now() - concurrentStart,
        namingResult,
      };
    }
  }

  // ── Prepare concurrent verification promises ──────────────────────────

  const llmTimeoutMs = context.llmTimeoutMs || DEFAULT_SIGNAL_TIMEOUT_MS;
  const webSearchTimeoutMs = context.webSearchTimeoutMs || DEFAULT_SIGNAL_TIMEOUT_MS;

  // Build LLM promise (or skip)
  const canUseLLM = !context.skipLLM && typeof context.llmCall === 'function';
  const llmPromise = canUseLLM
    ? (async () => {
        const t0 = Date.now();
        const raced = await raceWithTimeout(
          classifySolutionLLM(name, context.llmCall, { context: description }),
          llmTimeoutMs,
          'LLM'
        );
        const elapsed = Date.now() - t0;

        if (raced.timedOut) {
          return buildTimeoutSignal('llm', llmTimeoutMs, elapsed);
        }
        if (raced.error) {
          return buildErrorSignal('llm', raced.error, elapsed);
        }
        return buildSuccessSignal(raced.value, 'llm', elapsed);
      })()
    : Promise.resolve(
        buildSkippedSignal('llm', context.skipLLM ? 'Forced skip' : 'No llmCall provided')
      );

  // Build web search promise (or skip)
  const canUseWebSearch = !context.skipWebSearch &&
    (typeof context.webSearchCall === 'function' || canUseLLM);
  const webSearchPromise = canUseWebSearch
    ? (async () => {
        const t0 = Date.now();
        // any: web search options (Claude Agent SDK loose shape)
        const webSearchOptions: any = {};
        if (typeof context.webSearchCall === 'function') {
          webSearchOptions.webSearchCall = context.webSearchCall;
        }
        if (description) {
          webSearchOptions.context = description;
        }

        const raced = await raceWithTimeout(
          verifyViaWebSearch(name, webSearchOptions),
          webSearchTimeoutMs,
          'web-search'
        );
        const elapsed = Date.now() - t0;

        if (raced.timedOut) {
          return buildTimeoutSignal('web-search', webSearchTimeoutMs, elapsed);
        }
        if (raced.error) {
          return buildErrorSignal('web-search', raced.error, elapsed);
        }
        return buildSuccessSignal(raced.value, 'web-search', elapsed);
      })()
    : Promise.resolve(
        buildSkippedSignal('web-search', context.skipWebSearch ? 'Forced skip' : 'No web search backend')
      );

  // ── Launch both concurrently ──────────────────────────────────────────

  logDebug(TOOL, `Concurrent: Launching LLM (${canUseLLM ? 'active' : 'skipped'}) and ` +
    `web search (${canUseWebSearch ? 'active' : 'skipped'}) for "${name}"...`);

  const [llmSettled, webSearchSettled] = await Promise.allSettled([llmPromise, webSearchPromise]);

  const llmSignal = llmSettled.status === 'fulfilled'
    ? llmSettled.value
    : buildErrorSignal('llm', new Error(llmSettled.reason?.message || 'Unknown error'), 0);

  const webSearchSignal = webSearchSettled.status === 'fulfilled'
    ? webSearchSettled.value
    : buildErrorSignal('web-search', new Error(webSearchSettled.reason?.message || 'Unknown error'), 0);

  logDebug(TOOL, `Concurrent: LLM signal → status=${llmSignal.status}, ` +
    `classification=${llmSignal.classification}, confidence=${llmSignal.confidence}, ` +
    `duration=${llmSignal.durationMs}ms`);
  logDebug(TOOL, `Concurrent: Web signal → status=${webSearchSignal.status}, ` +
    `classification=${webSearchSignal.classification}, confidence=${webSearchSignal.confidence}, ` +
    `duration=${webSearchSignal.durationMs}ms`);

  // ── Reconcile the pair ────────────────────────────────────────────────

  const reconciled = reconcileSignalPair(llmSignal, webSearchSignal);
  const totalDurationMs = Date.now() - concurrentStart;

  logDebug(TOOL, `Concurrent: Reconciled → ${reconciled.classification} ` +
    `(confidence=${reconciled.confidence}, method=${reconciled.method}, ` +
    `totalMs=${totalDurationMs})`);

  return {
    llmSignal,
    webSearchSignal,
    classification: reconciled.classification,
    confidence: reconciled.confidence,
    method: reconciled.method,
    reasoning: reconciled.reasoning,
    verified: reconciled.confidence >= THRESHOLDS.MIN_VERIFIED,
    totalDurationMs,
  };
}

// ─── verifyConcurrentFull ──────────────────────────────────────────────────────

/**
 * Full concurrent verification with Tier 1 pre-check and routing target computation.
 *
 * This is the high-level integration point for estimate-evolution.mjs.
 * It combines:
 *   1. Tier 1 naming convention check (optional short-circuit)
 *   2. Concurrent LLM + web search verification
 *   3. Reconciliation of all available signals (naming + pair)
 *   4. Routing target computation from the final classification
 *
 * Returns a VerifiedClassificationResult compatible with the existing
 * `verifyClassification` contract, enriched with the DualSignalPair detail.
 *
 * @param {string} componentName - Component name to classify
 * @param {Object} [context={}]  - Same context shape as verifyConcurrent
 * @returns {Promise<Object>}
 */
// any: same loose context bag as verifyConcurrent — full result includes raw signals
export async function verifyConcurrentFull(componentName: string, context: any = {}): Promise<any> {
  const name = (componentName || '').trim();

  if (!name) {
    const emptyResult = buildResult({
      classification: COMPONENT_TYPE.CAPABILITY,
      confidence: 0,
      method: 'error',
      reasoning: 'Empty or invalid component name',
      verified: false,
      tiersUsed: [],
      routingDetection: detectComponentType('', ''),
    });
    const emptyPair = await verifyConcurrent('', context);
    return { ...emptyResult, dualSignals: emptyPair };
  }

  const description = context.description || '';

  // ── Tier 1: Naming convention ──────────────────────────────────────────
  const namingResult = detectComponentType(name, description);
  const tiersUsed = ['naming'];

  // Short-circuit: naming alone is sufficient
  if (namingResult.confidence >= THRESHOLDS.NAMING_SKIP) {
    const emptyPair = {
      llmSignal: buildSkippedSignal('llm', 'Naming confidence sufficient'),
      webSearchSignal: buildSkippedSignal('web-search', 'Naming confidence sufficient'),
      classification: namingResult.type,
      confidence: namingResult.confidence,
      method: 'naming',
      reasoning: namingResult.reason,
      verified: true,
      totalDurationMs: 0,
      namingResult,
    };

    return {
      ...buildResult({
        classification: namingResult.type,
        confidence: namingResult.confidence,
        method: 'naming',
        reasoning: namingResult.reason,
        verified: true,
        tiersUsed,
        routingDetection: namingResult,
        namingResult,
      }),
      dualSignals: emptyPair,
    };
  }

  // ── Tier 2+3 concurrent: LLM + web search in parallel ─────────────────
  const dualSignals = await verifyConcurrent(name, {
    ...context,
    skipNamingPrecheck: true,  // already done
  });

  // Build the tiersUsed array from active signals
  if (dualSignals.llmSignal.status !== 'skipped') tiersUsed.push('llm');
  if (dualSignals.webSearchSignal.status !== 'skipped') tiersUsed.push('web-search');

  // ── Tier 4: Reconcile naming + concurrent pair ─────────────────────────
  const namingIntermediate = toIntermediateResult(namingResult);
  let finalClassification;
  let finalConfidence;
  let finalReasoning;
  let finalMethod;

  if (dualSignals.confidence > 0) {
    // Reconcile naming with the concurrent pair result
    const reconciled = reconcileTwoTiers(namingIntermediate, {
      classification: dualSignals.classification,
      confidence: dualSignals.confidence,
      method: dualSignals.method,
      reasoning: dualSignals.reasoning,
    });
    finalClassification = reconciled.classification;
    finalConfidence = reconciled.confidence;
    finalReasoning = reconciled.reasoning;
    finalMethod = tiersUsed.join('+');
  } else {
    // Concurrent pair failed — fall back to naming
    finalClassification = namingIntermediate.classification;
    finalConfidence = namingIntermediate.confidence;
    finalReasoning = `${namingIntermediate.reasoning} (concurrent verification unavailable)`;
    finalMethod = 'naming';
  }

  return {
    ...buildResult({
      classification: finalClassification,
      confidence: finalConfidence,
      method: finalMethod,
      reasoning: finalReasoning,
      verified: finalConfidence >= THRESHOLDS.MIN_VERIFIED,
      tiersUsed,
      routingDetection: namingResult,
      namingResult,
      llmResult: dualSignals.llmSignal.status === 'success' ? dualSignals.llmSignal.raw : undefined,
      webSearchResult: dualSignals.webSearchSignal.status === 'success' ? dualSignals.webSearchSignal.raw : undefined,
    }),
    dualSignals,
  };
}
