// Base strategy for inventing a value-chain anchor (user + need) from context
// where the anchor is NOT provided in the input.
//
// Namespace: write:anchor:<strategy>
//
// Every anchor-writing strategy must extend this class and implement identify().
// The method identifier follows the convention "<mode>:<family>:<strategy>",
// e.g. "write:anchor:top-down", "write:anchor:interview".
//
// Result shape is intentionally left as `unknown` for now — the concrete
// AnchorCandidate type will be pinned when the first real strategy lands.

// any: placeholder input bag until the first concrete strategy pins the shape
export type AnchorWriteInput = any;

// any: placeholder result until the first concrete strategy pins the shape
export type AnchorCandidate = any;

export class BaseAnchorWriteStrategy {
  /**
   * Strategy identifier in "write:anchor:<strategy>" form.
   * Must be overridden by each subclass.
   */
  static get method(): string {
    throw new Error('BaseAnchorWriteStrategy.method must be overridden by subclass');
  }

  /**
   * Disabled flag. Return falsy to enable (default), or `{ reason: string }`
   * to disable. The registry filters disabled strategies out of loadStrategies().
   */
  static get disabled(): boolean | { reason: string } { return false; }

  /**
   * Invent an anchor (user + need) from the provided context.
   * Must be overridden by every strategy.
   */
  identify(input: AnchorWriteInput): AnchorCandidate | Promise<AnchorCandidate> {
    throw new Error(`${this.constructor.name}.identify() must be implemented`);
  }
}
