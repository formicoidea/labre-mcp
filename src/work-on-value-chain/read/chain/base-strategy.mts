// Base strategy for refining a value chain that is ALREADY provided in the
// input — correcting, raffining or validating an existing chain rather than
// building one from scratch.
//
// Namespace: read:chain:<strategy>
//
// Read strategies differ from write strategies in that the target parameter
// (the value chain) is supplied as input. The strategy produces a corrected /
// refined / validated variant.
//
// No concrete read-chain strategies exist yet — this base + registry is a
// slot for future additions.

// any: placeholder input bag until the first concrete strategy pins the shape
export type ChainReadInput = any;

// any: placeholder result until the first concrete strategy pins the shape
export type ChainRefinement = any;

export class BaseChainReadStrategy {
  /**
   * Strategy identifier in "read:chain:<strategy>" form.
   * Must be overridden by each subclass.
   */
  static get method(): string {
    throw new Error('BaseChainReadStrategy.method must be overridden by subclass');
  }

  /**
   * Disabled flag. Return falsy to enable (default), or `{ reason: string }`
   * to disable.
   */
  static get disabled(): boolean | { reason: string } { return false; }

  /**
   * Refine / correct / validate a value chain that is already provided in input.
   * Must be overridden by every strategy.
   */
  refine(input: ChainReadInput): ChainRefinement | Promise<ChainRefinement> {
    throw new Error(`${this.constructor.name}.refine() must be implemented`);
  }
}
