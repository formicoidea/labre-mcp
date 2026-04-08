// Dual-verification orchestrator for solution vs capability classification
//
// Accepts a component name and partial classification context, then runs a
// multi-tier verification pipeline to determine whether the component is a
// concrete SOLUTION (Kubernetes, Salesforce...) or an abstract CAPABILITY
// (container orchestration, CRM...).
//
// Pipeline (ordered by cost, short-circuits when confident):
//   Tier 1: Naming convention heuristics     (free, sub-ms)
//           → If confidence >= 90%, return immediately
//   Tier 2: LLM semantic classification      (moderate cost)
//           → Invoked when naming confidence < 90% and llmCall available
//   Tier 3: Web search evidence              (higher cost, highest accuracy)
//           → Invoked when LLM does not resolve above threshold
//   Tier 4: Reconciliation                   (combine all available signals)
//
// The result includes the verified classification plus the raw tier results
// for traceability. It also carries the ComponentTypeDetection from the
// existing solution-capability-router so downstream routing can use it
// without re-computing.
//
// This module does NOT modify any existing strategy files or the capability
// evaluation pipeline. It sits AFTER the classification gate and BEFORE
// strategy dispatch — called by estimate-evolution.mjs as a replacement for
// the direct detectComponentType() call when dual verification is desired.
//
// Usage:
//   import { verifyClassification } from './dual-verification-orchestrator.mjs';
//
//   const result = await verifyClassification('Kubernetes', {
//     description: 'Container platform for microservices',
//     llmCall: myLlmCall,
//   });
//   // → { classification: 'solution', confidence: 0.98, verified: true, ... }

import {
  detectComponentType,
  determineRoutingTargets,
  COMPONENT_TYPE,
  CONFIDENCE_THRESHOLD,
} from './solution-capability-router.mjs';
import { classifySolutionLLM } from './detect-solution.mjs';
import { verifyViaWebSearch, combineWithPriorResult } from './web-search-verification.mjs';
import { logDebug } from './mcp-notifications.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOOL = 'dual-verification';

/**
 * Confidence thresholds for each tier transition.
 *
 * - NAMING_SKIP: If naming convention confidence >= this, skip LLM tier.
 *   Reuses the CONFIDENCE_THRESHOLD from solution-capability-router (0.90).
 * - LLM_SKIP: If combined naming+LLM confidence >= this, skip web search tier.
 * - MIN_VERIFIED: Minimum confidence to consider the classification "verified".
 */
export const THRESHOLDS = {
  NAMING_SKIP: CONFIDENCE_THRESHOLD,  // 0.90
  LLM_SKIP: 0.85,
  MIN_VERIFIED: 0.70,
};

// ─── Type Definitions ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ClassificationContext
 * @property {string}  [description]    - Business/usage context for the component
 * @property {string}  [type]           - OWM DSL type hint (component, pipeline, anchor, etc.)
 * @property {string}  [capability]     - Already-identified underlying capability (if any)
 * @property {string}  [nature]         - Already-identified capability nature (if any)
 * @property {function(string): Promise<string>} [llmCall]
 *   LLM call function for Tier 2 fallback (from llm-call.mjs).
 *   If not provided, the pipeline stops after Tier 1 naming convention.
 * @property {function(string): Promise<string>} [webSearchCall]
 *   Web search call function for Tier 3 evidence (from web-search-verification.mjs).
 *   If not provided, the pipeline stops after Tier 2 LLM.
 * @property {boolean} [skipLLM=false]  - Force-skip the LLM tier (e.g. for cost control)
 * @property {boolean} [skipWebSearch=false] - Force-skip the web search tier
 */

/**
 * @typedef {Object} VerifiedClassificationResult
 * @property {'solution'|'capability'} classification - Verified component type
 * @property {number}  confidence      - Final confidence score (0-1)
 * @property {string}  method          - Detection method chain used:
 *   'naming' | 'naming+llm' | 'naming+web-search' | 'naming+llm+web-search'
 * @property {string}  reasoning       - Human-readable explanation of the final classification
 * @property {boolean} isSolution      - Convenience flag: classification === 'solution'
 * @property {boolean} verified        - true if at least two tiers agreed or a single tier had >= 90% confidence
 * @property {string[]} tiersUsed      - Which tiers were actually invoked: ['naming'], ['naming', 'llm'], etc.
 * @property {import('./solution-capability-router.mjs').ComponentTypeDetection} routingDetection
 *   - Full detection result from Tier 1 (solution-capability-router), preserved for downstream routing
 * @property {{ useSolutionStrategies: boolean, useCapabilityStrategies: boolean, mode: string }} routingTargets
 *   - Pre-computed routing targets based on the verified classification
 * @property {Object}  [namingResult]  - Raw result from Tier 1 naming convention
 * @property {Object}  [llmResult]     - Raw result from Tier 2 LLM (if invoked)
 * @property {Object}  [webSearchResult] - Raw result from Tier 3 web search (if invoked)
 */

