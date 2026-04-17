// Base strategy interface for solution-level Wardley Map evolution evaluation
//
// Solutions (e.g. Kubernetes, Salesforce, SAP ERP) are concrete products or
// platforms that implement one or more capabilities.  Unlike capability
// strategies — which evaluate the underlying activity/practice/knowledge/data —
// solution strategies evaluate a named solution against a 12-property
// phase reference (Market, Knowledge, Perception, etc.).
//
// Every solution evaluation strategy must extend SolutionBaseStrategy and
// implement evaluate().  Adding a new strategy requires only creating one
// file matching *-strategy.mjs in src/strategies/solution/ — no existing
// code changes are needed.
//
// The returned EvolutionResult follows the SAME contract as capability
// strategies so that consumers (MCP tool, orchestrator, formatters)
// can treat both uniformly.
//
// EvolutionResult shape (identical to capability strategies):
//   {
//     evolution:   number,   // Evolution value, 0–1 (competitive axis)
//     confidence:  number,   // Confidence score 0–1
//     method:      string,   // Strategy identifier (e.g. 'solution-properties')
//     trace:       array     // Trace of reasoning steps (optional)
//   }

import { BaseStrategy } from '../capacity/base-strategy.mjs';
import { aggregatePropertyScores as _aggregatePropertyScores } from './aggregate-properties.mjs';
import type { SolutionInput, SolutionEvolutionResult, PropertyEvaluation, WardleyPhase, PhaseLabel } from '../../../types/solution.mjs';
export type { SolutionInput, SolutionEvolutionResult, PropertyEvaluation };

// ─── Type Definitions ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} SolutionInput
 * @property {string}  name          - Solution / product name (e.g. "Kubernetes")
 * @property {string}  [description] - Enrichable label / semantic hint for the solution
 * @property {string}  [context]     - Business environment where the solution is used (distinct from description — never a fallback for it)
 * @property {string|Date} [date]    - Optional date for temporal context
 * @property {string}  [capability]  - Underlying capability if already identified
 * @property {string}  [nature]      - Capability nature (activity|practice|knowledge|data|none)
 * @property {boolean} [isSolution]  - Routing flag: true when the router determined this is a solution
 * @property {number}  [routerConfidence] - Confidence of the solution/capability classification
 * @property {Object}  [metadata]    - Additional strategy-specific data
 */

/**
 * @typedef {Object} PropertyEvaluation
 * @property {string}  property  - Property name (e.g. "Market")
 * @property {number}  phase     - Evaluated phase (1–4)
 * @property {string}  label     - Phase label (Genesis|Custom|Product|Commodity)
 * @property {number}  weight    - Weight used (default: 1/12)
 * @property {string}  [reason]  - Optional reasoning for this property evaluation
 */

/**
 * @typedef {Object} SolutionEvolutionResult
 * @property {number}  evolution   - Weighted aggregated evolution position (0–1)
 * @property {number}  confidence  - Confidence score (0–1)
 * @property {string}  method      - Strategy identifier string
 * @property {Array}   [trace]     - Trace of reasoning steps (strategy-specific)
 * @property {PropertyEvaluation[]} [properties] - Per-property breakdown (solution-specific extension)
 */

// ─── Phase ↔ Evolution Mapping ─────────────────────────────────────────────────

/**
 * Map a discrete phase (1–4) to a continuous evolution midpoint.
 *
 * Phase 1 (Genesis)   → midpoint 0.09
 * Phase 2 (Custom)    → midpoint 0.29
 * Phase 3 (Product)   → midpoint 0.55
 * Phase 4 (Commodity) → midpoint 0.85
 *
 * These midpoints match the Wardley axis ranges:
 *   Genesis [0, 0.18] | Custom [0.18, 0.40] | Product [0.40, 0.70] | Commodity [0.70, 1.0]
 */
const PHASE_TO_EVOLUTION = {
  1: 0.09,
  2: 0.29,
  3: 0.55,
  4: 0.85,
};

const PHASE_LABELS = {
  1: 'Genesis',
  2: 'Custom',
  3: 'Product',
  4: 'Commodity',
};

// ─── SolutionBaseStrategy ──────────────────────────────────────────────────────

/**
 * Abstract base class for solution evolution evaluation strategies.
 *
 * Subclasses MUST override:
 *   - evaluate(component) → EvolutionResult (or SolutionEvolutionResult)
 *   - static get method() → string
 *
 * The base class provides:
 *   - validateResult()     — same validation as BaseStrategy (contract compatibility)
 *   - phaseToEvolution()   — convert discrete phase (1–4) to continuous evolution
 *   - phaseLabel()         — human-readable phase label
 *   - aggregateProperties() — weighted aggregation of per-property phase evaluations
 *
 * The EvolutionResult contract is enforced at runtime via validateResult()
 * from the parent BaseStrategy, ensuring full interoperability with the
 * existing capability evaluation pipeline.
 */
export class SolutionBaseStrategy extends BaseStrategy {

  /**
   * Strategy identifier. Must be overridden by each subclass.
   * @returns {string}
   */
  static get method(): string {
    throw new Error('SolutionBaseStrategy.method must be overridden by subclass');
  }

