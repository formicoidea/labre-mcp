// Property aggregation logic for solution evolution evaluation.
//
// Takes individual per-property phase scores and computes an overall
// evolution placement on the Wardley competitive axis (0–1).
//
// Features:
//   - Equal-weight aggregation by default (1/N for each property)
//   - Custom weight overrides per property
//   - Property toggling: disable properties and renormalize remaining weights
//     (follows the CPC indicator toggle pattern from patent-indicators)
//   - Partial coverage handling: graceful degradation when not all 12 properties
//     are evaluated
//   - Confidence model based on coverage, phase agreement, and weight quality
//
// This module is the single source of truth for property → evolution aggregation
// across all solution strategies. It is consumed by:
//   - SolutionBaseStrategy.aggregateProperties() (delegates here)
//   - SolutionEvolutionResult.fromPropertyScores()
//   - PropertiesStrategy.evaluate()
//   - Any future solution strategy that produces per-property evaluations
//
// The aggregation contract:
//   Input:  Array of { property, phase (1–4), weight?, enabled? }
//   Output: { evolution (0–1), confidence (0–1), weightMap, metadata }
//
// Usage:
//   import { aggregatePropertyScores, renormalizeWeights } from './aggregate-properties.mjs';
//
//   const result = aggregatePropertyScores(scores);
//   // → { evolution: 0.55, confidence: 0.85, weightMap: {...}, metadata: {...} }
//
//   // With toggling:
//   const result = aggregatePropertyScores(scores, {
//     disabled: ['efficiency', 'decision_driver'],
//   });

// ─── Phase ↔ Evolution Mapping ─────────────────────────────────────────────────
// Defined locally to avoid circular dependency with solution-base-strategy.mjs,
// which may delegate its aggregateProperties() to this module.
// Values match solution-base-strategy.mjs and evolution-properties.json exactly.

/**
 * Map discrete phase (1–4) to continuous evolution midpoint on the Wardley axis.
 * @type {Readonly<Record<number, number>>}
 */
const PHASE_TO_EVOLUTION: Record<number, number> = Object.freeze({
  1: 0.09,   // Genesis   [0.00, 0.18]
  2: 0.29,   // Custom    [0.18, 0.40]
  3: 0.55,   // Product   [0.40, 0.70]
  4: 0.85,   // Commodity [0.70, 1.00]
});

export { PHASE_TO_EVOLUTION };

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Standard property count in the Wardley evolution reference model. */
export const STANDARD_PROPERTY_COUNT = 12;

/** Default weight per property (equal weighting). */
export const DEFAULT_WEIGHT = 1 / STANDARD_PROPERTY_COUNT;

/** Maximum confidence when all properties are evaluated with full coverage. */
export const MAX_BASE_CONFIDENCE = 0.85;

/** Minimum confidence floor (even with very poor coverage). */
export const MIN_CONFIDENCE = 0.10;

/** Maximum overall confidence cap (prevent over-confidence). */
export const MAX_CONFIDENCE = 0.95;

// ─── Weight Renormalization ─────────────────────────────────────────────────────
// Follows the CPC indicator toggling pattern:
// When some properties are disabled, remaining weights are renormalized to sum to 1.0.

/**
 * @typedef {Object} PropertyWeightConfig
 * @property {number}  weight   - Base weight for this property
 * @property {boolean} enabled  - Whether the property participates in aggregation
 */

/**
 * Renormalize weights for enabled properties so they sum to 1.0.
 * Disabled properties are excluded entirely from the aggregation.
 *
 * This is the solution-strategies equivalent of the patent indicator
 * toggle pattern in cpc-evolution-strategy.mjs.
 *
 * @param {Record<string, PropertyWeightConfig>} weightConfig
 *   Map of property identifier → { weight, enabled }.
 *   Identifiers can be property names or IDs.
 * @returns {Record<string, number>}
 *   Map of enabled property identifier → renormalized weight.
 *   Empty map if all properties are disabled.
 *
 * @example
 *   const config = {
 *     market:               { weight: 1/12, enabled: true },
 *     knowledge_management: { weight: 1/12, enabled: true },
 *     efficiency:           { weight: 1/12, enabled: false },
 *     // ...
 *   };
 *   const weights = renormalizeWeights(config);
 *   // efficiency excluded, others get proportionally higher weights summing to 1.0
 */
