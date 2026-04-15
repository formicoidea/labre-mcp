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
  COMPONENT_TYPE,
  CONFIDENCE_THRESHOLD,
} from '../../lib/component-detection.mjs';
import {
  determineRoutingTargets,
} from '../routing/solution-dispatch.mjs';
import { classifySolutionLLM } from '../routing/detect-solution.mjs';
import { verifyViaWebSearch, combineWithPriorResult } from '../routing/web-search-verification.mjs';
import { logDebug } from '../../lib/mcp-notifications.mjs';
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
 * @property {import('../routing/solution-capability-router.mjs').ComponentTypeDetection} routingDetection
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
// any: context bag (description, llmCall, webSearchCall, timeoutMs, etc.) — heterogeneous result shape
export async function verifyClassification(componentName: string, context: any = {}): Promise<any> {
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
      logDebug(TOOL, `Tier 2 (LLM) failed for "${name}": ${toErrorMessage(err)}`);
      llmResult = { error: toErrorMessage(err) };
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
      // any: web search options (Claude Agent SDK loose shape)
      const webSearchOptions: any = {};
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
      logDebug(TOOL, `Tier 3 (web search) failed for "${name}": ${toErrorMessage(err)}`);
      webSearchResult = { error: toErrorMessage(err) };
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

// toIntermediateResult, reconcileTwoTiers, buildResult — imported from ./verification-reconciliation.mjs

// ─── Concurrent Dual-Verification ───────────────────────────────────────────
// Extracted to ./concurrent-verification.mjs for single-responsibility.
// Re-exported here for backward compatibility.

import {
  verifyConcurrent,
  verifyConcurrentFull,
  DEFAULT_SIGNAL_TIMEOUT_MS,
} from './concurrent-verification.mjs';
import { toErrorMessage, errorCode } from '../../lib/errors.mjs';

export { verifyConcurrent, verifyConcurrentFull };

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
export function classifyNamingOnly(componentName: string, description: string = '') {
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

