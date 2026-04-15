// Signal Combiner for Solution vs Capability Classification
//
// Combines LLM classification signal and web search signal into a single
// solution-or-capability determination with a combined confidence score.
//
// Three merge cases:
//   1. Agreement     — Both signals classify the same type → boost confidence
//   2. Disagreement  — Signals disagree → weighted fallback to higher-confidence signal
//   3. Partial/missing — One or both signals are absent/failed → graceful degradation
//
// This module is the single source of truth for signal combination logic
// used by the routing layer (dual-verification-orchestrator, estimate-evolution).
//
// It does NOT modify any existing strategy files or the capability pipeline.
// It sits within the verification pipeline, consuming verification signal
// outputs and producing a reconciled classification.

import { logDebug } from '../../lib/mcp-notifications.mjs';
import type { VerificationSignal, CombinedSignalResult } from '../../types/pipeline.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────

const TOOL = 'signal-combiner';

/** Component type constants (mirroring solution-capability-router) */
export const COMPONENT_TYPE = {
  SOLUTION: 'solution',
  CAPABILITY: 'capability',
};

/**
 * Confidence adjustment parameters.
 *
 * These are tuned to match the existing reconciliation logic in
 * dual-verification-orchestrator.mjs and web-search-verification.mjs,
 * ensuring consistent behavior across the codebase.
 */
export const COMBINATION_PARAMS = {
  /** Bonus added when both signals agree (on top of their average) */
  AGREEMENT_BONUS: 0.10,
  /** Maximum confidence after combination (prevents over-confidence) */
  MAX_CONFIDENCE: 0.98,
  /** Penalty applied when signals disagree (subtracted from winner) */
  DISAGREEMENT_PENALTY: 0.10,
  /** Minimum confidence floor after disagreement penalty */
  DISAGREEMENT_FLOOR: 0.45,
  /** Weight given to LLM signal when both are present (web search gets 1 - this) */
  LLM_WEIGHT: 0.45,
  /** Weight given to web search signal when both are present */
  WEB_SEARCH_WEIGHT: 0.55,
  /** Minimum confidence for a signal to be considered "usable" */
  MIN_SIGNAL_CONFIDENCE: 0.10,
  /** Confidence degradation factor when a signal is missing/failed */
  MISSING_SIGNAL_DEGRADATION: 0.85,
};

/**
 * Signal status values.
 * Matches the VerificationSignal status enum from dual-verification-orchestrator.
 */
export const SIGNAL_STATUS = {
  SUCCESS: 'success',
  TIMEOUT: 'timeout',
  ERROR: 'error',
  SKIPPED: 'skipped',
};

// ─── Type Definitions ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ClassificationSignal
 * @property {'solution'|'capability'|null} classification - Classified component type (null if failed)
 * @property {number}    confidence  - Confidence score (0-1), 0 if failed/unavailable
 * @property {string}    method      - Signal source identifier: 'llm', 'web-search', 'naming', etc.
 * @property {string}    [reasoning] - Human-readable explanation
 * @property {'success'|'timeout'|'error'|'skipped'} [status] - Signal outcome
 * @property {number}    [durationMs] - Wall-clock time for this signal
 * @property {Object}    [raw]       - Raw result from the verification backend
 * @property {string}    [error]     - Error message (when status is 'error' or 'timeout')
 */

/**
 * @typedef {Object} CombinedClassificationResult
 * @property {'solution'|'capability'} classification - Final combined classification
 * @property {number}    confidence   - Combined confidence score (0-1)
 * @property {string}    method       - Method chain describing which signals contributed
 * @property {string}    reasoning    - Combined human-readable reasoning
 * @property {'agreement'|'disagreement'|'single-signal'|'no-signal'} mergeCase
 *   Which of the three merge cases was applied
 * @property {boolean}   verified     - true if confidence >= MIN_VERIFIED threshold
 * @property {boolean}   isSolution   - Convenience flag: classification === 'solution'
 * @property {Object}    [signals]    - Both input signals preserved for traceability
 * @property {ClassificationSignal} [signals.llm]       - LLM signal as received
 * @property {ClassificationSignal} [signals.webSearch]  - Web search signal as received
 */

// ─── Signal Validation ───────────────────────────────────────────────────────