// ─── Core Orchestrator ──────────────────────────────────────────────────────

/**
 * Dual-verification orchestrator: classify a component as solution or capability
 * using a multi-tier verification pipeline.
 *
 * The pipeline short-circuits at the earliest tier that produces a high-confidence
 * result, minimizing cost. Each subsequent tier adds evidence to increase
 * confidence or resolve ambiguity.
 *
 * Verification logic:
 *   - Tier 1 alone at >= 90% confidence → verified = true (dictionary match)
 *   - Tier 1 + Tier 2 agree → verified = true (boosted confidence)
 *   - Tier 1 + Tier 2 disagree → Tier 3 invoked as tiebreaker (if available)
 *   - Any final confidence >= MIN_VERIFIED (0.70) → verified = true
 *
 * @param {string} componentName - Component name to classify
 * @param {ClassificationContext} [context={}] - Partial classification context
 * @returns {Promise<VerifiedClassificationResult>} Verified classification result
 */
export async function verifyClassification(componentName, context = {}) {
  const name = (componentName || '').trim();

  if (!name) {
    return buildResult({
      classification: COMPONENT_TYPE.CAPABILITY,
      confidence: 0,
      method: 'error',
      reasoning: 'Empty or invalid component name',
      verified: false,
      tiersUsed: [],
      routingDetection: detectComponentType('', ''),
    });
  }

  const description = context.description || '';

  // ── Tier 1: Naming convention heuristics ─────────────────────────────────
  logDebug(TOOL, `Tier 1 (naming) for "${name}"...`);

  const namingResult = detectComponentType(name, description);
  const tiersUsed = ['naming'];

  logDebug(TOOL,
    `Tier 1 result: type=${namingResult.type}, confidence=${namingResult.confidence}, ` +
    `method=${namingResult.method}, needsFallback=${namingResult.needsFallback}`);

  // Short-circuit: high-confidence naming match → no further verification needed
  if (namingResult.confidence >= THRESHOLDS.NAMING_SKIP) {
    logDebug(TOOL, `Tier 1 sufficient (confidence=${namingResult.confidence} >= ${THRESHOLDS.NAMING_SKIP}) — skipping LLM/web`);

    return buildResult({
      classification: namingResult.type,
      confidence: namingResult.confidence,
      method: 'naming',
      reasoning: namingResult.reason,
      verified: true,
      tiersUsed,
      routingDetection: namingResult,
      namingResult,
    });
  }

  // ── Tier 2: LLM semantic classification ──────────────────────────────────
  let llmResult = null;
  let currentBest = toIntermediateResult(namingResult);

  const canUseLLM = !context.skipLLM && typeof context.llmCall === 'function';

  if (canUseLLM) {
    logDebug(TOOL, `Tier 2 (LLM) for "${name}" (naming confidence=${namingResult.confidence} < ${THRESHOLDS.NAMING_SKIP})...`);
    tiersUsed.push('llm');

    try {
      llmResult = await classifySolutionLLM(name, context.llmCall, {
        context: description,
      });

      logDebug(TOOL,
        `Tier 2 result: ${llmResult.classification} (confidence=${llmResult.confidence})`);

      // Reconcile naming + LLM
      currentBest = reconcileTwoTiers(currentBest, {
        classification: llmResult.classification,
        confidence: llmResult.confidence,
        method: 'llm',
        reasoning: llmResult.reasoning,
      });

      logDebug(TOOL,
        `After reconciliation: ${currentBest.classification} (confidence=${currentBest.confidence})`);

      // Short-circuit: if combined result is above LLM_SKIP threshold, stop
      if (currentBest.confidence >= THRESHOLDS.LLM_SKIP) {
        logDebug(TOOL,
          `Tier 1+2 sufficient (confidence=${currentBest.confidence} >= ${THRESHOLDS.LLM_SKIP}) — skipping web search`);

        return buildResult({
          ...currentBest,
          method: 'naming+llm',
          verified: currentBest.confidence >= THRESHOLDS.MIN_VERIFIED,
          tiersUsed,
          routingDetection: namingResult,
          namingResult,
          llmResult,
        });
      }
    } catch (err) {
      logDebug(TOOL, `Tier 2 (LLM) failed for "${name}": ${err.message}`);
      llmResult = { error: err.message };
    }
  } else {
    logDebug(TOOL, `Tier 2 (LLM) skipped: ${context.skipLLM ? 'forced skip' : 'no llmCall provided'}`);
  }

  // ── Tier 3: Web search evidence ──────────────────────────────────────────
  let webSearchResult = null;

  const canUseWebSearch = !context.skipWebSearch &&
    (typeof context.webSearchCall === 'function' || canUseLLM);

  if (canUseWebSearch && currentBest.confidence < THRESHOLDS.LLM_SKIP) {
    logDebug(TOOL, `Tier 3 (web search) for "${name}" (combined confidence=${currentBest.confidence} < ${THRESHOLDS.LLM_SKIP})...`);
    tiersUsed.push('web-search');

    try {
      const webSearchOptions = {};
      if (typeof context.webSearchCall === 'function') {
        webSearchOptions.webSearchCall = context.webSearchCall;
      }
      if (description) {
        webSearchOptions.context = description;
      }

      webSearchResult = await verifyViaWebSearch(name, webSearchOptions);

      logDebug(TOOL,
        `Tier 3 result: ${webSearchResult.classification} (confidence=${webSearchResult.confidence})`);

      // Combine web search with current best using the existing combiner
      const combined = combineWithPriorResult(currentBest, webSearchResult);
      currentBest = {
        classification: combined.classification,
        confidence: combined.confidence,
        method: combined.method,
        reasoning: combined.reasoning,
      };

      logDebug(TOOL,
        `After web search reconciliation: ${currentBest.classification} (confidence=${currentBest.confidence})`);
    } catch (err) {
      logDebug(TOOL, `Tier 3 (web search) failed for "${name}": ${err.message}`);
      webSearchResult = { error: err.message };
    }
  } else {
    logDebug(TOOL,
      `Tier 3 (web search) skipped: ${context.skipWebSearch ? 'forced skip' : currentBest.confidence >= THRESHOLDS.LLM_SKIP ? 'confidence sufficient' : 'no search backend'}`);
  }

  // ── Final result ─────────────────────────────────────────────────────────
  const methodChain = tiersUsed.join('+');

  return buildResult({
    classification: currentBest.classification,
    confidence: currentBest.confidence,
    method: methodChain || currentBest.method,
    reasoning: currentBest.reasoning,
    verified: currentBest.confidence >= THRESHOLDS.MIN_VERIFIED,
    tiersUsed,
    routingDetection: namingResult,
    namingResult,
    llmResult,
    webSearchResult,
  });
}

