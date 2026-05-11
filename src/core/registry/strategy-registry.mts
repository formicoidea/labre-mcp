// Generic strategy registry. Concrete strategy registries (capacity, solution,
// layout, ...) instantiate this with their TStrategy class type. The registry
// holds a map keyed by 5-segment methodId (ARCH-03) and is populated by
// framework-level register*Strategies() functions called at daemon boot.
//
// Validation: methodIds must match the 5-segment shape. The kernel does not
// enforce per-segment values — that is the framework's responsibility.

import { type BaseStrategy, METHOD_ID_5_SEGMENT_REGEX } from "../ast/base-strategy.mjs";

// any: strategy class type — concrete subclasses extend BaseStrategy with their own
// input/output types AND constructor signatures (some take {llmCall}, some take no args).
// The registry stays purely structural to accommodate that variance.
type StrategyClass<TStrategy extends BaseStrategy = BaseStrategy> = new (
  // any: per-strategy constructor args are open
  ...args: any[]
) => TStrategy;

export function validateMethodId(methodId: string): void {
  if (!METHOD_ID_5_SEGMENT_REGEX.test(methodId)) {
    throw new Error(
      `Invalid methodId "${methodId}": expected 5 colon-separated segments {framework}:{tool}:{command}:{subdomain}:{strategy}, each lowercase alphanum/dash starting with a letter`,
    );
  }
}

export class StrategyRegistry<TStrategy extends BaseStrategy = BaseStrategy> {
  private readonly map = new Map<string, StrategyClass<TStrategy>>();

  register(methodId: string, strategyClass: StrategyClass<TStrategy>): void {
    validateMethodId(methodId);
    if (this.map.has(methodId)) {
      throw new Error(`Strategy "${methodId}" already registered`);
    }
    this.map.set(methodId, strategyClass);
  }

  get(methodId: string): StrategyClass<TStrategy> {
    const cls = this.map.get(methodId);
    if (!cls) {
      throw new Error(
        `Unknown strategy "${methodId}" (registered: ${this.list().join(", ") || "none"})`,
      );
    }
    return cls;
  }

  has(methodId: string): boolean {
    return this.map.has(methodId);
  }

  list(): string[] {
    return [...this.map.keys()].sort();
  }

  size(): number {
    return this.map.size;
  }
}