/**
 * Check if a signal is usable (successful with a valid classification).
 *
 * A signal is usable when:
 *   - status is 'success' (or status field is absent, for backward compat)
 *   - classification is a non-null string ('solution' or 'capability')
 *   - confidence is a positive number above the minimum threshold
 *
 * @param {ClassificationSignal} signal - Signal to check
 * @returns {boolean} true if the signal provides a usable classification
 */
export function isSignalUsable(signal: VerificationSignal | null | undefined): boolean {
  if (!signal) return false;

  // Status check: success or absent status field (backward compatibility)
  const statusOk = !signal.status || signal.status === SIGNAL_STATUS.SUCCESS as 'success';

  // Classification must be a valid type
  const classOk = signal.classification === COMPONENT_TYPE.SOLUTION ||
                  signal.classification === COMPONENT_TYPE.CAPABILITY;

  // Confidence must be a positive number
  const confOk = typeof signal.confidence === 'number' &&
                 !Number.isNaN(signal.confidence) &&
                 signal.confidence >= COMBINATION_PARAMS.MIN_SIGNAL_CONFIDENCE;

  return statusOk && classOk && confOk;
}

/**
 * Normalize a signal input to a consistent shape.
 * Handles null/undefined signals and provides sensible defaults.
 *
 * @param {ClassificationSignal|null|undefined} signal - Raw signal input
 * @param {string} defaultMethod - Method label to use if not provided
 * @returns {ClassificationSignal} Normalized signal (never null)
 */
function normalizeSignal(signal: VerificationSignal | null | undefined, defaultMethod: string = 'unknown'): VerificationSignal {
  if (!signal) {
    return {
      classification: null as string | null,
      confidence: 0,
      method: defaultMethod,
      reasoning: `No ${defaultMethod} signal provided`,
      status: SIGNAL_STATUS.SKIPPED as 'skipped',
    };
  }

  return {
    classification: signal.classification || null,
    confidence: typeof signal.confidence === 'number' && !Number.isNaN(signal.confidence)
      ? signal.confidence : 0,
    method: signal.method || defaultMethod,
    reasoning: signal.reasoning || '',
    status: signal.status || (signal.classification ? SIGNAL_STATUS.SUCCESS as 'success' : SIGNAL_STATUS.SKIPPED as 'skipped'),
    ...(signal.durationMs !== undefined && { durationMs: signal.durationMs }),
    ...(signal.raw !== undefined && { raw: signal.raw }),
    ...(signal.error !== undefined && { error: signal.error }),
  };
}

// ─── Core Combination Function ───────────────────────────────────────────────

/**
 * Combine LLM classification signal and web search signal into a single
 * solution-or-capability determination.
 *
 * Merge cases (handled in order):
 *
 *   **Case 1: Agreement** (both usable, same classification)
 *     Confidence = avg(llm, webSearch) + AGREEMENT_BONUS (capped at MAX_CONFIDENCE)
 *     → High confidence because independent signals corroborate each other
 *
 *   **Case 2: Disagreement** (both usable, different classification)
 *     Winner = signal with higher confidence
 *     Confidence = max(weightedLlm, weightedWeb) - DISAGREEMENT_PENALTY (floor at DISAGREEMENT_FLOOR)
 *     → Lower confidence because the signals contradict; fallback to the stronger signal
 *     → When confidences are close (within 0.10), additional penalty applied
 *
 *   **Case 3: Partial/missing** (one or both signals not usable)
 *     - One signal usable → use it, apply MISSING_SIGNAL_DEGRADATION factor
 *     - Neither usable → default to capability with confidence 0
 *
 * @param {ClassificationSignal} llmSignal - LLM classification signal
 * @param {ClassificationSignal} webSearchSignal - Web search classification signal
 * @param {Object} [options={}]
 * @param {number} [options.agreementBonus=0.10]       - Override agreement bonus
 * @param {number} [options.disagreementPenalty=0.10]   - Override disagreement penalty
 * @param {number} [options.maxConfidence=0.98]         - Override max confidence cap
 * @param {number} [options.disagreementFloor=0.45]     - Override minimum after disagreement
 * @param {number} [options.llmWeight=0.45]             - Override LLM weight in disagreement
 * @param {number} [options.webSearchWeight=0.55]       - Override web search weight in disagreement
 * @param {number} [options.minVerified=0.70]           - Min confidence for verified flag
 * @returns {CombinedClassificationResult} Combined classification with confidence
 */