// ─── Reconciliation Helpers ─────────────────────────────────────────────────

/**
 * Convert a ComponentTypeDetection (from solution-capability-router) to an
 * intermediate result object for reconciliation.
 *
 * @param {import('./solution-capability-router.mjs').ComponentTypeDetection} detection
 * @returns {{ classification: string, confidence: number, method: string, reasoning: string }}
 */
function toIntermediateResult(detection) {
  return {
    classification: detection.type,
    confidence: detection.confidence,
    method: detection.method,
    reasoning: detection.reason || '',
  };
}

/**
 * Reconcile two tier results using agreement/disagreement logic.
 *
 * When both tiers agree on classification:
 *   → Boost confidence: average of both + 0.10 agreement bonus (capped at 0.98)
 *
 * When tiers disagree:
 *   → Trust the tier with higher confidence, but apply a 0.10 disagreement penalty
 *   → Minimum confidence floor of 0.45
 *
 * This mirrors the combineWithPriorResult logic in web-search-verification.mjs
 * and the naming+llm reconciliation in detect-solution.mjs.
 *
 * @param {{ classification: string, confidence: number, method: string, reasoning: string }} tierA
 * @param {{ classification: string, confidence: number, method: string, reasoning: string }} tierB
 * @returns {{ classification: string, confidence: number, method: string, reasoning: string }}
 */