export function renormalizeWeights(weightConfig: any) {
  const enabled = Object.entries(weightConfig)
    .filter(([, cfg]: [string, any]) => cfg.enabled !== false);

  if (enabled.length === 0) {
    return {};
  }

  const totalWeight = enabled.reduce((sum, [, cfg]: [string, any]) => sum + (cfg.weight || 0), 0);

  const normalized: Record<string, number> = {};
  for (const [name, cfg] of enabled as [string, any][]) {
    normalized[name] = totalWeight > 0
      ? cfg.weight / totalWeight
      : 1 / enabled.length;
  }
  return normalized;
}

/**
 * Build a weight configuration map from an array of property evaluations,
 * optionally applying a disabled list and custom weight overrides.
 *
 * @param {Array<{ property: string, phase: number, weight?: number }>} properties
 *   Array of per-property evaluations.
 * @param {Object} [options={}]
 * @param {string[]}  [options.disabled=[]]      - Property names/IDs to disable
 * @param {Record<string, number>} [options.customWeights={}] - Custom weight overrides by property name/ID
 * @returns {Record<string, PropertyWeightConfig>}
 */
export function buildWeightConfig(properties: any, options: any = {}) {
  const disabled = new Set(
    (options.disabled || []).map((n: string) => n.toLowerCase().trim())
  );
  const customWeights = options.customWeights || {};

  const config: Record<string, any> = {};
  for (const prop of properties) {
    const key = (prop.id || prop.property || '').toLowerCase().replace(/[\s/]+/g, '_');
    const displayKey = prop.id || prop.property || key;

    // Check if this property is in the disabled set
    const isDisabled = disabled.has(key)
      || disabled.has((prop.property || '').toLowerCase())
      || disabled.has(displayKey.toLowerCase());

    // Apply custom weight if provided, otherwise use existing or default
    const baseWeight = customWeights[key]
      ?? customWeights[(prop.property || '').toLowerCase()]
      ?? customWeights[displayKey]
      ?? prop.weight
      ?? DEFAULT_WEIGHT;

    config[displayKey] = {
      weight: baseWeight,
      enabled: !isDisabled,
    };
  }

  return config;
}

// ─── Core Aggregation ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} AggregationResult
 * @property {number}  evolution   - Weighted average evolution position (0–1)
 * @property {number}  confidence  - Aggregation confidence score (0–1)
 * @property {Record<string, number>} weightMap
 *   Final normalized weights used (after toggling/renormalization)
 * @property {AggregationMetadata} metadata
 *   Detailed metadata about the aggregation computation
 */

/**
 * @typedef {Object} AggregationMetadata
 * @property {number}  totalProperties     - Total input properties
 * @property {number}  enabledProperties   - Properties participating in aggregation
 * @property {number}  disabledProperties  - Properties excluded from aggregation
 * @property {number}  validProperties     - Properties with valid phases (1–4)
 * @property {number}  coverage            - Ratio of valid/enabled to total standard (0–1)
 * @property {string}  aggregationMethod   - Method identifier: 'weighted_average'
 * @property {number}  phaseAgreement      - Inter-property phase consistency (0–1)
 * @property {{ 1: number, 2: number, 3: number, 4: number }} phaseDistribution
 *   Count of properties at each phase
 * @property {number}  meanPhase           - Mean phase across evaluated properties
 * @property {number}  weightedPhase       - Weighted mean phase
 * @property {boolean} renormalized        - Whether weight renormalization was applied
 */