// any: options bag carries many tunable knobs (weights, floors, bonuses, ...)
export function combineSignals(llmSignal: VerificationSignal | null, webSearchSignal: VerificationSignal | null, options: any = {}): CombinedSignalResult {
  const params = {
    agreementBonus: options.agreementBonus ?? COMBINATION_PARAMS.AGREEMENT_BONUS,
    disagreementPenalty: options.disagreementPenalty ?? COMBINATION_PARAMS.DISAGREEMENT_PENALTY,
    maxConfidence: options.maxConfidence ?? COMBINATION_PARAMS.MAX_CONFIDENCE,
    disagreementFloor: options.disagreementFloor ?? COMBINATION_PARAMS.DISAGREEMENT_FLOOR,
    llmWeight: options.llmWeight ?? COMBINATION_PARAMS.LLM_WEIGHT,
    webSearchWeight: options.webSearchWeight ?? COMBINATION_PARAMS.WEB_SEARCH_WEIGHT,
    minVerified: options.minVerified ?? 0.70,
  };

  // Normalize inputs
  const llm = normalizeSignal(llmSignal, 'llm');
  const web = normalizeSignal(webSearchSignal, 'web-search');

  const llmUsable = isSignalUsable(llm);
  const webUsable = isSignalUsable(web);

  logDebug(TOOL,
    `Combining: LLM=${llm.classification}(${llm.confidence}, ${llm.status}), ` +
    `Web=${web.classification}(${web.confidence}, ${web.status}) → ` +
    `usable: llm=${llmUsable}, web=${webUsable}`);

  // ── Case 3: Partial / Missing ───────────────────────────────────────────
  if (!llmUsable && !webUsable) {
    // Neither signal is usable → default to capability with zero confidence
    logDebug(TOOL, 'Case: no-signal — defaulting to capability');
    return buildCombinedResult({
      classification: COMPONENT_TYPE.CAPABILITY,
      confidence: 0,
      method: 'none',
      reasoning: buildNoSignalReasoning(llm, web),
      mergeCase: 'no-signal',
      minVerified: params.minVerified,
      llm,
      web,
    });
  }

  if (!llmUsable || !webUsable) {
    // Only one signal is usable → use it with degradation factor
    const usable = llmUsable ? llm : web;
    const missing = llmUsable ? web : llm;

    const degradedConfidence = roundConfidence(
      usable.confidence * COMBINATION_PARAMS.MISSING_SIGNAL_DEGRADATION
    );

    logDebug(TOOL,
      `Case: single-signal (${usable.method}) → ` +
      `${usable.classification} conf=${degradedConfidence} (degraded from ${usable.confidence})`);

    return buildCombinedResult({
      classification: usable.classification,
      confidence: degradedConfidence,
      method: usable.method,
      reasoning: `${usable.reasoning} (${missing.method} ${missing.status || 'unavailable'})`,
      mergeCase: 'single-signal',
      minVerified: params.minVerified,
      llm,
      web,
    });
  }

  // ── Both signals are usable ──────────────────────────────────────────────

  // ── Case 1: Agreement ─────────────────────────────────────────────────────
  if (llm.classification === web.classification) {
    const boosted = roundConfidence(
      Math.min(
        params.maxConfidence,
        (llm.confidence + web.confidence) / 2 + params.agreementBonus
      )
    );

    logDebug(TOOL,
      `Case: agreement (${llm.classification}) → boosted conf=${boosted} ` +
      `(from avg=${((llm.confidence + web.confidence) / 2).toFixed(3)} + bonus=${params.agreementBonus})`);

    return buildCombinedResult({
      classification: llm.classification,
      confidence: boosted,
      method: 'llm+web-search',
      reasoning: buildAgreementReasoning(llm, web),
      mergeCase: 'agreement',
      minVerified: params.minVerified,
      llm,
      web,
    });
  }

  // ── Case 2: Disagreement ──────────────────────────────────────────────────
  //
  // When LLM and web search disagree, we apply weighted scoring to determine
  // the winner, then apply a confidence penalty for the conflict.
  //
  // Weighting: web search gets slightly more weight (0.55 vs 0.45) because
  // it's based on real-world evidence (product pages, Wikipedia, GitHub repos)
  // rather than parametric knowledge that may be stale.

  const llmWeighted = llm.confidence * params.llmWeight;
  const webWeighted = web.confidence * params.webSearchWeight;

  const winner = llmWeighted >= webWeighted ? llm : web;
  const loser = llmWeighted >= webWeighted ? web : llm;

  // Base penalty
  let penalty = params.disagreementPenalty;

  // Extra penalty when confidences are close (within 0.10) — higher ambiguity
  const confGap = Math.abs(llm.confidence - web.confidence);
  if (confGap < 0.10) {
    penalty += 0.05;
  }

  const penalizedConfidence = roundConfidence(
    Math.max(params.disagreementFloor, winner.confidence - penalty)
  );

  logDebug(TOOL,
    `Case: disagreement — LLM=${llm.classification}(${llm.confidence}), ` +
    `Web=${web.classification}(${web.confidence}) → ` +
    `winner=${winner.method}(weighted: llm=${llmWeighted.toFixed(3)}, web=${webWeighted.toFixed(3)}), ` +
    `conf=${penalizedConfidence} (penalty=${penalty})`);

  return buildCombinedResult({
    classification: winner.classification,
    confidence: penalizedConfidence,
    method: 'llm+web-search',
    reasoning: buildDisagreementReasoning(winner, loser, confGap),
    mergeCase: 'disagreement',
    minVerified: params.minVerified,
    llm,
    web,
  });
}

