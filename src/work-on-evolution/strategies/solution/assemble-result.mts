// Solution result assembler: enriches raw solution strategy outputs
// with structured metadata from SolutionEvolutionResult.
//
// This module sits between the strategy evaluation (PropertiesStrategy.evaluate())
// and the evaluations map returned by dispatchSolutionStrategies().
// It transforms raw EvolutionResult-compatible outputs into rich
// SolutionEvolutionResult objects with:
//   - Phase distribution breakdown (how many properties at each phase)
//   - Mean phase across all properties
//   - Confidence metadata (coverage, evaluation mode, aggregation method)
//   - Wardley stage label (Genesis/Custom/Product/Commodity)
//   - Full interoperability with the capability EvolutionResult contract
//
// The assembler is extensible: any solution strategy that returns
// { evolution, confidence, method, properties? } will be enriched.
// Strategies that don't produce properties (e.g. a future market-data
// strategy) pass through unchanged.
//
// Usage:
//   import { assembleSolutionResult } from './assemble-result.mjs';
//   const enriched = assembleSolutionResult(rawResult, { mode: 'auto' });

import {
  SolutionEvolutionResult,
  PropertyScore,
  ConfidenceMetadata,
  PROPERTY_COUNT,
  PROPERTY_NAME_TO_ID,
} from './solution-evolution-result.mjs';
import { PHASE_LABELS } from './solution-base-strategy.mjs';

// ─── Phase Distribution Helper ──────────────────────────────────────────────

/**
 * Compute phase distribution from an array of property evaluations.
 *
 * @param {Array<{ phase: number }>} properties
 * @returns {{ 1: number, 2: number, 3: number, 4: number }}
 */
function computePhaseDistribution(properties: any[]): Record<number, number> {
  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const prop of properties) {
    const p = Math.round(prop.phase);
    if (p >= 1 && p <= 4) dist[p]++;
  }
  return dist;
}

/**
 * Compute the dominant phase (mode) from a distribution.
 *
 * @param {{ 1: number, 2: number, 3: number, 4: number }} distribution
 * @returns {{ phase: number, count: number, label: string }}
 */
function dominantPhase(distribution: any) {
  let maxPhase = 1;
  let maxCount = 0;
  for (const [phase, count] of Object.entries(distribution) as [string, number][]) {
    if (count > maxCount) {
      maxCount = count;
      maxPhase = parseInt(phase, 10);
    }
  }
  return {
    phase: maxPhase,
    count: maxCount,
    label: (PHASE_LABELS as Record<number, string>)[maxPhase] || 'Unknown',
  };
}

/**
 * Compute mean phase across evaluated properties.
 *
 * @param {Array<{ phase: number }>} properties
 * @returns {number} Mean phase (1–4), rounded to 2 decimals
 */
function computeMeanPhase(properties: any[]): number {
  if (properties.length === 0) return 0;
  const sum = properties.reduce((s: number, p: any) => s + (p.phase || 0), 0);
  return Math.round((sum / properties.length) * 100) / 100;
}

// ─── Assembler ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AssemblyOptions
 * @property {string}  [mode='auto']    - Evaluation mode ('auto' | 'conversational')
 * @property {boolean} [enrichMetadata=true] - Whether to add phase distribution and confidence metadata
 */

/**
 * Assemble a solution strategy result into a rich, structured format.
 *
 * Takes a raw EvolutionResult (as returned by a solution strategy's evaluate())
 * and enriches it with:
 *   - `stage`: Wardley stage label (Genesis/Custom/Product/Commodity)
 *   - `meanPhase`: average phase across properties
 *   - `phaseDistribution`: count per phase { 1: n, 2: n, 3: n, 4: n }
 *   - `dominantPhase`: the most common phase
 *   - `confidenceMetadata`: structured metadata about confidence computation
 *
 * If the result already has rich metadata (e.g. it's a SolutionEvolutionResult),
 * the assembler preserves existing metadata and only fills gaps.
 *
 * If the result has no properties array (e.g. a non-property-based strategy),
 * it passes through with only the stage label added.
 *
 * @param {Object} rawResult - Raw strategy evaluation result
 *   Must conform to EvolutionResult: { evolution, confidence, method, trace?, properties? }
 * @param {AssemblyOptions} [options={}]
 * @returns {Object} Enriched result with all original fields plus metadata
 */
