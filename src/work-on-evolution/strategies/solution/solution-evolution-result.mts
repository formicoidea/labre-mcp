// Structured result model for solution evolution evaluation.
//
// Provides runtime-enforceable types for solution evaluation results,
// extending the base EvolutionResult contract with:
//   - Per-property phase scores with individual confidence
//   - Confidence metadata (coverage, evaluation mode, aggregation method)
//   - Factory methods for common construction patterns
//   - Full interoperability with the capability EvolutionResult contract
//
// Design principles:
//   - Aligned with EvolutionResult contract from BaseStrategy
//   - Compatible with existing SolutionBaseStrategy utilities
//   - Serializable (toJSON) and validatable (validate)
//   - Backward-compatible: strategies can return plain objects or instances
//
// Usage:
//   import { SolutionEvolutionResult, PropertyScore } from './solution-evolution-result.mjs';
//
//   const scores = [
//     PropertyScore.create('market', 'Market', 3, 'Growing competitive market'),
//     PropertyScore.create('knowledge_management', 'Knowledge management', 2),
//     // ... 10 more properties
//   ];
//   const result = SolutionEvolutionResult.fromPropertyScores(scores, {
//     method: 'solution-properties',
//     mode: 'auto',
//   });
//   result.validate(); // throws if contract violated
//   const plain = result.toEvolutionResult(); // interoperable with capability pipeline

import { BaseStrategy } from '../capacity/base-strategy.mjs';
import {
  SolutionBaseStrategy,
  PHASE_TO_EVOLUTION,
  PHASE_LABELS,
} from './solution-base-strategy.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Total number of Wardley evolution properties in the reference model. */
export const PROPERTY_COUNT = 12;

/** Default weight for each property (equal weighting: 1/N). */
export const DEFAULT_WEIGHT = 1 / PROPERTY_COUNT;

/**
 * Canonical property identifiers, matching evolution-properties.json.
 * Order follows the reference file.
 */
export const PROPERTY_IDS = Object.freeze([
  'market',
  'knowledge_management',
  'market_perception',
  'user_perception',
  'industry_perception',
  'value_focus',
  'understanding',
  'comparison',
  'failure_deficiency',
  'market_action_engagement',
  'efficiency',
  'decision_driver',
]);

/**
 * Canonical property names (human-readable), matching evolution-properties.json.
 */
export const PROPERTY_NAMES = Object.freeze([
  'Market',
  'Knowledge management',
  'Market perception',
  'User perception',
  'Industry perception',
  'Value focus',
  'Understanding',
  'Comparison',
  'Failure/deficiency',
  'Market action/engagement',
  'Efficiency',
  'Decision driver',
]);

/**
 * Map from property ID to canonical name.
 * @type {ReadonlyMap<string, string>}
 */
export const PROPERTY_ID_TO_NAME = Object.freeze(
  new Map(PROPERTY_IDS.map((id, i) => [id, PROPERTY_NAMES[i]]))
);

/**
 * Map from canonical name (lowercase) to property ID.
 * @type {ReadonlyMap<string, string>}
 */
export const PROPERTY_NAME_TO_ID = Object.freeze(
  new Map(PROPERTY_NAMES.map((name, i) => [name.toLowerCase(), PROPERTY_IDS[i]]))
);

// ─── PropertyScore ────────────────────────────────────────────────────────────

/**
 * Individual property phase score within a solution evolution evaluation.
 *
 * Extends the base PropertyEvaluation typedef with:
 *   - Property ID (canonical machine identifier)
 *   - Per-property confidence score
 *   - Phase description text from the reference
 *   - Computed evolution value for this property
 *
 * @example
 *   const score = PropertyScore.create('market', 'Market', 3, 'Growing competitive market');
 *   score.evolution   // → 0.55 (Product midpoint)
 *   score.label       // → 'Product'
 *   score.confidence  // → null (not set)
 */
export class PropertyScore {

