// Per-property phase classification logic for Wardley evolution evaluation.
//
// Evaluates input text (solution description, evidence, context) against
// the 12-property phase reference to assign a phase (1–4) for each property.
//
// Classification approach:
//   1. Extract discriminative terms from each phase description
//   2. Build per-property signal banks with TF-IDF-like weighting
//   3. Augment with general cross-property phase indicators
//   4. Score input text against each phase's signals (unigrams + bigrams)
//   5. Select the phase with the highest normalized score
//   6. Compute confidence from score distribution (margin between top two)
//
// This module provides a fast, non-LLM classification path that can be used:
//   - As a standalone heuristic evaluator
//   - As a validation layer to cross-check LLM classifications
//   - As a fallback when LLM is unavailable
//
// Usage:
//   import { PhaseClassifier } from './phase-classifier.mjs';
//   const classifier = await PhaseClassifier.fromReference();
//   const result = classifier.classifyAll('Kubernetes is a widely adopted...');

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Stop Words ───────────────────────────────────────────────────────────────
// Common English words filtered out during term extraction.
// Kept minimal — only high-frequency function words that carry no phase signal.

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'it', 'its', 'are', 'was',
  'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does',
  'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
  'can', 'that', 'which', 'who', 'whom', 'this', 'these', 'those',
  'not', 'no', 'nor', 'so', 'yet', 'both', 'each', 'few', 'more',
  'most', 'other', 'some', 'such', 'than', 'too', 'very', 'just',
  'also', 'into', 'about', 'over', 'after', 'before', 'between',
  'through', 'during', 'above', 'below', 'up', 'out', 'off', 'down',
  'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'any', 'if', 'even', 'only', 'own', 'same', 'via',
]);

// ─── General Phase Indicators ─────────────────────────────────────────────────
// Cross-property keywords that strongly signal a specific phase regardless
// of which property is being evaluated.  These augment the per-property
// signals extracted from phase descriptions.

const GENERAL_PHASE_SIGNALS = {
  1: [
    'genesis', 'novel', 'experimental', 'unproven', 'prototype',
    'proof of concept', 'research', 'invention', 'pioneering',
    'unexplored', 'undefined', 'nascent', 'embryonic', 'frontier',
    'bleeding edge', 'unknown territory', 'first of its kind',
    'early stage', 'pre-market', 'lab', 'academic',
    'concept', 'speculative', 'visionary', 'untested',
  ],
  2: [
    'custom', 'bespoke', 'tailored', 'early adopter', 'emerging',
    'niche', 'differentiation', 'custom-built', 'hand-crafted',
    'specialist', 'artisanal', 'first mover', 'competitive advantage',
    'growing adoption', 'early traction', 'fragmented',
    'consultancy', 'consulting', 'professional services',
    'learning curve', 'tribal knowledge',
  ],
  3: [
    'product', 'standardized', 'vendor', 'platform', 'ecosystem',
    'best practice', 'certification', 'certified', 'mainstream',
    'established', 'proven', 'reliable', 'feature-rich',
    'competitive market', 'analyst', 'industry standard',
    'sla', 'service level', 'benchmark', 'reference architecture',
    'total cost of ownership', 'tco', 'enterprise',
    'widespread adoption', 'production-ready', 'mature product',
  ],
  4: [
    'commodity', 'utility', 'ubiquitous', 'commoditized',
    'standardised', 'price-driven', 'automated', 'just works',
    'infrastructure', 'scale', 'economies of scale', 'self-service',
    'api-driven', 'on-demand', 'pay-per-use', 'volume-based',
    'taken for granted', 'invisible', 'baseline', 'essential',
    'compliance', 'operational excellence', 'marginal cost',
    'utility pricing', 'interchangeable', 'fungible',
  ],
};

// ─── Text Processing Utilities ────────────────────────────────────────────────

/**
 * Normalize text for comparison: lowercase, remove punctuation, collapse whitespace.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract meaningful unigram tokens from text (words, excluding stop words).
 * @param {string} text - Normalized text
 * @returns {string[]}
 */