/**
 * Aggregate per-property phase evaluations into a single evolution placement.
 *
 * This is the primary aggregation function for solution evaluation. It takes
 * an array of per-property phase scores and computes:
 *   1. Weighted average of phase midpoints → overall evolution value
 *   2. Coverage-based confidence score
 *   3. Detailed aggregation metadata
 *
 * Default behavior: equal weights (1/N), all properties enabled.
 *
 * Advanced behavior (CPC indicator toggle pattern):
 *   - Disable specific properties via `options.disabled`
 *   - Override weights via `options.customWeights`
 *   - Remaining weights are renormalized to sum to 1.0
 *
 * @param {Array<{ property: string, phase: number, weight?: number, id?: string }>} properties
 *   Array of per-property evaluations. Each must have:
 *     - property: Property name (e.g. "Market")
 *     - phase: Evaluated phase (1–4)
 *     - weight: Optional custom weight (default: 1/N)
 *     - id: Optional canonical property ID
 *
 * @param {Object} [options={}]
 * @param {string[]}  [options.disabled=[]]
 *   Property names/IDs to exclude from aggregation. Weights are renormalized.
 * @param {Record<string, number>} [options.customWeights={}]
 *   Override weights by property name/ID. Applied before renormalization.
 * @param {number}  [options.totalExpected=12]
 *   Total expected properties (for coverage calculation). Default: 12.
 *
 * @returns {AggregationResult}
 *   The aggregated evolution result with confidence and metadata.
 *
 * @throws {Error} If properties array is empty or all properties are disabled.
 *
 * @example
 *   // Basic: all 12 properties with equal weights
 *   const result = aggregatePropertyScores([
 *     { property: 'Market', phase: 3 },
 *     { property: 'Knowledge management', phase: 3 },
 *     // ... 10 more
 *   ]);
 *   // → { evolution: 0.55, confidence: 0.85, ... }
 *
 * @example
 *   // With toggling: disable two properties
 *   const result = aggregatePropertyScores(allProperties, {
 *     disabled: ['efficiency', 'decision_driver'],
 *   });
 *   // Remaining 10 properties have renormalized weights summing to 1.0
 *
 * @example
 *   // With custom weights: emphasize market properties
 *   const result = aggregatePropertyScores(allProperties, {
 *     customWeights: { market: 0.2, market_perception: 0.15 },
 *   });
 */
export function aggregatePropertyScores(properties: any, options: any = {}): any {
  if (!Array.isArray(properties) || properties.length === 0) {
    throw new Error('aggregatePropertyScores requires a non-empty array of property evaluations');
  }

  const totalExpected = options.totalExpected ?? STANDARD_PROPERTY_COUNT;
  const hasToggling = Boolean(
    (options.disabled && options.disabled.length > 0)
    || (options.customWeights && Object.keys(options.customWeights).length > 0)
  );

  // Step 1: Build weight configuration with toggling support
  const weightConfig = buildWeightConfig(properties, options);

  // Step 2: Renormalize weights for enabled properties
  const weightMap = renormalizeWeights(weightConfig);

  const enabledKeys = Object.keys(weightMap);
  if (enabledKeys.length === 0) {
    throw new Error('All properties are disabled — cannot aggregate');
  }

  // Step 3: Map properties to their weight keys for lookup
  const propertyByKey = new Map();
  for (const prop of properties) {
    const key = prop.id || prop.property || '';
    propertyByKey.set(key, prop);
    // Also index by lowercased property name
    if (prop.property) {
      propertyByKey.set(prop.property.toLowerCase(), prop);
    }
  }

  // Step 4: Compute weighted sum of evolution midpoints
  let weightedEvolutionSum = 0;
  let weightedPhaseSum = 0;
  let validCount = 0;
  let totalUsedWeight = 0;

  const phaseDistribution = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let phaseSum = 0;
  let enabledEvaluated = 0;

  for (const [key, weight] of Object.entries(weightMap)) {
    // Find the property data for this key
    const prop = propertyByKey.get(key)
      || propertyByKey.get(key.toLowerCase())
      || propertyByKey.get(key.toLowerCase().replace(/[\s/]+/g, '_'));

    if (!prop) continue;

    const phase = prop.phase;
    if (typeof phase !== 'number' || phase < 1 || phase > 4) continue;

    const roundedPhase = Math.round(phase);
    const evolution = PHASE_TO_EVOLUTION[roundedPhase];
    if (evolution === undefined) continue;

    weightedEvolutionSum += evolution * weight;
    weightedPhaseSum += roundedPhase * weight;
    totalUsedWeight += weight;
    validCount++;
    enabledEvaluated++;

    (phaseDistribution as Record<number, number>)[roundedPhase]++;
    phaseSum += roundedPhase;
  }

  if (validCount === 0) {
    throw new Error('No valid property evaluations (all phases must be 1–4)');
  }

  // Step 5: Scale evolution if not all enabled properties were valid
  // (some might have had invalid phases)
  const evolution = totalUsedWeight > 0
    ? Math.round((weightedEvolutionSum / totalUsedWeight) * 1000) / 1000
    : 0;

  const meanPhase = validCount > 0
    ? Math.round((phaseSum / validCount) * 100) / 100
    : 0;

  const weightedPhase = totalUsedWeight > 0
    ? Math.round((weightedPhaseSum / totalUsedWeight) * 100) / 100
    : 0;

  // Step 6: Compute confidence
  const disabledCount = properties.length - enabledKeys.length;
  const coverage = validCount / totalExpected;
  const confidence = computeAggregationConfidence(coverage, phaseDistribution, validCount);

  // Step 7: Compute phase agreement (normalized entropy)
  const phaseAgreement = computePhaseAgreement(phaseDistribution, validCount);

  // Step 8: Build metadata
  const metadata = {
    totalProperties: properties.length,
    enabledProperties: enabledKeys.length,
    disabledProperties: disabledCount,
    validProperties: validCount,
    coverage: Math.round(coverage * 1000) / 1000,
    aggregationMethod: 'weighted_average',
    phaseAgreement,
    phaseDistribution,
    meanPhase,
    weightedPhase,
    renormalized: hasToggling,
  };

  return {
    evolution,
    confidence,
    weightMap,
    metadata,
  };
}