  /**
   * @param {Object} data
   * @param {string}  data.id               - Canonical property ID (e.g. 'market')
   * @param {string}  data.property         - Human-readable property name (e.g. 'Market')
   * @param {number}  data.phase            - Evaluated phase (1–4)
   * @param {string}  [data.label]          - Phase label (auto-derived if omitted)
   * @param {number}  [data.weight]         - Weight (default: 1/12)
   * @param {number}  [data.confidence]     - Per-property evaluation confidence (0–1), null if unknown
   * @param {string}  [data.reason]         - Reasoning for the phase assignment
   * @param {string}  [data.phaseDescription] - Phase description text from reference
   */
  id: any;
  property: any;
  phase: any;
  label: any;
  weight: any;
  confidence: any;
  reason: any;
  phaseDescription: any;

  constructor({ id, property, phase, label, weight, confidence, reason, phaseDescription }: any) {
    if (!id || typeof id !== 'string') {
      throw new TypeError(`PropertyScore.id must be a non-empty string, got "${id}"`);
    }
    if (!property || typeof property !== 'string') {
      throw new TypeError(`PropertyScore.property must be a non-empty string, got "${property}"`);
    }
    if (typeof phase !== 'number' || Number.isNaN(phase) || phase < 1 || phase > 4) {
      throw new TypeError(`PropertyScore.phase must be 1–4, got ${phase}`);
    }

    /** @type {string} Canonical property identifier */
    this.id = id;

    /** @type {string} Human-readable property name */
    this.property = property;

    /** @type {number} Evaluated phase (1–4) */
    this.phase = Math.round(phase);

    /** @type {string} Phase label (Genesis/Custom/Product/Commodity) */
    this.label = label || PHASE_LABELS[this.phase] || 'Unknown';

    /** @type {number} Weight for aggregation (default: 1/12) */
    this.weight = typeof weight === 'number' ? weight : DEFAULT_WEIGHT;

    /** @type {number|null} Per-property confidence (0–1), null if unknown */
    this.confidence = (typeof confidence === 'number' && confidence >= 0 && confidence <= 1)
      ? confidence
      : null;

    /** @type {string|null} Reasoning for the phase assignment */
    this.reason = (typeof reason === 'string' && reason.length > 0) ? reason : null;

    /** @type {string|null} Phase description from reference data */
    this.phaseDescription = (typeof phaseDescription === 'string' && phaseDescription.length > 0)
      ? phaseDescription
      : null;
  }

  /**
   * Computed evolution value for this property's phase.
   * Uses the standard Wardley phase-to-evolution mapping.
   *
   * @returns {number} Evolution midpoint (0–1) for the assigned phase
   */
  get evolution() {
    return PHASE_TO_EVOLUTION[this.phase] ?? 0;
  }

  /**
   * Factory method: create a PropertyScore with minimal required fields.
   *
   * @param {string} id       - Property ID (e.g. 'market')
   * @param {string} property - Property name (e.g. 'Market')
   * @param {number} phase    - Phase (1–4)
   * @param {string} [reason] - Optional reason
   * @param {Object} [extra]  - Optional extra fields (confidence, phaseDescription, weight)
   * @returns {PropertyScore}
   */
  static create(id, property, phase, reason, extra = {}) {
    return new PropertyScore({
      id,
      property,
      phase,
      reason,
      ...extra,
    });
  }

  /**
   * Factory method: create from a PropertyEvaluation plain object
   * (as returned by SolutionBaseStrategy.buildPropertyEvaluation).
   *
   * @param {Object} evalObj  - PropertyEvaluation-shaped object
   * @param {string} [id]     - Property ID (derived from name if omitted)
   * @returns {PropertyScore}
   */
  static fromPropertyEvaluation(evalObj: any, id?: string) {
    const resolvedId = id
      || PROPERTY_NAME_TO_ID.get(evalObj.property?.toLowerCase())
      || evalObj.property?.toLowerCase().replace(/[\s/]+/g, '_')
      || 'unknown';

    return new PropertyScore({
      id: resolvedId,
      property: evalObj.property,
      phase: evalObj.phase,
      label: evalObj.label,
      weight: evalObj.weight,
      reason: evalObj.reason,
    });
  }