export function assembleSolutionResult(rawResult: any, options: any = {}): any {
  if (!rawResult || rawResult.error) {
    // Error results pass through unchanged
    return rawResult;
  }

  const { mode = 'auto', enrichMetadata = true } = options;

  // Start with a copy of the raw result (preserve all original fields)
  const enriched = { ...rawResult };

  // Add Wardley stage label
  enriched.stage = resolveStage(rawResult.evolution);

  // If no properties, return with just the stage
  if (!Array.isArray(rawResult.properties) || rawResult.properties.length === 0) {
    return enriched;
  }

  if (!enrichMetadata) {
    return enriched;
  }

  // Compute phase distribution
  const distribution = computePhaseDistribution(rawResult.properties);
  enriched.phaseDistribution = distribution;

  // Compute mean phase
  enriched.meanPhase = computeMeanPhase(rawResult.properties);

  // Compute dominant phase
  enriched.dominantPhase = dominantPhase(distribution);

  // Build confidence metadata if not already present
  if (!enriched.confidenceMetadata) {
    const evaluatedProperties = rawResult.properties.filter(
      (p: any) => !p.reason?.startsWith('Not evaluated')
    );
    const evaluatedCount = evaluatedProperties.length || rawResult.properties.length;
    const coverage = evaluatedCount / PROPERTY_COUNT;

    enriched.confidenceMetadata = {
      coverage: Math.round(coverage * 1000) / 1000,
      evaluatedCount,
      totalCount: PROPERTY_COUNT,
      mode,
      aggregationMethod: 'weighted_average',
    };
  }

  // Ensure each property has a label
  enriched.properties = rawResult.properties.map((prop: any) => {
    if (prop.label) return prop;
    return {
      ...prop,
      label: (PHASE_LABELS as Record<number, string>)[Math.round(prop.phase)] || `Phase ${prop.phase}`,
    };
  });

  return enriched;
}

/**
 * Assemble multiple solution strategy results into a unified evaluations map.
 *
 * This is the batch version of assembleSolutionResult, designed to be called
 * after all solution strategies have evaluated. It enriches each result
 * individually and returns the enriched evaluations map.
 *
 * @param {Object<string, Object>} evaluations - Map of method → raw result
 * @param {AssemblyOptions} [options={}]
 * @returns {Object<string, Object>} Map of method → enriched result
 */
export function assembleSolutionEvaluations(evaluations: Record<string, any>, options: any = {}): Record<string, any> {
  const assembled: Record<string, any> = {};
  for (const [method, result] of Object.entries(evaluations)) {
    assembled[method] = assembleSolutionResult(result, options);
  }
  return assembled;
}

/**
 * Build a structured SolutionEvolutionResult instance from a raw result.
 *
 * This is the full-model version that creates a proper SolutionEvolutionResult
 * with PropertyScore instances and ConfidenceMetadata. Use this when you need
 * the full structured API (e.g. for validation, serialization, or rich display).
 *
 * For lighter-weight enrichment that keeps plain objects, use assembleSolutionResult.
 *
 * @param {Object} rawResult - Raw strategy evaluation result with properties
 * @param {Object} [options={}]
 * @param {string} [options.mode='auto'] - Evaluation mode
 * @returns {SolutionEvolutionResult}
 * @throws {Error} If rawResult doesn't have required fields or properties
 */
export function buildStructuredResult(rawResult: any, options: any = {}): any {
  if (!rawResult || rawResult.error) {
    throw new Error('Cannot build structured result from error or null result');
  }

  const { mode = 'auto' } = options;

  // Convert properties to PropertyScore instances
  const scores = (rawResult.properties || []).map((prop: any) => {
    const id = PROPERTY_NAME_TO_ID.get(prop.property?.toLowerCase())
      || prop.id
      || prop.property?.toLowerCase().replace(/[\s/]+/g, '_')
      || 'unknown';

    return PropertyScore.create(
      id,
      prop.property || id,
      prop.phase,
      prop.reason,
      {
        confidence: prop.confidence,
        phaseDescription: prop.phaseDescription,
        weight: prop.weight,
      }
    );
  });

  // Build structured result using the factory
  if (scores.length > 0) {
    return SolutionEvolutionResult.fromPropertyScores(scores, {
      method: rawResult.method,
      mode,
      trace: rawResult.trace || [],
    });
  }

  // No properties: direct construction
  return new SolutionEvolutionResult({
    evolution: rawResult.evolution,
    confidence: rawResult.confidence,
    method: rawResult.method,
    trace: rawResult.trace || [],
  });
}

// ─── Stage Resolution ──────────────────────────────────────────────────────

/**
 * Resolve the Wardley stage label from an evolution value.
 *
 * @param {number} evolution - Evolution value (0–1)
 * @returns {string} Stage label: 'Genesis' | 'Custom' | 'Product' | 'Commodity'
 */
function resolveStage(evolution: number): string {
  if (typeof evolution !== 'number' || Number.isNaN(evolution)) return 'Unknown';
  if (evolution < 0.18) return 'Genesis';
  if (evolution < 0.40) return 'Custom';
  if (evolution < 0.70) return 'Product';
  return 'Commodity';
}

export { resolveStage, computePhaseDistribution, computeMeanPhase, dominantPhase };
