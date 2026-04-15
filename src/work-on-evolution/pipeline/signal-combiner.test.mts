// Tests for signal-combiner.mjs
//
// Validates Sub-AC 1: Signal combination function that takes LLM classification
// signal and web search signal as inputs, handles three merge cases, and returns
// a final solution-or-capability determination with combined confidence score.
//
// Test categories:
//   1. Agreement — both signals agree → boosted confidence
//   2. Disagreement — signals disagree → fallback/weighting logic
//   3. Partial/missing — one or both signals absent → graceful degradation
//   4. Edge cases — null inputs, invalid signals, boundary values
//   5. combineAllSignals — three-way combination (naming + LLM + web)
//   6. isSignalUsable — signal validation
//   7. Result shape — all required fields present
//   8. Parameterization — custom options override defaults

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  combineSignals,
  combineAllSignals,
  isSignalUsable,
  COMPONENT_TYPE,
  COMBINATION_PARAMS,
  SIGNAL_STATUS,
} from './signal-combiner.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a successful LLM signal */
function llmSignal(classification, confidence, reasoning = '') {
  return {
    classification,
    confidence,
    method: 'llm',
    reasoning: reasoning || `LLM says ${classification}`,
    status: 'success',
  };
}

/** Create a successful web search signal */
function webSignal(classification, confidence, reasoning = '') {
  return {
    classification,
    confidence,
    method: 'web-search',
    reasoning: reasoning || `Web search says ${classification}`,
    status: 'success',
  };
}

/** Create a naming signal */
function namingSignal(classification, confidence, reasoning = '') {
  return {
    classification,
    confidence,
    method: 'naming',
    reasoning: reasoning || `Naming convention says ${classification}`,
    status: 'success',
  };
}

