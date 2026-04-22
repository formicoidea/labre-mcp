// Base strategy for inventing a value-chain component from context where the
// component label/type is NOT provided in the input.
//
// Namespace: write:component:<strategy>
//
// Typical write-component strategies rely on naming conventions, LLM-based
// identification, or cross-referencing solution catalogs to produce a
// component description from a bare name or context snippet.
//
// Result shape is intentionally left as `unknown` for now — the concrete
// Component type will be pinned when the first real strategy lands.

// any: placeholder input bag until the first concrete strategy pins the shape
export type ComponentWriteInput = any;

// any: placeholder result until the first concrete strategy pins the shape
export type ComponentCandidate = any;

export class BaseComponentWriteStrategy {
  /**
   * Strategy identifier in "write:component:<strategy>" form.
   * Must be overridden by each subclass.
   */
  static get method(): string {
    throw new Error('BaseComponentWriteStrategy.method must be overridden by subclass');
  }

  /**
   * Disabled flag. Return falsy to enable (default), or `{ reason: string }`
   * to disable. The registry filters disabled strategies out of loadStrategies().
   */
  static get disabled(): boolean | { reason: string } { return false; }

  /**
   * Invent a component description from the provided context.
   * Must be overridden by every strategy.
   */
  identify(input: ComponentWriteInput): ComponentCandidate | Promise<ComponentCandidate> {
    throw new Error(`${this.constructor.name}.identify() must be implemented`);
  }
}