  /**
   * Convert to a plain PropertyEvaluation object
   * (compatible with SolutionBaseStrategy.validateSolutionResult).
   *
   * @returns {{ property: string, phase: number, label: string, weight: number, reason?: string }}
   */
  toPropertyEvaluation() {
    const result: any = {
      property: this.property,
      phase: this.phase,
      label: this.label,
      weight: this.weight,
    };
    if (this.reason != null) result.reason = this.reason;
    return result;
  }

  /**
   * Full JSON representation including all fields.
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      property: this.property,
      phase: this.phase,
      label: this.label,
      weight: this.weight,
      evolution: this.evolution,
      ...(this.confidence != null && { confidence: this.confidence }),
      ...(this.reason != null && { reason: this.reason }),
      ...(this.phaseDescription != null && { phaseDescription: this.phaseDescription }),
    };
  }
}


// ─── ConfidenceMetadata ───────────────────────────────────────────────────────

/**
 * Structured metadata about how the overall confidence score was computed.
 *
 * Captures the evaluation context (mode, aggregation method) and
 * per-property confidence statistics, enabling downstream consumers
 * to understand and explain the confidence level.
 *
 * @example
 *   const meta = new ConfidenceMetadata({
 *     coverage: 1.0,
 *     evaluatedCount: 12,
 *     totalCount: 12,
 *     mode: 'auto',
 *   });
 */
export class ConfidenceMetadata {

  /**
   * @param {Object} data
   * @param {number}  data.coverage               - Ratio of evaluated vs total properties (0–1)
   * @param {number}  data.evaluatedCount          - Number of properties successfully evaluated
   * @param {number}  [data.totalCount]            - Total properties in reference (default: 12)
   * @param {string}  [data.mode]                  - Evaluation mode: 'auto' | 'conversational'
   * @param {number}  [data.meanPropertyConfidence] - Mean confidence across per-property scores
   * @param {string}  [data.aggregationMethod]     - How properties were aggregated
   * @param {number}  [data.phaseAgreement]        - Inter-property phase consistency (0–1)
   */
  coverage: any;
  evaluatedCount: any;
  totalCount: any;
  mode: any;
  meanPropertyConfidence: any;
  aggregationMethod: any;
  phaseAgreement: any;

  constructor({
    coverage,
    evaluatedCount,
    totalCount,
    mode,
    meanPropertyConfidence,
    aggregationMethod,
    phaseAgreement,
  }: any) {
    if (typeof coverage !== 'number' || coverage < 0 || coverage > 1) {
      throw new TypeError(`ConfidenceMetadata.coverage must be 0–1, got ${coverage}`);
    }
    if (typeof evaluatedCount !== 'number' || evaluatedCount < 0) {
      throw new TypeError(`ConfidenceMetadata.evaluatedCount must be >= 0, got ${evaluatedCount}`);
    }

    /** @type {number} Ratio of evaluated vs total properties (0–1) */
    this.coverage = Math.round(coverage * 1000) / 1000;

    /** @type {number} Number of properties successfully evaluated */
    this.evaluatedCount = evaluatedCount;

    /** @type {number} Total properties in reference (default: 12) */
    this.totalCount = typeof totalCount === 'number' ? totalCount : PROPERTY_COUNT;

    /** @type {string} Evaluation mode */
    this.mode = mode || 'auto';

    /** @type {number|null} Mean per-property confidence */
    this.meanPropertyConfidence = (typeof meanPropertyConfidence === 'number')
      ? Math.round(meanPropertyConfidence * 1000) / 1000
      : null;

    /** @type {string} Aggregation method used */
    this.aggregationMethod = aggregationMethod || 'weighted_average';

    /** @type {number|null} Inter-property phase consistency */
    this.phaseAgreement = (typeof phaseAgreement === 'number')
      ? Math.round(phaseAgreement * 1000) / 1000
      : null;
  }

