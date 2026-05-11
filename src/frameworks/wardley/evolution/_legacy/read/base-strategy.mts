// Base strategy for refining a component's evolution position that is ALREADY
// provided in the input — correcting, raffining or validating an existing
// position rather than inventing one from scratch.
//
// Namespace: read:evolution:<strategy>
//
// Read strategies differ from write strategies in that the target parameter
// (the evolution position) is supplied as input. The strategy produces a
// corrected / refined / validated variant (e.g. a pedagogical re-evaluation
// that explains discrepancies between the input position and the strategy's
// own estimate).
//
// No concrete read-evolution strategies exist yet — this base + registry is a
// slot for future additions.

// any: placeholder input bag until the first concrete strategy pins the shape
export type EvolutionReadInput = any;

// any: placeholder result until the first concrete strategy pins the shape
export type EvolutionRefinement = any;

export class BaseEvolutionReadStrategy {
  /**
   * Strategy identifier in "read:evolution:<strategy>" form.
   * Must be overridden by each subclass.
   */
  static get method(): string {
    throw new Error('BaseEvolutionReadStrategy.method must be overridden by subclass');
  }

  /**
   * Disabled flag. Return falsy to enable (default), or `{ reason: string }`
   * to disable.
   */
  static get disabled(): boolean | { reason: string } { return false; }

  /**
   * Refine / correct / validate an evolution position that is already provided
   * in input. Must be overridden by every strategy.
   */
  refine(input: EvolutionReadInput): EvolutionRefinement | Promise<EvolutionRefinement> {
    throw new Error(`${this.constructor.name}.refine() must be implemented`);
  }
}
