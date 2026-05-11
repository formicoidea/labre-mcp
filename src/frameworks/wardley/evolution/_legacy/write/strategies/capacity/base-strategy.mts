// Base strategy interface for Wardley Map evolution evaluation
//
// Every evaluation strategy must extend BaseStrategy and implement evaluate().
// Adding a new strategy requires only creating one file — no existing code changes.
//
// EvolutionResult shape:
//   {
//     evolution:  number,  // Evolution value, typically 0–1 (competitive) or outside (extra-competitive)
//     confidence: number,  // Confidence score 0–1
//     method:     string   // Strategy identifier (e.g. 's-curve', 'pub-distribution')
//   }

import type { EvolutionResult, ComponentInput } from '#types/evolution.mjs';
import type { EvaluationInput } from '#schemas/inputs.schema.mjs';
export type { EvolutionResult, ComponentInput };

/**
 * @typedef {Object} EvolutionResult
 * @property {number} evolution  - Evolution position (0–1 competitive, outside = extra-competitive)
 * @property {number} confidence - Confidence score (0–1)
 * @property {string} method     - Strategy identifier string
 * @property {array} trace    - trace of reasoning steps, strategy-specific format (optional)
 */

/**
 * @typedef {Object} ComponentInput
 * @property {string}  name        - Component name
 * @property {number}  [certitude] - Certitude score (0–1)
 * @property {number}  [ubiquity]  - Ubiquity score (0–1)
 * @property {number}  [wonder]    - Wonder publication proportion
 * @property {number}  [build]     - Build publication proportion
 * @property {number}  [operate]   - Operate publication proportion
 * @property {number}  [usage]     - Usage publication proportion
 * @property {string}  [description] - Free-text component description
 * @property {string|Date} [date]    - Optional date for context (e.g. when component is to observe)
 * @property {string}  [capability] - Underlying capability (activity/practice/knowledge/data) identified by orchestrator
 * @property {string}  [nature]    - Capability nature: activity|practice|knowledge|data|none
 * @property {Object}  [metadata]  - Additional strategy-specific data
 */

/**
 * Abstract base class for evolution evaluation strategies.
 *
 * Subclasses MUST override:
 *   - evaluate(component) → EvolutionResult
 *   - static get method() → string
 *
 * The base class enforces the EvolutionResult contract at runtime via
 * validateResult(), which strategies can call or which is checked by
 * the evaluation orchestrator.
 */
export class BaseStrategy {

  /**
   * Strategy identifier. Must be overridden by each subclass.
   * @returns {string}
   */
  static get method(): string {
    throw new Error('BaseStrategy.method must be overridden by subclass');
  }

  /**
   * Disabled flag. Return falsy to enable (default), or `{ reason: string }`
   * to disable. The registry filters disabled strategies out of
   * loadStrategies()/getStrategy()/listStrategies() and exposes them via
   * listDisabled()/isDisabled(). To disable a strategy, override this getter
   * in the subclass — no other code changes needed.
   *
   * @returns {false | { reason: string }}
   */
  static get disabled(): boolean | { reason: string } { return false; }

  /**
   * Evaluate a component and return its evolution position.
   * Must be overridden by every strategy.
   *
   * @param {ComponentInput} component
   * @returns {EvolutionResult}
   */
  evaluate(component: EvaluationInput): EvolutionResult | Promise<EvolutionResult> {
    throw new Error(`${this.constructor.name}.evaluate() must be implemented`);
  }

  /**
   * Validate that a result conforms to the EvolutionResult interface.
   * Throws on invalid shape — call from evaluate() or from the orchestrator.
   *
   * @param {*} result
   * @returns {EvolutionResult} the validated result (pass-through)
   */
  static validateResult(result: unknown): EvolutionResult {
    if (result === null || typeof result !== 'object') {
      throw new TypeError('EvolutionResult must be a non-null object');
    }

    const { evolution, confidence, method, trace } = result as Partial<EvolutionResult>;

    if (typeof evolution !== 'number' || Number.isNaN(evolution)) {
      throw new TypeError(`EvolutionResult.evolution must be a number, got ${evolution}`);
    }
    if (typeof confidence !== 'number' || Number.isNaN(confidence) ||
        confidence < 0 || confidence > 1) {
      throw new TypeError(
        `EvolutionResult.confidence must be a number in [0, 1], got ${confidence}`
      );
    }
    if (typeof method !== 'string' || method.length === 0) {
      throw new TypeError(`EvolutionResult.method must be a non-empty string, got ${method}`);
    }

    return result as EvolutionResult;
  }
}