  /**
   * JSON representation.
   * @returns {Object}
   */
  toJSON() {
    return {
      coverage: this.coverage,
      evaluatedCount: this.evaluatedCount,
      totalCount: this.totalCount,
      mode: this.mode,
      aggregationMethod: this.aggregationMethod,
      ...(this.meanPropertyConfidence != null && { meanPropertyConfidence: this.meanPropertyConfidence }),
      ...(this.phaseAgreement != null && { phaseAgreement: this.phaseAgreement }),
    };
  }
}


// ─── SolutionEvolutionResult ──────────────────────────────────────────────────

/**
 * Structured result type for solution evolution evaluation.
 *
 * Holds:
 *   - Individual phase scores for each of the 12 Wardley evolution properties
 *     (Market, Knowledge management, Market perception, etc.)
 *   - Overall evolution placement on the 0–1 Wardley competitive axis
 *   - Confidence metadata explaining how the confidence was computed
 *   - Trace of evaluation steps
 *
 * Fully aligned with the EvolutionResult contract from BaseStrategy:
 *   - toEvolutionResult() returns a plain { evolution, confidence, method, trace, properties }
 *   - validate() checks both the core contract and solution-specific extensions
 *   - Can be consumed anywhere the capability EvolutionResult is accepted
 *
 * @example
 *   // Construction from property scores
 *   const result = SolutionEvolutionResult.fromPropertyScores(scores, {
 *     method: 'solution-properties',
 *     mode: 'auto',
 *   });
 *
 *   // Direct construction
 *   const result = new SolutionEvolutionResult({
 *     evolution: 0.55,
 *     confidence: 0.85,
 *     method: 'solution-properties',
 *     properties: [...],
 *   });
 *
 *   // Interop with capability pipeline
 *   const plain = result.toEvolutionResult();
 *   BaseStrategy.validateResult(plain); // passes
 */
export class SolutionEvolutionResult {
  evolution: any;
  confidence: any;
  method: any;
  trace: any;
  properties: any;
  confidenceMetadata: any;

  constructor({ evolution, confidence, method, trace, properties, confidenceMetadata }: any) {
    if (typeof evolution !== 'number' || Number.isNaN(evolution)) {
      throw new TypeError(`SolutionEvolutionResult.evolution must be a number, got ${evolution}`);
    }
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      throw new TypeError(
        `SolutionEvolutionResult.confidence must be 0–1, got ${confidence}`
      );
    }
    if (typeof method !== 'string' || method.length === 0) {
      throw new TypeError(
        `SolutionEvolutionResult.method must be a non-empty string, got "${method}"`
      );
    }

    /** @type {number} Overall evolution position on the Wardley axis (0–1) */
    this.evolution = Math.round(evolution * 1000) / 1000;

    /** @type {number} Overall confidence score (0–1) */
    this.confidence = Math.round(confidence * 1000) / 1000;

    /** @type {string} Strategy identifier (e.g. 'solution-properties') */
    this.method = method;

    /** @type {Array} Reasoning trace */
    this.trace = Array.isArray(trace) ? trace : [];

    /** @type {PropertyScore[]} Per-property phase evaluations */
    this.properties = Array.isArray(properties) ? properties : [];

    /** @type {ConfidenceMetadata|null} Confidence computation metadata */
    this.confidenceMetadata = confidenceMetadata || null;
  }

  // ─── Computed Properties ──────────────────────────────────────────────

  /**
   * The Wardley stage label for the overall evolution position.
   * @returns {string} 'Genesis' | 'Custom' | 'Product' | 'Commodity'
   */
  get stage() {
    if (this.evolution < 0.18) return 'Genesis';
    if (this.evolution < 0.40) return 'Custom';
    if (this.evolution < 0.70) return 'Product';
    return 'Commodity';
  }