// ─── Three-way Combination (with Naming Signal) ─────────────────────────────

/**
 * Combine three signals: naming convention + LLM + web search.
 *
 * This is the full integration point for estimate-evolution.mjs when all
 * three detection tiers have run. The naming signal carries the Tier 1
 * result from solution-capability-router.mjs.
 *
 * Algorithm:
 *   1. First combine LLM + web search using combineSignals()
 *   2. Then reconcile the combined result with the naming signal
 *      using a two-stage combination that preserves agreement/disagreement logic
 *
 * @param {ClassificationSignal} namingSignal     - Naming convention signal (Tier 1)
 * @param {ClassificationSignal} llmSignal        - LLM classification signal (Tier 2)
 * @param {ClassificationSignal} webSearchSignal  - Web search signal (Tier 3)
 * @param {Object} [options={}]                   - Same options as combineSignals
 * @returns {CombinedClassificationResult} Combined classification from all three signals
 */
// any: options bag carries many tunable knobs (weights, floors, bonuses, ...)
export function combineAllSignals(namingSignal: VerificationSignal | null, llmSignal: VerificationSignal | null, webSearchSignal: VerificationSignal | null, options: any = {}): CombinedSignalResult {
  const params = {
    agreementBonus: options.agreementBonus ?? COMBINATION_PARAMS.AGREEMENT_BONUS,
    maxConfidence: options.maxConfidence ?? COMBINATION_PARAMS.MAX_CONFIDENCE,
    disagreementPenalty: options.disagreementPenalty ?? COMBINATION_PARAMS.DISAGREEMENT_PENALTY,
    disagreementFloor: options.disagreementFloor ?? COMBINATION_PARAMS.DISAGREEMENT_FLOOR,
    minVerified: options.minVerified ?? 0.70,
  };

  // Step 1: Combine LLM + web search
  const dualResult = combineSignals(llmSignal, webSearchSignal, options);

  // Step 2: Normalize naming signal
  const naming = normalizeSignal(namingSignal, 'naming');
  const namingUsable = isSignalUsable(naming);

  if (!namingUsable) {
    // No usable naming signal — return the dual result directly
    return dualResult;
  }

  if (dualResult.mergeCase === 'no-signal') {
    // Dual verification produced nothing — return naming with degradation
    const degradedConfidence = roundConfidence(
      naming.confidence * COMBINATION_PARAMS.MISSING_SIGNAL_DEGRADATION
    );
    return buildCombinedResult({
      classification: naming.classification,
      confidence: degradedConfidence,
      method: 'naming',
      reasoning: `${naming.reasoning} (dual verification unavailable)`,
      mergeCase: 'single-signal',
      minVerified: params.minVerified,
      llm: normalizeSignal(llmSignal, 'llm'),
      web: normalizeSignal(webSearchSignal, 'web-search'),
    });
  }

  // Step 3: Reconcile naming with the dual result
  if (naming.classification === dualResult.classification) {
    // Triple agreement (or naming agrees with dual winner) → strong boost
    const boosted = roundConfidence(
      Math.min(
        params.maxConfidence,
        (naming.confidence + dualResult.confidence) / 2 + params.agreementBonus
      )
    );

    return buildCombinedResult({
      classification: dualResult.classification,
      confidence: boosted,
      method: `naming+${dualResult.method}`,
      reasoning: `${dualResult.reasoning} (naming agrees: ${naming.reasoning})`,
      mergeCase: dualResult.mergeCase === 'agreement' ? 'agreement' : dualResult.mergeCase,
      minVerified: params.minVerified,
      llm: normalizeSignal(llmSignal, 'llm'),
      web: normalizeSignal(webSearchSignal, 'web-search'),
    });
  }

  // Naming disagrees with dual result → trust dual (it's multi-signal) but penalize
  const penalized = roundConfidence(
    Math.max(params.disagreementFloor, dualResult.confidence - params.disagreementPenalty)
  );

  return buildCombinedResult({
    classification: dualResult.classification,
    confidence: penalized,
    method: `naming+${dualResult.method}`,
    reasoning: `Dual verification (${dualResult.method}) overrides naming: ${dualResult.reasoning} (naming said: ${naming.classification})`,
    mergeCase: 'disagreement',
    minVerified: params.minVerified,
    llm: normalizeSignal(llmSignal, 'llm'),
    web: normalizeSignal(webSearchSignal, 'web-search'),
  });
}