function reconcileTwoTiers(tierA, tierB) {
  if (tierA.classification === tierB.classification) {
    // Agreement: boost confidence
    const boosted = Math.round(
      Math.min(0.98, (tierA.confidence + tierB.confidence) / 2 + 0.10) * 100
    ) / 100;

    return {
      classification: tierA.classification,
      confidence: boosted,
      method: `${tierA.method}+${tierB.method}`,
      reasoning: `${tierB.reasoning} (agrees with ${tierA.method}: ${tierA.reasoning})`,
    };
  }

  // Disagreement: trust higher-confidence tier with penalty
  const winner = tierA.confidence >= tierB.confidence ? tierA : tierB;
  const loser = tierA.confidence >= tierB.confidence ? tierB : tierA;

  const penalized = Math.round(
    Math.max(0.45, winner.confidence - 0.10) * 100
  ) / 100;

  return {
    classification: winner.classification,
    confidence: penalized,
    method: `${tierA.method}+${tierB.method}`,
    reasoning: `${winner.method} overrides ${loser.method}: ${winner.reasoning} (${loser.method} said: ${loser.classification})`,
  };
}

// ─── Result Builder ─────────────────────────────────────────────────────────

/**
 * Build a VerifiedClassificationResult with routing targets pre-computed.
 *
 * @param {Object} params
 * @returns {VerifiedClassificationResult}
 */
function buildResult(params) {
  const {
    classification,
    confidence,
    method,
    reasoning,
    verified,
    tiersUsed,
    routingDetection,
    namingResult,
    llmResult,
    webSearchResult,
  } = params;

  const isSolution = classification === COMPONENT_TYPE.SOLUTION;

  // Pre-compute routing targets using the verified classification
  // Override the naming detection type with the verified classification
  const overriddenDetection = {
    ...routingDetection,
    type: classification,
    confidence,
  };
  const routingTargets = determineRoutingTargets(overriddenDetection);

  return {
    classification,
    confidence,
    method,
    reasoning,
    isSolution,
    verified: verified || false,
    tiersUsed: tiersUsed || [],
    routingDetection,
    routingTargets,
    ...(namingResult !== undefined && { namingResult }),
    ...(llmResult !== undefined && { llmResult }),
    ...(webSearchResult !== undefined && { webSearchResult }),
  };
}

// ─── Concurrent Dual-Verification ───────────────────────────────────────────

/**
 * @typedef {Object} VerificationSignal
 * @property {'solution'|'capability'|null} classification - Classified component type (null if failed/timed out)
 * @property {number}    confidence  - Confidence score (0–1), 0 if failed/timed out
 * @property {string}    method      - Signal source: 'llm' or 'web-search'
 * @property {string}    reasoning   - Human-readable explanation or error description
 * @property {'success'|'timeout'|'error'|'skipped'} status
 *   Signal outcome: 'success' if the verification returned normally,
 *   'timeout' if the per-signal timeout elapsed, 'error' if it threw,
 *   'skipped' if the backend was unavailable/disabled.
 * @property {number}    durationMs  - Wall-clock time for this signal (0 if skipped)
 * @property {Object}    [raw]       - Raw result from the verification backend (for traceability)
 * @property {string}    [error]     - Error message (when status is 'error' or 'timeout')
 */

/**
 * @typedef {Object} DualSignalPair
 * @property {VerificationSignal}       llmSignal        - LLM verification signal
 * @property {VerificationSignal}       webSearchSignal  - Web search verification signal
 * @property {'solution'|'capability'}  classification   - Reconciled classification from the pair
 * @property {number}                   confidence       - Reconciled confidence from the pair
 * @property {string}                   method           - Method chain describing which signals contributed
 * @property {string}                   reasoning        - Combined reasoning
 * @property {boolean}                  verified         - Whether the reconciled result meets MIN_VERIFIED threshold
 * @property {number}                   totalDurationMs  - Total wall-clock time for the concurrent invocation
 * @property {import('./solution-capability-router.mjs').ComponentTypeDetection} [namingResult]
 *   Tier 1 naming result passed through for context (if a naming pre-check was done)
 */

/** Default timeout per verification signal (ms). Overridable via context. */
const DEFAULT_SIGNAL_TIMEOUT_MS = 15_000;

/**
 * Race a promise against a timeout. Returns the promise result on success,
 * or a timeout sentinel on expiry.
 *
 * @param {Promise<T>}  promise    - The verification promise to race
 * @param {number}      timeoutMs  - Timeout in milliseconds
 * @param {string}      label      - Label for timeout error messages
 * @returns {Promise<{ value: T, timedOut: false } | { value: null, timedOut: true }>}
 * @template T
 */
