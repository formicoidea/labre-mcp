// Base strategy for refining a value-chain anchor that is ALREADY provided in
// the input — correcting, raffining or validating an existing anchor
// description rather than inventing one from scratch.
//
// Namespace: read:anchor:<strategy>
//
// Read strategies differ from write strategies in that the target parameter
// (the anchor) is supplied as input. The strategy produces a corrected /
// refined / validated variant.
//
// No concrete read-anchor strategies exist yet — this base + registry is a
// slot for future additions.

// any: placeholder input bag until the first concrete strategy pins the shape
export type AnchorReadInput = any;

// any: placeholder result until the first concrete strategy pins the shape
export type AnchorRefinement = any;

export class BaseAnchorReadStrategy {
  /**
   * Strategy identifier in "read:anchor:<strategy>" form.
   * Must be overridden by each subclass.
   */
  static get method(): string {
    throw new Error('BaseAnchorReadStrategy.method must be overridden by subclass');
  }

  /**
   * Disabled flag. Return falsy to enable (default), or `{ reason: string }`
   * to disable.
   */
  static get disabled(): boolean | { reason: string } { return false; }

  /**
   * Refine / correct / validate an anchor that is already provided in input.
   * Must be overridden by every strategy.
   */
  refine(input: AnchorReadInput): AnchorRefinement | Promise<AnchorRefinement> {
    throw new Error(`${this.constructor.name}.refine() must be implemented`);
  }
}