  /**
   * Evaluate a solution component and return its evolution position.
   * Must be overridden by every solution strategy.
   *
   * @param {SolutionInput} component - The solution to evaluate
   * @returns {Promise<SolutionEvolutionResult>} Result conforming to EvolutionResult contract
   */
  async evaluate(component: SolutionInput): Promise<SolutionEvolutionResult> {
    throw new Error(`${this.constructor.name}.evaluate() must be implemented`);
  }

  // ─── Utility Methods for Subclasses ──────────────────────────────────────

  /**
   * Convert a discrete phase (1–4) to a continuous evolution value (0–1).
   *
   * @param {number} phase - Phase number (1 = Genesis, 2 = Custom, 3 = Product, 4 = Commodity)
   * @returns {number} Evolution midpoint for the phase
   * @throws {Error} If phase is not in [1, 4]
   */
  static phaseToEvolution(phase: number): number {
    const rounded = Math.round(phase) as WardleyPhase;
    if (rounded < 1 || rounded > 4) {
      throw new RangeError(`Phase must be between 1 and 4, got ${phase}`);
    }
    return PHASE_TO_EVOLUTION[rounded];
  }

  /**
   * Get the human-readable label for a phase.
   *
   * @param {number} phase - Phase number (1–4)
   * @returns {string} Label: 'Genesis' | 'Custom' | 'Product' | 'Commodity'
   */
  static phaseLabel(phase: number): string {
    const rounded = Math.round(phase);
    return (PHASE_LABELS as Record<number, string>)[rounded] || 'Unknown';
  }

  /**
   * Aggregate per-property phase evaluations into a single evolution value.
   *
   * Each property contributes equally (weight = 1/N where N = number of
   * properties).  Subclasses may override this to apply custom weighting
   * or non-linear aggregation.
   *
   * Delegates to aggregate-properties.mjs for the core computation, which
   * supports the CPC indicator toggling pattern (disable properties,
   * custom weights, weight renormalization).
   *
   * @param {PropertyEvaluation[]} properties - Array of per-property evaluations
   * @param {Object} [options={}] - Advanced aggregation options
   * @param {string[]}  [options.disabled=[]]        - Property names/IDs to exclude
   * @param {Record<string, number>} [options.customWeights={}] - Custom weight overrides
   * @param {number}  [options.totalExpected=12]      - Expected total properties
   * @returns {{ evolution: number, confidence: number }}
   *   - evolution: weighted average of phase midpoints, rounded to 3 decimals
   *   - confidence: coverage-based confidence (proportion of properties evaluated)
   */
  static aggregateProperties(properties: PropertyEvaluation[], options?: { mode?: string; method?: string }): { evolution: number; confidence: number } {
    const result = _aggregatePropertyScores(properties, options);
    return { evolution: result.evolution, confidence: result.confidence };
  }

  /**
   * Extended aggregation returning full metadata, weight map, and phase statistics.
   *
   * This is the advanced entry point for strategies that need detailed
   * aggregation information (e.g. for tracing, debugging, or UI display).
   *
   * @param {PropertyEvaluation[]} properties - Array of per-property evaluations
   * @param {Object} [options={}] - Same options as aggregateProperties
   * @returns {import('./aggregate-properties.mjs').AggregationResult}
   */
  // any: returns the rich aggregation bag from aggregatePropertyScores (not a SolutionEvolutionResult instance)
  static aggregatePropertiesFull(properties: PropertyEvaluation[], options?: { mode?: string; method?: string }): any {
    return _aggregatePropertyScores(properties, options);
  }

  /**
   * Build a PropertyEvaluation entry for a single property.
   * Convenience factory for subclasses.
   *
   * @param {string} property - Property name (e.g. "Market")
   * @param {number} phase    - Phase (1–4)
   * @param {string} [reason] - Optional reasoning
   * @returns {PropertyEvaluation}
   */
  static buildPropertyEvaluation(property: string, phase: number, reason?: string): PropertyEvaluation {
    const rounded = Math.round(Math.max(1, Math.min(4, phase))) as WardleyPhase;
    return {
      property,
      phase: rounded,
      label: SolutionBaseStrategy.phaseLabel(rounded) as PhaseLabel,
      weight: 1 / 12,  // Default: 12 properties with equal weight
      ...(reason != null && { reason }),
    };
  }

  /**
   * Validate and return a result conforming to the EvolutionResult contract.
   * Delegates to BaseStrategy.validateResult() for contract compatibility,
   * then optionally validates solution-specific extensions.
   *
   * @param {SolutionEvolutionResult} result
   * @returns {SolutionEvolutionResult} the validated result (pass-through)
   */
  static validateSolutionResult(result: SolutionEvolutionResult): SolutionEvolutionResult {
    // First: enforce the core EvolutionResult contract
    BaseStrategy.validateResult(result);

    // Then: validate solution-specific extensions if present
    if (result.properties != null) {
      if (!Array.isArray(result.properties)) {
        throw new TypeError('SolutionEvolutionResult.properties must be an array');
      }
      for (const prop of result.properties) {
        if (typeof prop.property !== 'string' || prop.property.length === 0) {
          throw new TypeError('Each property evaluation must have a non-empty property name');
        }
        if (typeof prop.phase !== 'number' || prop.phase < 1 || prop.phase > 4) {
          throw new TypeError(
            `Property "${prop.property}" phase must be 1–4, got ${prop.phase}`
          );
        }
      }
    }

    return result;
  }
}

// ─── Re-export constants for consumer convenience ──────────────────────────

export { PHASE_TO_EVOLUTION, PHASE_LABELS };