function raceWithTimeout(promise, timeoutMs, label) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ value: null, timedOut: true });
      }
    }, timeoutMs);

    promise
      .then((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ value, timedOut: false });
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          // Re-throw wrapped so Promise.allSettled captures it
          resolve({ value: null, timedOut: false, error: err });
        }
      });
  });
}

/**
 * Build a VerificationSignal from a successful verification result.
 *
 * @param {Object} result     - Raw result from the verification backend
 * @param {string} method     - Signal method: 'llm' or 'web-search'
 * @param {number} durationMs - Duration in milliseconds
 * @returns {VerificationSignal}
 */
function buildSuccessSignal(result, method, durationMs) {
  return {
    classification: result.classification || null,
    confidence: typeof result.confidence === 'number' ? result.confidence : 0,
    method,
    reasoning: result.reasoning || '',
    status: 'success',
    durationMs,
    raw: result,
  };
}

/**
 * Build a VerificationSignal for a timeout.
 *
 * @param {string} method     - Signal method: 'llm' or 'web-search'
 * @param {number} timeoutMs  - The timeout that was exceeded
 * @param {number} durationMs - Actual elapsed time
 * @returns {VerificationSignal}
 */
function buildTimeoutSignal(method, timeoutMs, durationMs) {
  return {
    classification: null,
    confidence: 0,
    method,
    reasoning: `${method} verification timed out after ${timeoutMs}ms`,
    status: 'timeout',
    durationMs,
    error: `Timeout after ${timeoutMs}ms`,
  };
}

/**
 * Build a VerificationSignal for an error.
 *
 * @param {string} method     - Signal method: 'llm' or 'web-search'
 * @param {Error}  err        - The error that occurred
 * @param {number} durationMs - Duration before failure
 * @returns {VerificationSignal}
 */
function buildErrorSignal(method, err, durationMs) {
  return {
    classification: null,
    confidence: 0,
    method,
    reasoning: `${method} verification failed: ${err.message}`,
    status: 'error',
    durationMs,
    error: err.message,
  };
}

/**
 * Build a VerificationSignal for a skipped verification.
 *
 * @param {string} method - Signal method: 'llm' or 'web-search'
 * @param {string} reason - Why the signal was skipped
 * @returns {VerificationSignal}
 */
function buildSkippedSignal(method, reason) {
  return {
    classification: null,
    confidence: 0,
    method,
    reasoning: reason,
    status: 'skipped',
    durationMs: 0,
  };
}

/**
 * Reconcile a pair of verification signals into a single classification.
 *
 * Resolution rules (ordered by priority):
 *   1. Both successful and agree → boost confidence (average + 0.10 bonus, capped at 0.98)
 *   2. Both successful but disagree → trust higher confidence, apply 0.10 penalty (floor 0.45)
 *   3. Only one successful → use its result directly
 *   4. Neither successful → default to capability with 0 confidence
 *
 * @param {VerificationSignal} llmSignal
 * @param {VerificationSignal} webSearchSignal
 * @returns {{ classification: string, confidence: number, method: string, reasoning: string }}
 */
