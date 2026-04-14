// Component Type Detection
//
// Detects whether a Wardley Map component is a SOLUTION (named product,
// framework, methodology, standard) or a CAPABILITY (abstract activity,
// practice, data type, knowledge area).
//
// Detection priority:
//   1. Known solutions dictionary (exact match → 0.98 confidence)
//   2. Known capabilities dictionary (exact match → 0.97 confidence)
//   3. Naming convention heuristics (max 0.89 confidence)
//
// Extracted from solution-capability-router.mjs for single-responsibility.

import {
  KNOWN_SOLUTIONS,
  KNOWN_CAPABILITIES,
  SOLUTION_PATTERNS,
  CAPABILITY_PATTERNS,
  COMMON_ENGLISH_WORDS,
} from './known-dictionaries.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Detection result types */
export const COMPONENT_TYPE = {
  SOLUTION: 'solution',
  CAPABILITY: 'capability',
};

/** Confidence threshold: below this, the caller should invoke LLM fallback */
export const CONFIDENCE_THRESHOLD = 0.90;

// ─── Detection Functions ──────────────────────────────────────────────────────

/**
 * Normalize a component name for dictionary lookup.
 * @param {string} name - Raw component name
 * @returns {string} Normalized name (lowercase, trimmed, collapsed whitespace)
 */