function extractTokens(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Extract bigram phrases from text (consecutive word pairs).
 * @param {string} text - Normalized text
 * @returns {string[]}
 */
function extractBigrams(text) {
  const words = normalizeText(text).split(/\s+/).filter(w => w.length > 1);
  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

// ─── Signal Bank ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SignalEntry
 * @property {string} term       - The signal term (unigram or phrase)
 * @property {number} weight     - Discriminative weight (higher = more indicative of this phase)
 * @property {string} source     - Where the signal came from: 'description' or 'general'
 */

/**
 * @typedef {Object} PropertySignals
 * @property {string} propertyName
 * @property {string} propertyId
 * @property {Map<number, SignalEntry[]>} phases  - Map of phase (1–4) → signal entries
 */

/**
 * Build the signal bank for a single property from its phase descriptions.
 *
 * Terms that appear in only one phase get weight 1.0 (highly discriminative).
 * Terms that appear in two phases get weight 0.5, etc.
 * General phase indicators are added with a moderate weight (0.6).
 *
 * @param {object} property - Property definition with name and phases
 * @returns {PropertySignals}
 */
function buildPropertySignals(property) {
  const phases = property.phases || {};

  // Step 1: Extract all unigram tokens per phase
  const phaseTokens = {};
  for (const phaseNum of [1, 2, 3, 4]) {
    const desc = phases[String(phaseNum)] || '';
    phaseTokens[phaseNum] = new Set(extractTokens(desc));
  }

  // Step 2: Count how many phases each token appears in (for discrimination)
  const tokenPhaseCount = {};
  for (const phaseNum of [1, 2, 3, 4]) {
    for (const token of phaseTokens[phaseNum]) {
      tokenPhaseCount[token] = (tokenPhaseCount[token] || 0) + 1;
    }
  }

  // Step 3: Build signal entries with discrimination-based weights
  const phaseSignals = new Map();

  for (const phaseNum of [1, 2, 3, 4]) {
    const signals = [];

    // Signals from description tokens (unigrams)
    for (const token of phaseTokens[phaseNum]) {
      const phaseCount = tokenPhaseCount[token] || 1;
      const discriminativeWeight = 1.0 / phaseCount;
      signals.push({
        term: token,
        weight: discriminativeWeight,
        source: 'description',
      });
    }

    // Signals from description bigrams (phrases)
    const desc = phases[String(phaseNum)] || '';
    const bigrams = extractBigrams(desc);
    for (const bigram of bigrams) {
      // Check if this bigram is unique to this phase
      const bigramInOthers = [1, 2, 3, 4]
        .filter(p => p !== phaseNum)
        .some(p => normalizeText(phases[String(p)] || '').includes(bigram));

      signals.push({
        term: bigram,
        weight: bigramInOthers ? 0.3 : 0.8,
        source: 'description-bigram',
      });
    }

    // Signals from general phase indicators
    const generalTerms = GENERAL_PHASE_SIGNALS[phaseNum] || [];
    for (const term of generalTerms) {
      signals.push({
        term: normalizeText(term),
        weight: 0.6,
        source: 'general',
      });
    }

    phaseSignals.set(phaseNum, signals);
  }

  return {
    propertyName: property.name,
    propertyId: property.id || property.name.toLowerCase().replace(/\s+/g, '_'),
    phases: phaseSignals,
  };
}


// ─── PhaseClassifier ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} PropertyClassification
 * @property {string}  property    - Property name (e.g. "Market")
 * @property {number}  phase       - Assigned phase (1–4)
 * @property {string}  label       - Phase label (Genesis, Custom, Product, Commodity)
 * @property {number}  confidence  - Classification confidence (0–1)
 * @property {Object}  scores      - Raw scores per phase { 1: n, 2: n, 3: n, 4: n }
 * @property {string}  reason      - Brief explanation of classification
 */

const PHASE_LABELS = { 1: 'Genesis', 2: 'Custom', 3: 'Product', 4: 'Commodity' };

/**
 * Per-property phase classifier for Wardley evolution evaluation.
 *
 * Evaluates input text against the 12-property phase reference using
 * keyword-based scoring with TF-IDF-like discrimination weighting.
 *
 * @example
 *   const classifier = await PhaseClassifier.fromReference();
 *   const results = classifier.classifyAll('Kubernetes is a mature container orchestration platform...');
 *   // → [{ property: 'Market', phase: 3, confidence: 0.72, ... }, ...]
 *
 * @example
 *   const result = classifier.classifyProperty('Market', 'Highly commoditized market...');
 *   // → { property: 'Market', phase: 4, confidence: 0.85, ... }
 */
export class PhaseClassifier {

  /**
   * @param {object[]} propertiesRef - Array of property definitions from evolution-properties.json
   */
  constructor(propertiesRef) {
    if (!Array.isArray(propertiesRef) || propertiesRef.length === 0) {
      throw new Error('PhaseClassifier requires a non-empty properties reference array');
    }
    this._properties = propertiesRef;
    this._signalBank = propertiesRef.map(buildPropertySignals);
  }

  /**
   * Create a PhaseClassifier from the evolution-properties.json reference file.
   * Factory method that handles async file loading.
   *
   * @returns {Promise<PhaseClassifier>}
   */
  static async fromReference() {
    const refPath = join(__dirname, 'evolution-properties.json');
    const raw = await readFile(refPath, 'utf-8');
    const data = JSON.parse(raw);
    const properties = data.properties || data;
    return new PhaseClassifier(properties);
  }

  /**
   * Get the number of properties in the reference.
   * @returns {number}
   */
  get propertyCount() {
    return this._properties.length;
  }

  /**
   * Get the list of property names.
   * @returns {string[]}
   */
  get propertyNames() {
    return this._properties.map(p => p.name);
  }

  /**
   * Classify input text for a single property, returning the best-matching phase.
   *
   * Scoring algorithm:
   *   1. Normalize and tokenize the input text
   *   2. For each phase (1–4), scan the signal bank for term matches
   *   3. Sum matched signal weights → raw phase score
   *   4. Select the phase with highest score
   *   5. Compute confidence from score margin between top two phases
   *
   * @param {string} propertyName - Name of the property to classify (e.g. "Market")
   * @param {string} inputText    - Text to evaluate (solution description, evidence, etc.)
   * @returns {PropertyClassification}
   * @throws {Error} If propertyName is not found in the reference
   */
  classifyProperty(propertyName, inputText) {
    const signals = this._findPropertySignals(propertyName);
    return this._scoreAndClassify(signals, inputText);
  }

  /**
   * Classify input text against all 12 properties, returning per-property phases.
   *
   * @param {string} inputText - Text to evaluate against all properties
   * @returns {PropertyClassification[]} Array of 12 classifications (one per property)
   */
  classifyAll(inputText) {
    return this._signalBank.map(signals => this._scoreAndClassify(signals, inputText));
  }

  /**
   * Classify input text against a subset of properties.
   *
   * @param {string} inputText      - Text to evaluate
   * @param {string[]} propertyNames - Names of properties to evaluate
   * @returns {PropertyClassification[]}
   */
  classifySubset(inputText, propertyNames) {
    const nameSet = new Set(propertyNames.map(n => n.toLowerCase()));
    return this._signalBank
      .filter(s => nameSet.has(s.propertyName.toLowerCase()))
      .map(signals => this._scoreAndClassify(signals, inputText));
  }

  /**
   * Validate an existing phase classification against the classifier's judgment.
   * Returns the degree of agreement (0 = complete disagreement, 1 = exact match).
   *
   * @param {string} propertyName  - Property name
   * @param {number} assignedPhase - Phase assigned by another method (e.g. LLM)
   * @param {string} inputText     - The text that was classified
   * @returns {{ agreement: number, classifierPhase: number, assignedPhase: number, delta: number }}
   */
  validateClassification(propertyName, assignedPhase, inputText) {
    const classification = this.classifyProperty(propertyName, inputText);
    const delta = Math.abs(classification.phase - assignedPhase);

    // Agreement: 1.0 for exact match, 0.67 for ±1, 0.33 for ±2, 0.0 for ±3
    const agreement = Math.max(0, 1 - (delta / 3));

    return {
      agreement,
      classifierPhase: classification.phase,
      assignedPhase,
      delta,
      classifierConfidence: classification.confidence,
    };
  }

  // ─── Internal Methods ─────────────────────────────────────────────────────

  /**
   * Find the signal bank entry for a given property name.
   * Uses fuzzy matching (case-insensitive, substring).
   *
   * @param {string} propertyName
   * @returns {PropertySignals}
   * @private
   */
  _findPropertySignals(propertyName) {
    const lower = propertyName.toLowerCase().trim();

    // Exact match
    let match = this._signalBank.find(
      s => s.propertyName.toLowerCase() === lower
    );
    if (match) return match;

    // Substring match
    match = this._signalBank.find(
      s => s.propertyName.toLowerCase().includes(lower) ||
           lower.includes(s.propertyName.toLowerCase())
    );
    if (match) return match;

    const available = this._signalBank.map(s => s.propertyName).join(', ');
    throw new Error(
      `Unknown property "${propertyName}". Available: ${available}`
    );
  }

  /**
   * Score input text against a property's signal bank and select the best phase.
   *
   * @param {PropertySignals} signals - Property signal bank
   * @param {string} inputText        - Text to score
   * @returns {PropertyClassification}
   * @private
   */
  _scoreAndClassify(signals, inputText) {
    const normalizedInput = normalizeText(inputText);
    const inputTokens = new Set(extractTokens(inputText));
    const inputBigrams = new Set(extractBigrams(inputText));

    // Score each phase
    const scores = { 1: 0, 2: 0, 3: 0, 4: 0 };

    for (const phaseNum of [1, 2, 3, 4]) {
      const phaseSignals = signals.phases.get(phaseNum) || [];
      let phaseScore = 0;

      for (const signal of phaseSignals) {
        const term = signal.term;
        let matched = false;

        // Check for multi-word phrase match in normalized text
        if (term.includes(' ')) {
          if (normalizedInput.includes(term)) {
            matched = true;
          }
        } else {
          // Single-word token match
          if (inputTokens.has(term)) {
            matched = true;
          }
        }

        if (matched) {
          phaseScore += signal.weight;
        }
      }

      scores[phaseNum] = Math.round(phaseScore * 1000) / 1000;
    }

    // Select the phase with highest score
    const { phase, confidence, reason } = this._selectPhase(scores, signals.propertyName);

    return {
      property: signals.propertyName,
      phase,
      label: PHASE_LABELS[phase],
      confidence,
      scores,
      reason,
    };
  }

  /**
   * Select the winning phase from scores and compute confidence.
   *
   * Confidence is based on:
   *   - Score margin: how much the top phase exceeds the runner-up
   *   - Total score: whether there's enough signal to be meaningful
   *
   * When all scores are zero (no signal found), defaults to phase 2
   * with very low confidence.
   *
   * @param {Object} scores   - Phase scores { 1: n, 2: n, 3: n, 4: n }
   * @param {string} propName - Property name for reason text
   * @returns {{ phase: number, confidence: number, reason: string }}
   * @private
   */
  _selectPhase(scores, propName) {
    const entries = Object.entries(scores)
      .map(([p, s]) => ({ phase: parseInt(p, 10), score: s }))
      .sort((a, b) => b.score - a.score);

    const topScore = entries[0].score;
    const totalScore = entries.reduce((sum, e) => sum + e.score, 0);

    // No signal: default to phase 2 (Custom) with minimal confidence
    if (totalScore === 0) {
      return {
        phase: 2,
        confidence: 0.1,
        reason: `No text signals matched for ${propName}; defaulted to Custom (phase 2)`,
      };
    }

    const winningPhase = entries[0].phase;
    const runnerUpScore = entries[1].score;

    // Margin-based confidence
    const margin = topScore - runnerUpScore;
    const marginRatio = margin / topScore;

    // Score adequacy: penalize if total score is low
    // Sigmoid-like scaling: at totalScore=5 → ~0.92, at totalScore=1 → ~0.5
    const adequacy = 1 - Math.exp(-totalScore / 3);

    // Combined confidence: margin dominance × score adequacy, capped at 0.95
    const rawConfidence = marginRatio * adequacy;
    const confidence = Math.round(Math.min(0.95, Math.max(0.05, rawConfidence)) * 1000) / 1000;

    // Build reason text
    const label = PHASE_LABELS[winningPhase];
    const reason = entries[0].score === entries[1].score
      ? `${propName}: tied between phases, selected ${label} (phase ${winningPhase})`
      : `${propName}: strongest signal for ${label} (phase ${winningPhase}), ` +
        `score ${topScore.toFixed(2)} vs runner-up ${runnerUpScore.toFixed(2)}`;

    return { phase: winningPhase, confidence, reason };
  }
}

// ─── Convenience Functions ────────────────────────────────────────────────────

/**
 * Classify all 12 properties for a given input text in one call.
 * Creates a classifier from the default reference file.
 *
 * @param {string} inputText - Solution description or evidence text
 * @returns {Promise<PropertyClassification[]>}
 */
export async function classifyAllProperties(inputText) {
  const classifier = await PhaseClassifier.fromReference();
  return classifier.classifyAll(inputText);
}

/**
 * Classify a single property for a given input text.
 *
 * @param {string} propertyName - Property name (e.g. "Market")
 * @param {string} inputText    - Text to evaluate
 * @returns {Promise<PropertyClassification>}
 */
export async function classifySingleProperty(propertyName, inputText) {
  const classifier = await PhaseClassifier.fromReference();
  return classifier.classifyProperty(propertyName, inputText);
}

// ─── Exports for Testing ──────────────────────────────────────────────────────

export {
  normalizeText,
  extractTokens,
  extractBigrams,
  buildPropertySignals,
  GENERAL_PHASE_SIGNALS,
  PHASE_LABELS,
};