  /**
   * Number of per-property evaluations.
   * @returns {number}
   */
  get propertyCount() {
    return this.properties.length;
  }

  /**
   * Mean phase across all evaluated properties.
   * @returns {number|null} Mean phase (1–4) or null if no properties
   */
  get meanPhase() {
    if (this.properties.length === 0) return null;
    const sum = this.properties.reduce((s, p) => s + (p.phase || 0), 0);
    return Math.round((sum / this.properties.length) * 100) / 100;
  }

  /**
   * Phase distribution: count of properties at each phase.
   * @returns {{ 1: number, 2: number, 3: number, 4: number }}
   */
  get phaseDistribution() {
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const prop of this.properties) {
      const p = prop.phase;
      if (p >= 1 && p <= 4) dist[p]++;
    }
    return dist;
  }

  // ─── Factory Methods ──────────────────────────────────────────────────

  /**
   * Build a SolutionEvolutionResult from an array of PropertyScore instances.
   *
   * Computes:
   *   - Weighted aggregation of property phases into overall evolution
   *   - Coverage-based overall confidence
   *   - Confidence metadata from per-property statistics
   *
   * @param {PropertyScore[]} scores   - Array of property evaluations
   * @param {Object} options
   * @param {string}  options.method   - Strategy identifier
   * @param {string}  [options.mode]   - Evaluation mode ('auto' | 'conversational')
   * @param {Array}   [options.trace]  - Additional trace entries
   * @returns {SolutionEvolutionResult}
   */
  static fromPropertyScores(scores: any, { method, mode = 'auto', trace = [] }: any) {
    if (!Array.isArray(scores) || scores.length === 0) {
      throw new Error('fromPropertyScores requires a non-empty array of PropertyScore instances');
    }

    // Convert to PropertyEvaluation for aggregation
    const propEvals = scores.map(s =>
      s instanceof PropertyScore ? s.toPropertyEvaluation() : s
    );

    // Use SolutionBaseStrategy's aggregation (ensures consistency)
    const { evolution, confidence } = SolutionBaseStrategy.aggregateProperties(propEvals);

    // Compute confidence metadata
    const withConfidence = scores.filter(s => s.confidence != null && s.confidence !== null);
    const evaluatedWithReason = scores.filter(
      s => s.reason != null && !s.reason.startsWith('Not evaluated')
    );
    const evaluatedCount = evaluatedWithReason.length || scores.length;
    const coverage = evaluatedCount / PROPERTY_COUNT;

    const meanPropertyConfidence = withConfidence.length > 0
      ? withConfidence.reduce((sum, s) => sum + s.confidence, 0) / withConfidence.length
      : null;

    // Compute phase agreement: how concentrated are phases?
    // Uses normalized entropy: 0 = all same phase, 1 = uniform distribution
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const s of scores) {
      if (s.phase >= 1 && s.phase <= 4) dist[s.phase]++;
    }
    const total = scores.length;
    let entropy = 0;
    for (const count of Object.values(dist)) {
      if (count > 0) {
        const p = count / total;
        entropy -= p * Math.log2(p);
      }
    }
    const maxEntropy = Math.log2(4); // 2.0
    const phaseAgreement = Math.round((1 - entropy / maxEntropy) * 1000) / 1000;

    const confidenceMetadata = new ConfidenceMetadata({
      coverage: Math.round(coverage * 1000) / 1000,
      evaluatedCount,
      totalCount: PROPERTY_COUNT,
      mode,
      meanPropertyConfidence,
      aggregationMethod: 'weighted_average',
      phaseAgreement,
    });

    return new SolutionEvolutionResult({
      evolution,
      confidence,
      method,
      trace,
      properties: scores,
      confidenceMetadata,
    });
  }

  /**
   * Reconstruct a SolutionEvolutionResult from a plain EvolutionResult object
   * (as returned by toEvolutionResult() or existing strategy evaluate() methods).
   *
   * Useful for upgrading legacy results to the structured model.
   *
   * @param {Object} plainResult - Plain { evolution, confidence, method, trace?, properties? }
   * @returns {SolutionEvolutionResult}
   */
  static fromEvolutionResult(plainResult: any) {
    const properties = (plainResult.properties || []).map(p => {
      if (p instanceof PropertyScore) return p;
      return PropertyScore.fromPropertyEvaluation(p);
    });

    return new SolutionEvolutionResult({
      evolution: plainResult.evolution,
      confidence: plainResult.confidence,
      method: plainResult.method,
      trace: plainResult.trace,
      properties,
      confidenceMetadata: plainResult.confidenceMetadata || null,
    });
  }

  // ─── Validation ───────────────────────────────────────────────────────

  /**
   * Validate this result against both the core EvolutionResult contract
   * and solution-specific extensions.
   *
   * @returns {SolutionEvolutionResult} this (for chaining)
   * @throws {TypeError} If any field violates the contract
   */
  validate() {
    // Core EvolutionResult contract (interop with capability pipeline)
    BaseStrategy.validateResult(this.toEvolutionResult());

    // Solution-specific: validate properties
    if (this.properties.length > 0) {
      for (const prop of this.properties) {
        const phase = prop.phase;
        const name = prop.property || prop.id;
        if (typeof phase !== 'number' || phase < 1 || phase > 4) {
          throw new TypeError(
            `Property "${name}" phase must be 1–4, got ${phase}`
          );
        }
      }
    }

    return this;
  }

  // ─── Conversion ───────────────────────────────────────────────────────

  /**
   * Convert to a plain EvolutionResult object, fully compatible with
   * the capability strategy pipeline (BaseStrategy.validateResult).
   *
   * This is the canonical way to pass solution results through any
   * consumer that expects the standard EvolutionResult shape.
   *
   * @returns {{ evolution: number, confidence: number, method: string, trace: Array, properties: Array }}
   */
  toEvolutionResult() {
    return {
      evolution: this.evolution,
      confidence: this.confidence,
      method: this.method,
      trace: this.trace,
      properties: this.properties.map(p =>
        p instanceof PropertyScore ? p.toPropertyEvaluation() : p
      ),
    };
  }

  /**
   * Full JSON representation with all structured fields.
   * Includes confidence metadata and rich property details.
   *
   * @returns {Object}
   */
  toJSON() {
    return {
      evolution: this.evolution,
      confidence: this.confidence,
      method: this.method,
      stage: this.stage,
      meanPhase: this.meanPhase,
      phaseDistribution: this.phaseDistribution,
      trace: this.trace,
      properties: this.properties.map(p =>
        (p instanceof PropertyScore || typeof p.toJSON === 'function')
          ? p.toJSON()
          : p
      ),
      ...(this.confidenceMetadata != null && {
        confidenceMetadata:
          (this.confidenceMetadata instanceof ConfidenceMetadata ||
           typeof this.confidenceMetadata.toJSON === 'function')
            ? this.confidenceMetadata.toJSON()
            : this.confidenceMetadata,
      }),
    };
  }

  /**
   * Human-readable summary string.
   * @returns {string}
   */
  toString() {
    const propsText = this.properties.length > 0
      ? this.properties.map(p =>
          `  ${p.property || p.id}: Phase ${p.phase} (${p.label || PHASE_LABELS[p.phase]})`
        ).join('\n')
      : '  (no property evaluations)';

    return [
      `SolutionEvolutionResult {`,
      `  evolution: ${this.evolution} (${this.stage})`,
      `  confidence: ${this.confidence}`,
      `  method: ${this.method}`,
      `  properties (${this.propertyCount}):`,
      propsText,
      `}`,
    ].join('\n');
  }
}