function reconcileSignalPair(llmSignal, webSearchSignal) {
  const llmOk = llmSignal.status === 'success' && llmSignal.classification != null;
  const webOk = webSearchSignal.status === 'success' && webSearchSignal.classification != null;

  // Case 4: Neither succeeded
  if (!llmOk && !webOk) {
    const reasons = [];
    if (llmSignal.status !== 'skipped') reasons.push(`LLM: ${llmSignal.reasoning}`);
    if (webSearchSignal.status !== 'skipped') reasons.push(`Web: ${webSearchSignal.reasoning}`);
    return {
      classification: COMPONENT_TYPE.CAPABILITY,
      confidence: 0,
      method: 'none',
      reasoning: reasons.length > 0
        ? `Both verifications failed: ${reasons.join('; ')}`
        : 'Both verifications were skipped',
    };
  }

  // Case 3a: Only LLM succeeded
  if (llmOk && !webOk) {
    return {
      classification: llmSignal.classification,
      confidence: llmSignal.confidence,
      method: 'llm',
      reasoning: `${llmSignal.reasoning} (web search ${webSearchSignal.status})`,
    };
  }

  // Case 3b: Only web search succeeded
  if (!llmOk && webOk) {
    return {
      classification: webSearchSignal.classification,
      confidence: webSearchSignal.confidence,
      method: 'web-search',
      reasoning: `${webSearchSignal.reasoning} (LLM ${llmSignal.status})`,
    };
  }

  // Case 1 & 2: Both succeeded
  if (llmSignal.classification === webSearchSignal.classification) {
    // Case 1: Agreement — boost confidence
    const boosted = Math.round(
      Math.min(0.98, (llmSignal.confidence + webSearchSignal.confidence) / 2 + 0.10) * 100
    ) / 100;

    return {
      classification: llmSignal.classification,
      confidence: boosted,
      method: 'llm+web-search',
      reasoning: `${webSearchSignal.reasoning} (LLM agrees: ${llmSignal.reasoning})`,
    };
  }

  // Case 2: Disagreement — trust higher confidence with penalty
  const winner = llmSignal.confidence >= webSearchSignal.confidence ? llmSignal : webSearchSignal;
  const loser = llmSignal.confidence >= webSearchSignal.confidence ? webSearchSignal : llmSignal;

  const penalized = Math.round(
    Math.max(0.45, winner.confidence - 0.10) * 100
  ) / 100;

  return {
    classification: winner.classification,
    confidence: penalized,
    method: 'llm+web-search',
    reasoning: `${winner.method} overrides ${loser.method}: ${winner.reasoning} (${loser.method} said: ${loser.classification})`,
  };
}

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
 * @param {string}   [context.description]       - Business/usage context
 * @param {function} [context.llmCall]            - LLM call function (from llm-call.mjs)
 * @param {function} [context.webSearchCall]      - Web search call function
 * @param {boolean}  [context.skipLLM=false]      - Force-skip LLM signal
 * @param {boolean}  [context.skipWebSearch=false] - Force-skip web search signal
 * @param {boolean}  [context.skipNamingPrecheck=false] - Skip Tier 1 naming pre-check
 * @param {number}   [context.llmTimeoutMs]       - Per-signal timeout for LLM (default: 15000ms)
 * @param {number}   [context.webSearchTimeoutMs]  - Per-signal timeout for web search (default: 15000ms)
 * @returns {Promise<DualSignalPair>} Structured pair of verification signals with reconciled classification
 */