// ─── Reasoning Builders ──────────────────────────────────────────────────────

/**
 * Build reasoning string for the no-signal case.
 * @param {ClassificationSignal} llm
 * @param {ClassificationSignal} web
 * @returns {string}
 */
function buildNoSignalReasoning(llm: VerificationSignal, web: VerificationSignal): string {
  const parts = [];
  if (llm.status && llm.status !== SIGNAL_STATUS.SKIPPED as 'skipped') {
    parts.push(`LLM: ${llm.reasoning || llm.status}`);
  }
  if (web.status && web.status !== SIGNAL_STATUS.SKIPPED as 'skipped') {
    parts.push(`Web search: ${web.reasoning || web.status}`);
  }
  if (parts.length === 0) {
    return 'Both verification signals were skipped or unavailable';
  }
  return `Both verification signals failed: ${parts.join('; ')}`;
}

/**
 * Build reasoning string for the agreement case.
 * @param {ClassificationSignal} llm
 * @param {ClassificationSignal} web
 * @returns {string}
 */
function buildAgreementReasoning(llm: VerificationSignal, web: VerificationSignal): string {
  const primary = web.confidence >= llm.confidence ? web : llm;
  const secondary = web.confidence >= llm.confidence ? llm : web;
  return `${primary.reasoning || primary.method} (${secondary.method} agrees: ${secondary.reasoning || secondary.classification})`;
}

/**
 * Build reasoning string for the disagreement case.
 * @param {ClassificationSignal} winner
 * @param {ClassificationSignal} loser
 * @param {number} confGap
 * @returns {string}
 */
function buildDisagreementReasoning(winner: VerificationSignal, loser: VerificationSignal, confGap: number): string {
  const ambiguityNote = confGap < 0.10
    ? ' — signals are close in confidence, classification is ambiguous'
    : '';
  return `${winner.method} overrides ${loser.method}: ${winner.reasoning || winner.classification} ` +
    `(${loser.method} said: ${loser.classification}${loser.reasoning ? `, ${loser.reasoning}` : ''})${ambiguityNote}`;
}

// ─── Result Builder ──────────────────────────────────────────────────────────

/**
 * Build a CombinedClassificationResult.
 *
 * @param {Object} params
 * @returns {CombinedClassificationResult}
 */
function buildCombinedResult(params: { classification: string | null; confidence: number; method: string; reasoning: string; [key: string]: unknown }): CombinedSignalResult {
  const { classification, confidence, method, reasoning, mergeCase, minVerified, llm, web } = params;

  return {
    classification,
    confidence,
    method,
    reasoning,
    mergeCase,
    verified: confidence >= (minVerified as number),
    isSolution: classification === COMPONENT_TYPE.SOLUTION,
    signals: {
      llm: llm || null,
      webSearch: web || null,
    },
  };
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Round a confidence value to 2 decimal places.
 * @param {number} value
 * @returns {number}
 */
function roundConfidence(value: number): number {
  return Math.round(value * 100) / 100;
}