/** Create a failed/timed-out signal */
function failedSignal(method, status, error = '') {
  return {
    classification: null,
    confidence: 0,
    method,
    reasoning: error || `${method} ${status}`,
    status,
    ...(error && { error }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Agreement Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('combineSignals — agreement', () => {
  it('boosts confidence when both say solution', () => {
    const result = combineSignals(
      llmSignal('solution', 0.85),
      webSignal('solution', 0.90)
    );

    assert.equal(result.classification, 'solution');
    assert.equal(result.mergeCase, 'agreement');
    assert.equal(result.isSolution, true);
    // avg(0.85, 0.90) + 0.10 = 0.975 → capped at 0.98
    assert.ok(result.confidence >= 0.90, `Confidence ${result.confidence} should be >= 0.90`);
    assert.ok(result.confidence <= 0.98, `Confidence ${result.confidence} should be <= 0.98`);
  });

  it('boosts confidence when both say capability', () => {
    const result = combineSignals(
      llmSignal('capability', 0.80),
      webSignal('capability', 0.75)
    );

    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'agreement');
    assert.equal(result.isSolution, false);
    // avg(0.80, 0.75) + 0.10 = 0.875
    assert.equal(result.confidence, 0.88);
  });

  it('caps boosted confidence at MAX_CONFIDENCE (0.98)', () => {
    const result = combineSignals(
      llmSignal('solution', 0.95),
      webSignal('solution', 0.97)
    );

    assert.equal(result.classification, 'solution');
    assert.equal(result.mergeCase, 'agreement');
    // avg(0.95, 0.97) + 0.10 = 1.06 → capped at 0.98
    assert.equal(result.confidence, 0.98);
  });

  it('agreement with low confidences still boosts', () => {
    const result = combineSignals(
      llmSignal('capability', 0.30),
      webSignal('capability', 0.25)
    );

    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'agreement');
    // avg(0.30, 0.25) + 0.10 = 0.375
    assert.equal(result.confidence, 0.38);
  });

  it('method is llm+web-search on agreement', () => {
    const result = combineSignals(
      llmSignal('solution', 0.80),
      webSignal('solution', 0.80)
    );
    assert.equal(result.method, 'llm+web-search');
  });

  it('reasoning includes both signal contributions', () => {
    const result = combineSignals(
      llmSignal('solution', 0.80, 'Kubernetes is a product'),
      webSignal('solution', 0.85, 'Has official product page')
    );

    assert.ok(result.reasoning.includes('agrees'), 'Reasoning should mention agreement');
    assert.ok(
      result.reasoning.includes('product page') || result.reasoning.includes('Kubernetes'),
      'Reasoning should include signal details'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Disagreement Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('combineSignals — disagreement', () => {
  it('trusts web search when it has higher weighted confidence', () => {
    const result = combineSignals(
      llmSignal('solution', 0.70),
      webSignal('capability', 0.85)
    );

    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'disagreement');
    // Web weighted: 0.85 * 0.55 = 0.4675 > LLM weighted: 0.70 * 0.45 = 0.315
    // Penalized: 0.85 - 0.10 = 0.75
    assert.equal(result.confidence, 0.75);
  });

  it('trusts LLM when it has higher weighted confidence', () => {
    const result = combineSignals(
      llmSignal('solution', 0.95),
      webSignal('capability', 0.60)
    );

    assert.equal(result.classification, 'solution');
    assert.equal(result.mergeCase, 'disagreement');
    // LLM weighted: 0.95 * 0.45 = 0.4275 > Web weighted: 0.60 * 0.55 = 0.33
    // Penalized: 0.95 - 0.10 = 0.85
    assert.equal(result.confidence, 0.85);
  });

  it('applies extra penalty when confidences are close (< 0.10 gap)', () => {
    const result = combineSignals(
      llmSignal('solution', 0.75),
      webSignal('capability', 0.72)
    );

    assert.equal(result.mergeCase, 'disagreement');
    // Gap = |0.75 - 0.72| = 0.03 < 0.10 → extra 0.05 penalty
    // Winner (web-search, weighted 0.72 * 0.55 = 0.396 > 0.75 * 0.45 = 0.3375)
    // Penalized: 0.72 - 0.15 = 0.57
    assert.equal(result.confidence, 0.57);
    assert.ok(result.reasoning.includes('ambiguous'), 'Should note ambiguity');
  });

  it('does NOT apply extra penalty when confidences are far apart', () => {
    const result = combineSignals(
      llmSignal('solution', 0.90),
      webSignal('capability', 0.50)
    );

    assert.equal(result.mergeCase, 'disagreement');
    // Gap = 0.40 > 0.10 → no extra penalty
    // LLM weighted: 0.90 * 0.45 = 0.405 > Web weighted: 0.50 * 0.55 = 0.275
    // Penalized: 0.90 - 0.10 = 0.80 (standard penalty only)
    assert.equal(result.confidence, 0.80);
    assert.ok(!result.reasoning.includes('ambiguous'), 'Should NOT note ambiguity');
  });

  it('confidence never goes below DISAGREEMENT_FLOOR', () => {
    const result = combineSignals(
      llmSignal('solution', 0.50),
      webSignal('capability', 0.48)
    );

    assert.equal(result.mergeCase, 'disagreement');
    // Gap = 0.02 < 0.10 → penalty = 0.10 + 0.05 = 0.15
    // Winner conf - 0.15 = 0.48 - 0.15 = 0.33 → clamped to 0.45
    assert.ok(result.confidence >= COMBINATION_PARAMS.DISAGREEMENT_FLOOR,
      `Confidence ${result.confidence} should be >= ${COMBINATION_PARAMS.DISAGREEMENT_FLOOR}`);
  });

  it('method is llm+web-search on disagreement', () => {
    const result = combineSignals(
      llmSignal('solution', 0.80),
      webSignal('capability', 0.80)
    );
    assert.equal(result.method, 'llm+web-search');
  });

  it('reasoning explains override', () => {
    const result = combineSignals(
      llmSignal('solution', 0.70, 'Looks like a product'),
      webSignal('capability', 0.85, 'No product page found')
    );

    assert.ok(result.reasoning.includes('overrides'), 'Reasoning should mention override');
    assert.ok(result.reasoning.includes('solution'), 'Reasoning should mention losing classification');
  });

  it('web search weight advantage: web wins when both have same raw confidence', () => {
    // When both have same confidence, web search wins due to higher weight (0.55 vs 0.45)
    const result = combineSignals(
      llmSignal('solution', 0.80),
      webSignal('capability', 0.80)
    );

    assert.equal(result.classification, 'capability',
      'Web search should win when raw confidences are equal (higher weight)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Partial / Missing Signals
// ═══════════════════════════════════════════════════════════════════════════════

describe('combineSignals — partial/missing signals', () => {
  it('uses LLM signal when web search is null', () => {
    const result = combineSignals(
      llmSignal('solution', 0.80),
      null
    );

    assert.equal(result.classification, 'solution');
    assert.equal(result.mergeCase, 'single-signal');
    assert.equal(result.method, 'llm');
    // Degraded: 0.80 * 0.85 = 0.68
    assert.equal(result.confidence, 0.68);
  });

  it('uses web search signal when LLM is null', () => {
    const result = combineSignals(
      null,
      webSignal('capability', 0.90)
    );

    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'single-signal');
    assert.equal(result.method, 'web-search');
    // Degraded: 0.90 * 0.85 = 0.765 → 0.77
    assert.equal(result.confidence, 0.77);
  });

  it('uses LLM signal when web search timed out', () => {
    const result = combineSignals(
      llmSignal('solution', 0.85),
      failedSignal('web-search', 'timeout', 'Timeout after 15000ms')
    );

    assert.equal(result.classification, 'solution');
    assert.equal(result.mergeCase, 'single-signal');
    assert.ok(result.reasoning.includes('timeout'), 'Should mention timeout');
  });

  it('uses web search signal when LLM errored', () => {
    const result = combineSignals(
      failedSignal('llm', 'error', 'API rate limit'),
      webSignal('capability', 0.75)
    );

    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'single-signal');
    assert.ok(result.reasoning.includes('error'), 'Should mention error');
  });

  it('uses LLM signal when web search was skipped', () => {
    const result = combineSignals(
      llmSignal('solution', 0.70),
      failedSignal('web-search', 'skipped', 'No web search backend')
    );

    assert.equal(result.classification, 'solution');
    assert.equal(result.mergeCase, 'single-signal');
  });

  it('defaults to capability when both signals are null', () => {
    const result = combineSignals(null, null);

    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'no-signal');
    assert.equal(result.confidence, 0);
    assert.equal(result.verified, false);
  });

  it('defaults to capability when both signals timed out', () => {
    const result = combineSignals(
      failedSignal('llm', 'timeout', 'Timeout'),
      failedSignal('web-search', 'timeout', 'Timeout')
    );

    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'no-signal');
    assert.equal(result.confidence, 0);
  });

  it('defaults to capability when both signals errored', () => {
    const result = combineSignals(
      failedSignal('llm', 'error', 'API down'),
      failedSignal('web-search', 'error', 'Network error')
    );

    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'no-signal');
    assert.equal(result.confidence, 0);
    assert.ok(result.reasoning.includes('failed'), 'Should explain both failed');
  });

  it('degradation factor reduces single-signal confidence', () => {
    const result = combineSignals(
      llmSignal('solution', 1.0),
      null
    );

    assert.ok(result.confidence < 1.0, 'Should be degraded from 1.0');
    assert.equal(result.confidence, 0.85); // 1.0 * 0.85
  });

  it('handles signal with very low confidence as unusable', () => {
    // Confidence below MIN_SIGNAL_CONFIDENCE (0.10)
    const result = combineSignals(
      { classification: 'solution', confidence: 0.05, method: 'llm', status: 'success' },
      webSignal('capability', 0.80)
    );

    // LLM confidence 0.05 < 0.10 threshold → treated as unusable
    assert.equal(result.mergeCase, 'single-signal');
    assert.equal(result.classification, 'capability');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('combineSignals — edge cases', () => {
  it('handles undefined inputs', () => {
    const result = combineSignals(undefined, undefined);
    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'no-signal');
    assert.equal(result.confidence, 0);
  });

  it('handles empty object signals', () => {
    const result = combineSignals({}, {});
    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'no-signal');
    assert.equal(result.confidence, 0);
  });

  it('handles signal with NaN confidence', () => {
    const result = combineSignals(
      { classification: 'solution', confidence: NaN, method: 'llm', status: 'success' },
      webSignal('capability', 0.80)
    );

    assert.equal(result.mergeCase, 'single-signal');
    assert.equal(result.classification, 'capability');
  });

  it('handles signal with negative confidence', () => {
    const result = combineSignals(
      { classification: 'solution', confidence: -0.5, method: 'llm', status: 'success' },
      webSignal('solution', 0.80)
    );

    assert.equal(result.mergeCase, 'single-signal');
    assert.equal(result.classification, 'solution');
  });

  it('handles signal with invalid classification type', () => {
    const result = combineSignals(
      { classification: 'unknown_type', confidence: 0.80, method: 'llm', status: 'success' },
      webSignal('solution', 0.80)
    );

    // 'unknown_type' is not 'solution' or 'capability' → treated as unusable
    assert.equal(result.mergeCase, 'single-signal');
    assert.equal(result.classification, 'solution');
  });

  it('preserves signals in result for traceability', () => {
    const llm = llmSignal('solution', 0.80);
    const web = webSignal('solution', 0.85);
    const result = combineSignals(llm, web);

    assert.ok(result.signals, 'Should have signals object');
    assert.ok(result.signals.llm, 'Should have llm signal');
    assert.ok(result.signals.webSearch, 'Should have webSearch signal');
    assert.equal(result.signals.llm.method, 'llm');
    assert.equal(result.signals.webSearch.method, 'web-search');
  });

  it('handles signals without status field (backward compat)', () => {
    // Signals without explicit 'status' field should work if they have classification
    const result = combineSignals(
      { classification: 'solution', confidence: 0.80, method: 'llm' },
      { classification: 'solution', confidence: 0.85, method: 'web-search' }
    );

    assert.equal(result.classification, 'solution');
    assert.equal(result.mergeCase, 'agreement');
  });

  it('isSolution matches classification', () => {
    const solutionResult = combineSignals(
      llmSignal('solution', 0.80),
      webSignal('solution', 0.85)
    );
    assert.equal(solutionResult.isSolution, true);

    const capabilityResult = combineSignals(
      llmSignal('capability', 0.80),
      webSignal('capability', 0.85)
    );
    assert.equal(capabilityResult.isSolution, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. combineAllSignals — Three-Way Combination
// ═══════════════════════════════════════════════════════════════════════════════

describe('combineAllSignals — three-way combination', () => {
  it('triple agreement produces high confidence', () => {
    const result = combineAllSignals(
      namingSignal('solution', 0.85),
      llmSignal('solution', 0.80),
      webSignal('solution', 0.90)
    );

    assert.equal(result.classification, 'solution');
    assert.ok(result.confidence >= 0.90, `Expected high confidence, got ${result.confidence}`);
    assert.ok(result.method.includes('naming'), 'Method should include naming');
  });

  it('dual signals override naming when naming disagrees', () => {
    const result = combineAllSignals(
      namingSignal('capability', 0.70),
      llmSignal('solution', 0.85),
      webSignal('solution', 0.80)
    );

    assert.equal(result.classification, 'solution',
      'Dual agreement should override naming');
  });

  it('naming alone when dual verification fails', () => {
    const result = combineAllSignals(
      namingSignal('solution', 0.88),
      failedSignal('llm', 'error', 'API down'),
      failedSignal('web-search', 'timeout', 'Timeout')
    );

    assert.equal(result.classification, 'solution');
    assert.equal(result.mergeCase, 'single-signal');
    // Degraded: 0.88 * 0.85 = 0.748 → 0.75
    assert.ok(result.confidence < 0.88, 'Should be degraded');
  });

  it('returns dual result when naming is null', () => {
    const result = combineAllSignals(
      null,
      llmSignal('capability', 0.80),
      webSignal('capability', 0.75)
    );

    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'agreement');
  });

  it('handles all three signals null', () => {
    const result = combineAllSignals(null, null, null);
    assert.equal(result.classification, 'capability');
    assert.equal(result.confidence, 0);
  });

  it('naming + single dual signal', () => {
    const result = combineAllSignals(
      namingSignal('solution', 0.75),
      llmSignal('solution', 0.80),
      failedSignal('web-search', 'skipped', 'No backend')
    );

    assert.equal(result.classification, 'solution');
    // naming agrees with the single-signal dual result → boosted
    assert.ok(result.confidence > 0.68, 'Should boost naming+single signal agreement');
  });

  it('naming disagrees with dual disagreement winner', () => {
    // LLM says solution, web says capability, naming says capability
    // Dual winner = depends on weights
    const result = combineAllSignals(
      namingSignal('capability', 0.70),
      llmSignal('solution', 0.75),
      webSignal('capability', 0.80)
    );

    assert.equal(result.classification, 'capability',
      'Naming + web should reinforce capability');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. isSignalUsable
// ═══════════════════════════════════════════════════════════════════════════════

describe('isSignalUsable', () => {
  it('returns true for valid success signal', () => {
    assert.ok(isSignalUsable(llmSignal('solution', 0.80)));
    assert.ok(isSignalUsable(webSignal('capability', 0.50)));
  });

  it('returns true for signal without status field', () => {
    assert.ok(isSignalUsable({ classification: 'solution', confidence: 0.80, method: 'llm' }));
  });

  it('returns false for null', () => {
    assert.equal(isSignalUsable(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isSignalUsable(undefined), false);
  });

  it('returns false for empty object', () => {
    assert.equal(isSignalUsable({}), false);
  });

  it('returns false for timed-out signal', () => {
    assert.equal(isSignalUsable(failedSignal('llm', 'timeout')), false);
  });

  it('returns false for errored signal', () => {
    assert.equal(isSignalUsable(failedSignal('llm', 'error')), false);
  });

  it('returns false for skipped signal', () => {
    assert.equal(isSignalUsable(failedSignal('llm', 'skipped')), false);
  });

  it('returns false for null classification', () => {
    assert.equal(isSignalUsable({ classification: null, confidence: 0.80, status: 'success' }), false);
  });

  it('returns false for invalid classification type', () => {
    assert.equal(isSignalUsable({ classification: 'other', confidence: 0.80, status: 'success' }), false);
  });

  it('returns false for NaN confidence', () => {
    assert.equal(isSignalUsable({ classification: 'solution', confidence: NaN, status: 'success' }), false);
  });

  it('returns false for below-threshold confidence', () => {
    assert.equal(
      isSignalUsable({ classification: 'solution', confidence: 0.05, status: 'success' }),
      false,
      `Confidence below ${COMBINATION_PARAMS.MIN_SIGNAL_CONFIDENCE} should be unusable`
    );
  });

  it('returns true for exactly MIN_SIGNAL_CONFIDENCE', () => {
    assert.ok(isSignalUsable({
      classification: 'solution',
      confidence: COMBINATION_PARAMS.MIN_SIGNAL_CONFIDENCE,
      status: 'success',
    }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Result Shape
// ═══════════════════════════════════════════════════════════════════════════════

describe('combineSignals — result shape', () => {
  it('returns all required fields for agreement', () => {
    const result = combineSignals(
      llmSignal('solution', 0.80),
      webSignal('solution', 0.85)
    );

    assert.equal(typeof result.classification, 'string');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.method, 'string');
    assert.equal(typeof result.reasoning, 'string');
    assert.equal(typeof result.mergeCase, 'string');
    assert.equal(typeof result.verified, 'boolean');
    assert.equal(typeof result.isSolution, 'boolean');
    assert.ok(result.signals, 'signals object required');
    assert.ok(result.signals.llm !== undefined, 'llm signal required');
    assert.ok(result.signals.webSearch !== undefined, 'webSearch signal required');
  });

  it('returns all required fields for disagreement', () => {
    const result = combineSignals(
      llmSignal('solution', 0.80),
      webSignal('capability', 0.85)
    );

    assert.equal(typeof result.classification, 'string');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.mergeCase, 'string');
    assert.equal(result.mergeCase, 'disagreement');
  });

  it('returns all required fields for single-signal', () => {
    const result = combineSignals(
      llmSignal('solution', 0.80),
      null
    );

    assert.equal(typeof result.classification, 'string');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(result.mergeCase, 'single-signal');
  });

  it('returns all required fields for no-signal', () => {
    const result = combineSignals(null, null);

    assert.equal(typeof result.classification, 'string');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(result.mergeCase, 'no-signal');
    assert.equal(result.verified, false);
  });

  it('mergeCase is one of the four valid values', () => {
    const validCases = ['agreement', 'disagreement', 'single-signal', 'no-signal'];

    const r1 = combineSignals(llmSignal('solution', 0.80), webSignal('solution', 0.85));
    assert.ok(validCases.includes(r1.mergeCase), `${r1.mergeCase} not in valid cases`);

    const r2 = combineSignals(llmSignal('solution', 0.80), webSignal('capability', 0.85));
    assert.ok(validCases.includes(r2.mergeCase), `${r2.mergeCase} not in valid cases`);

    const r3 = combineSignals(llmSignal('solution', 0.80), null);
    assert.ok(validCases.includes(r3.mergeCase), `${r3.mergeCase} not in valid cases`);

    const r4 = combineSignals(null, null);
    assert.ok(validCases.includes(r4.mergeCase), `${r4.mergeCase} not in valid cases`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Parameterization — Custom Options
// ═══════════════════════════════════════════════════════════════════════════════

describe('combineSignals — custom options', () => {
  it('custom agreement bonus', () => {
    const result = combineSignals(
      llmSignal('solution', 0.70),
      webSignal('solution', 0.70),
      { agreementBonus: 0.20 }
    );

    // avg(0.70, 0.70) + 0.20 = 0.90
    assert.equal(result.confidence, 0.90);
  });

  it('custom disagreement penalty', () => {
    const result = combineSignals(
      llmSignal('solution', 0.90),
      webSignal('capability', 0.60),
      { disagreementPenalty: 0.20 }
    );

    // Winner (LLM): 0.90 - 0.20 = 0.70
    assert.equal(result.confidence, 0.70);
  });

  it('custom max confidence cap', () => {
    const result = combineSignals(
      llmSignal('solution', 0.95),
      webSignal('solution', 0.95),
      { maxConfidence: 0.90 }
    );

    assert.ok(result.confidence <= 0.90, `Expected max 0.90, got ${result.confidence}`);
  });

  it('custom disagreement floor', () => {
    const result = combineSignals(
      llmSignal('solution', 0.30),
      webSignal('capability', 0.25),
      { disagreementFloor: 0.20 }
    );

    // With custom floor of 0.20, can go lower than default 0.45
    assert.ok(result.confidence >= 0.20, `Expected >= 0.20, got ${result.confidence}`);
  });

  it('custom min verified threshold', () => {
    const lowThreshold = combineSignals(
      llmSignal('solution', 0.60),
      webSignal('solution', 0.50),
      { minVerified: 0.50 }
    );
    assert.equal(lowThreshold.verified, true, 'Should be verified with low threshold');

    const highThreshold = combineSignals(
      llmSignal('solution', 0.60),
      webSignal('solution', 0.50),
      { minVerified: 0.90 }
    );
    assert.equal(highThreshold.verified, false, 'Should NOT be verified with high threshold');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Verified Flag
// ═══════════════════════════════════════════════════════════════════════════════

describe('combineSignals — verified flag', () => {
  it('verified is true when confidence >= 0.70', () => {
    const result = combineSignals(
      llmSignal('solution', 0.80),
      webSignal('solution', 0.85)
    );
    assert.equal(result.verified, true);
  });

  it('verified is false when confidence < 0.70', () => {
    const result = combineSignals(
      llmSignal('solution', 0.40),
      webSignal('capability', 0.35)
    );
    assert.equal(result.verified, false);
  });

  it('verified is false for no-signal case', () => {
    const result = combineSignals(null, null);
    assert.equal(result.verified, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Constants Exported
// ═══════════════════════════════════════════════════════════════════════════════

describe('exported constants', () => {
  it('COMPONENT_TYPE has solution and capability', () => {
    assert.equal(COMPONENT_TYPE.SOLUTION, 'solution');
    assert.equal(COMPONENT_TYPE.CAPABILITY, 'capability');
  });

  it('COMBINATION_PARAMS has expected defaults', () => {
    assert.equal(COMBINATION_PARAMS.AGREEMENT_BONUS, 0.10);
    assert.equal(COMBINATION_PARAMS.MAX_CONFIDENCE, 0.98);
    assert.equal(COMBINATION_PARAMS.DISAGREEMENT_PENALTY, 0.10);
    assert.equal(COMBINATION_PARAMS.DISAGREEMENT_FLOOR, 0.45);
    assert.equal(COMBINATION_PARAMS.LLM_WEIGHT, 0.45);
    assert.equal(COMBINATION_PARAMS.WEB_SEARCH_WEIGHT, 0.55);
    assert.equal(COMBINATION_PARAMS.MIN_SIGNAL_CONFIDENCE, 0.10);
    assert.equal(COMBINATION_PARAMS.MISSING_SIGNAL_DEGRADATION, 0.85);
  });

  it('LLM_WEIGHT + WEB_SEARCH_WEIGHT = 1.0', () => {
    assert.equal(
      COMBINATION_PARAMS.LLM_WEIGHT + COMBINATION_PARAMS.WEB_SEARCH_WEIGHT,
      1.0,
      'Weights should sum to 1.0'
    );
  });

  it('SIGNAL_STATUS has expected values', () => {
    assert.equal(SIGNAL_STATUS.SUCCESS, 'success');
    assert.equal(SIGNAL_STATUS.TIMEOUT, 'timeout');
    assert.equal(SIGNAL_STATUS.ERROR, 'error');
    assert.equal(SIGNAL_STATUS.SKIPPED, 'skipped');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Real-World Scenarios
// ═══════════════════════════════════════════════════════════════════════════════

describe('real-world scenarios', () => {
  it('Kubernetes — both signals agree it is a solution', () => {
    const result = combineSignals(
      llmSignal('solution', 0.92, 'Kubernetes is a specific CNCF container orchestration platform'),
      webSignal('solution', 0.94, 'Has product page kubernetes.io and GitHub repo')
    );

    assert.equal(result.classification, 'solution');
    assert.equal(result.mergeCase, 'agreement');
    assert.ok(result.confidence >= 0.90, 'Should have high confidence for clear solution');
    assert.equal(result.verified, true);
  });

  it('container orchestration — both signals agree it is a capability', () => {
    const result = combineSignals(
      llmSignal('capability', 0.88, 'Abstract concept with multiple implementations'),
      webSignal('capability', 0.85, 'Wikipedia describes it as a computing concept')
    );

    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'agreement');
    assert.ok(result.confidence >= 0.85, 'Should have high confidence for clear capability');
  });

  it('ambiguous name — signals disagree, web search has evidence', () => {
    // "React" could be a solution (React.js) or a capability (chemical reaction)
    const result = combineSignals(
      llmSignal('capability', 0.55, 'Could be a generic term'),
      webSignal('solution', 0.80, 'React.js has product page, npm package, GitHub repo')
    );

    assert.equal(result.classification, 'solution',
      'Web search with product evidence should win');
    assert.equal(result.mergeCase, 'disagreement');
  });

  it('LLM unavailable — web search alone classifies', () => {
    const result = combineSignals(
      failedSignal('llm', 'error', 'Rate limited'),
      webSignal('solution', 0.88, 'Salesforce has product page salesforce.com')
    );

    assert.equal(result.classification, 'solution');
    assert.equal(result.mergeCase, 'single-signal');
    assert.ok(result.confidence < 0.88, 'Should be degraded from web confidence');
  });

  it('both backends down — graceful degradation to capability', () => {
    const result = combineSignals(
      failedSignal('llm', 'timeout', 'Timeout after 15s'),
      failedSignal('web-search', 'error', 'Network unreachable')
    );

    assert.equal(result.classification, 'capability');
    assert.equal(result.mergeCase, 'no-signal');
    assert.equal(result.confidence, 0);
    assert.equal(result.verified, false);
  });
});