export async function verifyConcurrent(componentName, context = {}) {
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
  // Short-circuit if naming alone gives >= 90% confidence (avoids LLM/web cost)
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
        const webSearchOptions = {};
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

  // Extract signals — Promise.allSettled always returns 'fulfilled' here because
  // our promise wrappers catch all errors internally
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
 * @returns {Promise<VerifiedClassificationResult & { dualSignals: DualSignalPair }>}
 */
export async function verifyConcurrentFull(componentName, context = {}) {
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
  // When the concurrent pair produced a result, reconcile it with naming
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

// ─── Convenience: classify without fallback ─────────────────────────────────

/**
 * Quick classification using only Tier 1 naming convention (no LLM, no web search).
 *
 * This is a thin wrapper around detectComponentType() that returns the same
 * VerifiedClassificationResult shape for API consistency.
 *
 * Useful for hot paths where cost must be zero and the caller can tolerate
 * lower confidence on unknown components.
 *
 * @param {string} componentName - Component name to classify
 * @param {string} [description] - Optional business context
 * @returns {VerifiedClassificationResult}
 */
export function classifyNamingOnly(componentName, description = '') {
  const name = (componentName || '').trim();
  const namingResult = detectComponentType(name, description);

  return buildResult({
    classification: namingResult.type,
    confidence: namingResult.confidence,
    method: 'naming',
    reasoning: namingResult.reason,
    verified: namingResult.confidence >= THRESHOLDS.NAMING_SKIP,
    tiersUsed: ['naming'],
    routingDetection: namingResult,
    namingResult,
  });
}

// ─── Re-exports for consumer convenience ────────────────────────────────────

export { COMPONENT_TYPE, CONFIDENCE_THRESHOLD };

/**
 * Exported for testing: signal builders and reconciliation.
 * These are implementation details exposed to enable thorough unit testing.
 */
export const _internal = {
  buildSuccessSignal,
  buildTimeoutSignal,
  buildErrorSignal,
  buildSkippedSignal,
  reconcileSignalPair,
  raceWithTimeout,
  DEFAULT_SIGNAL_TIMEOUT_MS,
};

// ─── Self-test ──────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== dual-verification-orchestrator.mjs self-test ===\n');

  // ── Test 1: High-confidence solution (Tier 1 only) ────────────────────
  console.log('--- Test 1: Known solution (Tier 1 short-circuit) ---');
  const r1 = await verifyClassification('Kubernetes');
  console.assert(r1.classification === 'solution', `Expected solution, got ${r1.classification}`);
  console.assert(r1.confidence >= 0.90, `Expected confidence >= 0.90, got ${r1.confidence}`);
  console.assert(r1.verified === true, 'Should be verified');
  console.assert(r1.tiersUsed.length === 1, `Expected 1 tier, got ${r1.tiersUsed.length}`);
  console.assert(r1.tiersUsed[0] === 'naming', `Expected naming tier, got ${r1.tiersUsed[0]}`);
  console.assert(r1.isSolution === true, 'isSolution should be true');
  console.assert(r1.routingTargets != null, 'Should have routingTargets');
  console.log(`  OK: "${r1.classification}" (confidence=${r1.confidence}, method=${r1.method}, tiers=${r1.tiersUsed.join('+')})`);

  // ── Test 2: High-confidence capability (Tier 1 only) ──────────────────
  console.log('\n--- Test 2: Known capability (Tier 1 short-circuit) ---');
  const r2 = await verifyClassification('CRM');
  console.assert(r2.classification === 'capability', `Expected capability, got ${r2.classification}`);
  console.assert(r2.confidence >= 0.90, `Expected confidence >= 0.90, got ${r2.confidence}`);
  console.assert(r2.verified === true, 'Should be verified');
  console.assert(r2.isSolution === false, 'isSolution should be false');
  console.log(`  OK: "${r2.classification}" (confidence=${r2.confidence}, method=${r2.method})`);

  // ── Test 3: Low-confidence naming → LLM fallback ─────────────────────
  console.log('\n--- Test 3: Ambiguous name with mock LLM ---');
  const mockLLM = async (prompt) => {
    if (prompt.includes('MyCustomWidget')) {
      return 'classification=SOLUTION\nconfidence=0.82\nreasoning=MyCustomWidget appears to be a specific product with a branded name';
    }
    return 'classification=CAPABILITY\nconfidence=0.75\nreasoning=Default to capability';
  };
  const r3 = await verifyClassification('MyCustomWidget', { llmCall: mockLLM, skipWebSearch: true });
  console.assert(r3.tiersUsed.includes('llm'), 'LLM tier should have been used');
  console.assert(r3.llmResult != null, 'Should have llmResult');
  console.log(`  OK: "${r3.classification}" (confidence=${r3.confidence}, method=${r3.method}, tiers=${r3.tiersUsed.join('+')})`);

  // ── Test 4: No LLM → returns naming-only result ──────────────────────
  console.log('\n--- Test 4: Ambiguous name without LLM ---');
  const r4 = await verifyClassification('XyzFooWidget');
  console.assert(r4.tiersUsed.length === 1, `Expected 1 tier without LLM, got ${r4.tiersUsed.length}`);
  console.assert(r4.tiersUsed[0] === 'naming', 'Should only use naming');
  console.assert(r4.verified === false || r4.confidence >= THRESHOLDS.MIN_VERIFIED, 'Verification status should be based on confidence');
  console.log(`  OK: "${r4.classification}" (confidence=${r4.confidence}, verified=${r4.verified})`);

  // ── Test 5: Empty name ────────────────────────────────────────────────
  console.log('\n--- Test 5: Empty name ---');
  const r5 = await verifyClassification('');
  console.assert(r5.classification === 'capability', 'Empty → capability');
  console.assert(r5.confidence === 0, 'Empty → 0 confidence');
  console.assert(r5.verified === false, 'Empty → not verified');
  console.log(`  OK: classification=${r5.classification}, confidence=${r5.confidence}`);

  // ── Test 6: Null/undefined name ───────────────────────────────────────
  console.log('\n--- Test 6: Null name ---');
  const r6 = await verifyClassification(null);
  console.assert(r6.classification === 'capability', 'Null → capability');
  console.assert(r6.verified === false, 'Null → not verified');
  console.log(`  OK: classification=${r6.classification}, confidence=${r6.confidence}`);

  // ── Test 7: LLM + naming agreement boosts confidence ──────────────────
  console.log('\n--- Test 7: LLM agrees with naming → confidence boost ---');
  const agreeLLM = async () => 'classification=SOLUTION\nconfidence=0.78\nreasoning=Looks like a product';
  // "React 18" matches version-number heuristic → solution with ~0.65-0.70
  const r7 = await verifyClassification('React 18', { llmCall: agreeLLM, skipWebSearch: true });
  console.assert(r7.classification === 'solution', 'Should be solution');
  // Naming: ~0.65 + LLM: 0.78 → agreement boost should push confidence higher
  console.log(`  OK: "${r7.classification}" (confidence=${r7.confidence}, method=${r7.method}, tiers=${r7.tiersUsed.join('+')})`);

  // ── Test 8: classifyNamingOnly convenience ────────────────────────────
  console.log('\n--- Test 8: classifyNamingOnly ---');
  const r8 = classifyNamingOnly('Salesforce', 'CRM platform');
  console.assert(r8.classification === 'solution', 'Salesforce → solution');
  console.assert(r8.confidence >= 0.90, 'Should be high confidence');
  console.assert(r8.verified === true, 'Known solution → verified');
  console.assert(r8.routingTargets.useSolutionStrategies === true, 'Should route to solution strategies');
  console.log(`  OK: "${r8.classification}" (confidence=${r8.confidence}, verified=${r8.verified})`);

  // ── Test 9: Routing targets are correct ───────────────────────────────
  console.log('\n--- Test 9: Routing targets ---');
  const r9sol = await verifyClassification('Docker');
  console.assert(r9sol.routingTargets.useSolutionStrategies === true, 'Docker → use solution strategies');
  console.log(`  Docker: solution=${r9sol.routingTargets.useSolutionStrategies}, capability=${r9sol.routingTargets.useCapabilityStrategies}`);

  const r9cap = await verifyClassification('container orchestration');
  console.assert(r9cap.routingTargets.useCapabilityStrategies === true, 'container orchestration → use capability strategies');
  console.log(`  container orchestration: solution=${r9cap.routingTargets.useSolutionStrategies}, capability=${r9cap.routingTargets.useCapabilityStrategies}`);

  // ── Test 10: Description context is passed through ────────────────────
  console.log('\n--- Test 10: Description context ---');
  const r10 = await verifyClassification('MyTool', {
    description: 'A vendor platform for service management',
    skipLLM: true,
    skipWebSearch: true,
  });
  console.log(`  MyTool (vendor context): ${r10.classification} (confidence=${r10.confidence})`);
  console.assert(r10.namingResult != null, 'Should have namingResult');

  // ── Test 11: Mock web search tier ─────────────────────────────────────
  console.log('\n--- Test 11: Full pipeline with mock LLM + web search ---');
  const uncertainLLM = async () => 'classification=SOLUTION\nconfidence=0.62\nreasoning=Possibly a product';
  const mockWebSearch = async (prompt) => {
    return 'classification=SOLUTION\nconfidence=0.88\nreasoning=Found official website and GitHub repository\n' +
      'EVIDENCE_START\ntype=product-page|description=Official site|source=example.com|supports=solution\nEVIDENCE_END\n' +
      'REFERENCES_START\ntitle=Example|url=https://example.com|snippet=A product\nREFERENCES_END';
  };
  const r11 = await verifyClassification('ObscureProduct', {
    llmCall: uncertainLLM,
    webSearchCall: mockWebSearch,
  });
  console.assert(r11.tiersUsed.includes('web-search'), 'Web search tier should have been used');
  console.assert(r11.webSearchResult != null, 'Should have webSearchResult');
  console.log(`  OK: "${r11.classification}" (confidence=${r11.confidence}, method=${r11.method}, tiers=${r11.tiersUsed.join('+')})`);

  // ── Test 12: skipLLM flag ─────────────────────────────────────────────
  console.log('\n--- Test 12: skipLLM forces naming-only ---');
  const neverCalledLLM = async () => { throw new Error('Should not be called'); };
  const r12 = await verifyClassification('SomeWidget', { llmCall: neverCalledLLM, skipLLM: true });
  console.assert(!r12.tiersUsed.includes('llm'), 'LLM should have been skipped');
  console.log(`  OK: tiers=${r12.tiersUsed.join('+')}, classification=${r12.classification}`);

  console.log('\n=== All dual-verification-orchestrator self-tests passed ===');
}
