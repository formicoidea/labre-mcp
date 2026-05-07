// Base strategy for inventing a value chain (components + needs links) from
// context where the chain is NOT provided in the input.
//
// Namespace: write:chain:<strategy>
//
// Typical write-chain strategies decompose an anchor into upstream capabilities,
// extract components from a narrative, or assemble a chain from a partial
// component list.
//
// Result shape is intentionally left as `unknown` for now — the concrete
// ValueChain type will be pinned when the first real strategy lands.

// any: placeholder input bag until the first concrete strategy pins the shape
export type ChainWriteInput = any;

// any: placeholder result until the first concrete strategy pins the shape
export type ValueChain = any;

export class BaseChainWriteStrategy {
  /**
   * Strategy identifier in "write:chain:<strategy>" form.
   * Must be overridden by each subclass.
   */
  static get method(): string {
    throw new Error('BaseChainWriteStrategy.method must be overridden by subclass');
  }

  /**
   * Disabled flag. Return falsy to enable (default), or `{ reason: string }`
   * to disable. The registry filters disabled strategies out of loadStrategies().
   */
  static get disabled(): boolean | { reason: string } { return false; }

  /**
   * Invent a value chain from the provided context.
   * Must be overridden by every strategy.
   */
  build(input: ChainWriteInput): ValueChain | Promise<ValueChain> {
    throw new Error(`${this.constructor.name}.build() must be implemented`);
  }
}
