// Reconciliation logic for dual-verification pipeline
//
// Extracted from dual-verification-orchestrator.mjs to enforce
// single-responsibility: this module handles converting tier results
// to intermediate format and reconciling multiple verification signals
// into a single classification decision.

import { COMPONENT_TYPE } from '../../lib/component-detection.mjs';
import { determineRoutingTargets } from '../routing/solution-dispatch.mjs';

/**
 * Convert a ComponentTypeDetection (from naming conventions or LLM) into an
 * intermediate result object for reconciliation.
 *
 * @param {import('../../lib/component-detection.mjs').ComponentTypeDetection} detection
 * @returns {{ classification: string, confidence: number, method: string, reasoning: string }}
 */
export function toIntermediateResult(detection: any) {
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
export function reconcileTwoTiers(tierA: any, tierB: any): any {
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

/**
 * Reconcile a pair of verification signals into a single classification.
 *
 * Resolution rules (ordered by priority):
 *   1. Both successful and agree → boost confidence (average + 0.10 bonus, capped at 0.98)
 *   2. Both successful but disagree → trust higher confidence, apply 0.10 penalty (floor 0.45)
 *   3. Only one successful → use its result directly
 *   4. Neither successful → default to capability with 0 confidence
 *
 * @param {import('./dual-verification-orchestrator.mjs').VerificationSignal} llmSignal
 * @param {import('./dual-verification-orchestrator.mjs').VerificationSignal} webSearchSignal
 * @returns {{ classification: string, confidence: number, method: string, reasoning: string }}
 */
export function reconcileSignalPair(llmSignal: any, webSearchSignal: any): any {
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

// ─── Result Builder ─────────────────────────────────────────────────────────

/**
 * Build a VerifiedClassificationResult with routing targets pre-computed.
 *
 * @param {Object} params
 * @param {string} params.classification - 'solution' or 'capability'
 * @param {number} params.confidence - Confidence score (0–1)
 * @param {string} params.method - Method chain
 * @param {string} params.reasoning - Human-readable explanation
 * @param {boolean} [params.verified] - Whether the result meets verification threshold
 * @param {string[]} [params.tiersUsed] - Which tiers contributed
 * @param {Object} params.routingDetection - Original detection for routing
 * @param {Object} [params.namingResult] - Tier 1 naming result
 * @param {Object} [params.llmResult] - Tier 2 LLM result
 * @param {Object} [params.webSearchResult] - Tier 3 web search result
 * @returns {import('./dual-verification-orchestrator.mjs').VerifiedClassificationResult}
 */
export function buildResult(params: any): any {
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