// ─── Confidence Model ───────────────────────────────────────────────────────────

/**
 * Compute aggregation confidence based on:
 *   - Coverage: ratio of evaluated properties to expected total
 *
 * The base confidence model follows the original SolutionBaseStrategy
 * contract: full coverage → MAX_BASE_CONFIDENCE (0.85), partial →
 * proportionally lower. Phase agreement data is available in metadata
 * for higher-level consumers to optionally boost confidence.
 *
 * @param {number} coverage          - Evaluated / total expected (0–1)
 * @param {{ 1: number, 2: number, 3: number, 4: number }} phaseDistribution
 * @param {number} evaluatedCount    - Number of properties with valid evaluations
 * @returns {number} Confidence score (0–1)
 */
function computeAggregationConfidence(coverage: number, phaseDistribution: any, evaluatedCount: number): number {
  // Base confidence from coverage
  // Full coverage → MAX_BASE_CONFIDENCE (0.85)
  // Partial → proportionally lower
  const coverageConfidence = Math.min(MAX_BASE_CONFIDENCE, coverage * MAX_BASE_CONFIDENCE);

  // Clamp to bounds
  const capped = Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, coverageConfidence));

  return Math.round(capped * 1000) / 1000;
}

/**
 * Compute phase agreement metric using normalized entropy.
 *
 * 0 = all properties at the same phase (maximum agreement)
 * 1 = perfectly uniform distribution across all 4 phases (minimum agreement)
 *
 * RETURNS: inverted (1 = max agreement, 0 = uniform distribution)
 *
 * @param {{ 1: number, 2: number, 3: number, 4: number }} distribution
 * @param {number} total - Total count of evaluated properties
 * @returns {number} Phase agreement score (0–1), where 1 = perfect agreement
 */
export function computePhaseAgreement(distribution: any, total: number) {
  if (total === 0) return 0;

  let entropy = 0;
  for (const count of Object.values(distribution) as number[]) {
    if (count > 0) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
  }

  const maxEntropy = Math.log2(4); // 2.0 for 4 phases
  const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

  return Math.round((1 - normalizedEntropy) * 1000) / 1000;
}

// ─── Convenience: Aggregate with PropertyScore instances ────────────────────────

/**
 * Aggregate an array of PropertyScore instances (from solution-evolution-result.mjs).
 *
 * This is a convenience wrapper around aggregatePropertyScores that accepts
 * PropertyScore instances directly, using their toPropertyEvaluation() method
 * for the aggregation input.
 *
 * @param {Array<import('./solution-evolution-result.mjs').PropertyScore>} scores
 *   Array of PropertyScore instances.
 * @param {Object} [options={}] - Same options as aggregatePropertyScores.
 * @returns {AggregationResult}
 */
export function aggregatePropertyScoreInstances(scores: any, options: any = {}): any {
  const propEvals = scores.map((s: any) => {
    if (typeof s.toPropertyEvaluation === 'function') {
      const eval_ = s.toPropertyEvaluation();
      eval_.id = s.id; // Preserve ID for key matching
      return eval_;
    }
    return s;
  });

  return aggregatePropertyScores(propEvals, options);
}

// ─── Shortcut: Simple Equal-Weight Aggregation ──────────────────────────────────

/**
 * Simple equal-weight aggregation without toggling.
 * Backward-compatible with the original SolutionBaseStrategy.aggregateProperties().
 *
 * @param {Array<{ property: string, phase: number, weight?: number }>} properties
 * @returns {{ evolution: number, confidence: number }}
 */
export function simpleAggregate(properties: any[]): any {
  const result = aggregatePropertyScores(properties);
  return {
    evolution: result.evolution,
    confidence: result.confidence,
  };
}