export function normalizeName(name) {
  return (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Check if a word is a common English word (not a brand).
 * @param {string} name - Normalized component name
 * @returns {boolean}
 */
export function isCommonWord(name) {
  return COMMON_ENGLISH_WORDS.has(name.toLowerCase());
}

/**
 * Detect whether a component name is a known solution.
 *
 * @param {string} name - Component name
 * @returns {{ match: boolean, confidence: number, canonical?: string, vendor?: string, category?: string, reason: string }}
 */
export function matchKnownSolution(name) {
  const normalized = normalizeName(name);
  const entry = KNOWN_SOLUTIONS.get(normalized);

  if (entry) {
    return {
      match: true,
      confidence: 0.98,
      canonical: entry.canonical,
      vendor: entry.vendor,
      category: entry.category,
      reason: `exact match in known solutions dictionary: "${entry.canonical}"`,
    };
  }

  // Try partial matching: check if the normalized name starts with or contains a known solution
  for (const [key, entry] of KNOWN_SOLUTIONS) {
    if (normalized.startsWith(key + ' ') || normalized.endsWith(' ' + key)) {
      return {
        match: true,
        confidence: 0.92,
        canonical: entry.canonical,
        vendor: entry.vendor,
        category: entry.category,
        reason: `partial match in known solutions dictionary: "${entry.canonical}" within "${name}"`,
      };
    }
  }

  return { match: false, confidence: 0, reason: 'no match in known solutions dictionary' };
}

/**
 * Detect whether a component name is a known capability.
 *
 * @param {string} name - Component name
 * @returns {{ match: boolean, confidence: number, canonical?: string, nature?: string, reason: string }}
 */
export function matchKnownCapability(name) {
  const normalized = normalizeName(name);
  const entry = KNOWN_CAPABILITIES.get(normalized);

  if (entry) {
    return {
      match: true,
      confidence: 0.97,
      canonical: entry.canonical,
      nature: entry.nature,
      reason: `exact match in known capabilities dictionary: "${entry.canonical}"`,
    };
  }

  // Check if the name contains a known capability phrase
  for (const [key, entry] of KNOWN_CAPABILITIES) {
    // Only match multi-word keys as substrings (avoid "bi" matching inside "mobile")
    if (key.length > 3 && normalized.includes(key)) {
      return {
        match: true,
        confidence: 0.88,
        canonical: entry.canonical,
        nature: entry.nature,
        reason: `substring match in known capabilities: "${entry.canonical}" within "${name}"`,
      };
    }
  }

  return { match: false, confidence: 0, reason: 'no match in known capabilities dictionary' };
}

/**
 * Apply naming convention heuristics to determine component type.
 * Used when the name doesn't appear in either known dictionary.
 *
 * @param {string} name - Component name
 * @param {string} [description] - Optional description/context
 * @returns {{ type: string, confidence: number, signals: Array<{ pattern: string, weight: number, reason: string }> }}
 */
export function applyHeuristics(name, description = '') {
  const solutionSignals = [];
  const capabilitySignals = [];
  const combined = `${name} ${description}`.trim();

  // Test solution patterns
  for (const sp of SOLUTION_PATTERNS) {
    if (sp.pattern.test(name)) {
      // Skip "capitalized proper noun" for common English words
      if (sp.reason === 'capitalized proper noun' && isCommonWord(normalizeName(name))) {
        continue;
      }
      solutionSignals.push({
        pattern: sp.pattern.toString(),
        weight: sp.weight,
        reason: sp.reason,
      });
    }
  }

  // Test capability patterns
  for (const cp of CAPABILITY_PATTERNS) {
    if (cp.pattern.test(name) || cp.pattern.test(combined)) {
      capabilitySignals.push({
        pattern: cp.pattern.toString(),
        weight: cp.weight,
        reason: cp.reason,
      });
    }
  }

  // Aggregate weights
  const solutionScore = solutionSignals.reduce((sum, s) => sum + s.weight, 0);
  const capabilityScore = capabilitySignals.reduce((sum, s) => sum + s.weight, 0);

  // Normalize scores to confidence: cap at 0.89 (heuristic-based can't reach dictionary-level confidence)
  const maxPossibleSolution = SOLUTION_PATTERNS.reduce((s, p) => s + p.weight, 0);
  const maxPossibleCapability = CAPABILITY_PATTERNS.reduce((s, p) => s + p.weight, 0);

  if (solutionScore > capabilityScore && solutionScore > 0) {
    const rawConfidence = Math.min(solutionScore / maxPossibleSolution, 1.0);
    // Scale to [0.50, 0.89] range — heuristics alone cap at 0.89
    const confidence = Math.round((0.50 + rawConfidence * 0.39) * 100) / 100;
    return {
      type: COMPONENT_TYPE.SOLUTION,
      confidence,
      signals: solutionSignals,
    };
  }

  if (capabilityScore > solutionScore && capabilityScore > 0) {
    const rawConfidence = Math.min(capabilityScore / maxPossibleCapability, 1.0);
    const confidence = Math.round((0.50 + rawConfidence * 0.39) * 100) / 100;
    return {
      type: COMPONENT_TYPE.CAPABILITY,
      confidence,
      signals: capabilitySignals,
    };
  }

  // No signals detected — default to capability with low confidence
  if (solutionScore === 0 && capabilityScore === 0) {
    return {
      type: COMPONENT_TYPE.CAPABILITY,
      confidence: 0.40,
      signals: [{ pattern: 'default', weight: 0, reason: 'no heuristic signals matched — defaulting to capability' }],
    };
  }

  // Tied — default to capability with low confidence
  return {
    type: COMPONENT_TYPE.CAPABILITY,
    confidence: 0.45,
    signals: [...capabilitySignals, ...solutionSignals],
  };
}

// ─── Main Detection Function ──────────────────────────────────────────────────

/**
 * @typedef {Object} ComponentTypeDetection
 * @property {string}  type           - 'solution' or 'capability'
 * @property {number}  confidence     - Confidence score (0–1)
 * @property {string}  method         - Detection method used: 'known-solution' | 'known-capability' | 'heuristic'
 * @property {string}  reason         - Human-readable explanation
 * @property {boolean} needsFallback  - true if confidence < CONFIDENCE_THRESHOLD (caller should use LLM)
 * @property {string}  [canonical]    - Canonical name (from dictionary, if available)
 * @property {string}  [vendor]       - Vendor name (solutions only)
 * @property {string}  [category]     - Category (solutions) or canonical capability name
 * @property {string}  [nature]       - Capability nature: activity|practice|knowledge|data (capabilities only)
 * @property {Array}   [signals]      - Heuristic signals (when method='heuristic')
 */

/**
 * Detect whether a component is a solution or a capability.
 *
 * Routing rule enforced:
 *   - NAMED components (products, frameworks, methodologies, standards,
 *     named practices with a specific identity) -> SOLUTION
 *   - GENERIC components (abstract activities, practices, data types,
 *     knowledge areas without a specific identity) -> CAPABILITY
 *
 * Detection priority:
 *   1. Known solutions dictionary (exact match -> 0.98 confidence)
 *   2. Known capabilities dictionary (exact match -> 0.97 confidence)
 *   3. Naming convention heuristics (max 0.89 confidence)
 *
 * When confidence < CONFIDENCE_THRESHOLD (0.90), the `needsFallback` flag
 * is set to true, signaling the caller to use LLM + web search verification
 * via the dual-verification orchestrator.
 *
 * @param {string} name - Component name
 * @param {string} [description] - Optional business/usage context
 * @returns {ComponentTypeDetection} Detection result with confidence and metadata
 */
export function detectComponentType(name, description = '') {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return {
      type: COMPONENT_TYPE.CAPABILITY,
      confidence: 0,
      method: 'error',
      reason: 'empty or invalid component name',
      needsFallback: true,
    };
  }

  const trimmedName = name.trim();

  // Priority 1: Check known solutions dictionary
  const solutionMatch = matchKnownSolution(trimmedName);
  if (solutionMatch.match) {
    return {
      type: COMPONENT_TYPE.SOLUTION,
      confidence: solutionMatch.confidence,
      method: 'known-solution',
      reason: solutionMatch.reason,
      needsFallback: solutionMatch.confidence < CONFIDENCE_THRESHOLD,
      canonical: solutionMatch.canonical,
      vendor: solutionMatch.vendor,
      category: solutionMatch.category,
    };
  }

  // Priority 2: Check known capabilities dictionary
  const capabilityMatch = matchKnownCapability(trimmedName);
  if (capabilityMatch.match) {
    return {
      type: COMPONENT_TYPE.CAPABILITY,
      confidence: capabilityMatch.confidence,
      method: 'known-capability',
      reason: capabilityMatch.reason,
      needsFallback: capabilityMatch.confidence < CONFIDENCE_THRESHOLD,
      canonical: capabilityMatch.canonical,
      nature: capabilityMatch.nature,
    };
  }

  // Priority 3: Apply naming convention heuristics
  const heuristic = applyHeuristics(trimmedName, description);
  return {
    type: heuristic.type,
    confidence: heuristic.confidence,
    method: 'heuristic',
    reason: heuristic.signals.map(s => s.reason).join('; '),
    needsFallback: heuristic.confidence < CONFIDENCE_THRESHOLD,
    signals: heuristic.signals,
  };
}
