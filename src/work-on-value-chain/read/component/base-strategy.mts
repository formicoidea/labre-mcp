// Base strategy for refining a value-chain component that is ALREADY provided
// in the input — correcting, raffining or validating an existing component
// description rather than inventing one from scratch.
//
// Namespace: read:component:<strategy>
//
// Read strategies differ from write strategies in that the target parameter
// (the component label/type) is supplied as input. The strategy produces a
// corrected / refined / validated variant.
//
// No concrete read-component strategies exist yet — this base + registry is a
// slot for future additions.

// any: placeholder input bag until the first concrete strategy pins the shape
export type ComponentReadInput = any;

// any: placeholder result until the first concrete strategy pins the shape
export type ComponentRefinement = any;

export class BaseComponentReadStrategy {
  /**
   * Strategy identifier in "read:component:<strategy>" form.
   * Must be overridden by each subclass.
   */
  static get method(): string {
    throw new Error('BaseComponentReadStrategy.method must be overridden by subclass');
  }

  /**
   * Disabled flag. Return falsy to enable (default), or `{ reason: string }`
   * to disable.
   */
  static get disabled(): boolean | { reason: string } { return false; }

  /**
   * Refine / correct / validate a component that is already provided in input.
   * Must be overridden by every strategy.
   */
  refine(input: ComponentReadInput): ComponentRefinement | Promise<ComponentRefinement> {
    throw new Error(`${this.constructor.name}.refine() must be implemented`);
  }
}
