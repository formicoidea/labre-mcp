// Generic strategy registry. Concrete strategy registries (capacity, solution,
// layout, ...) instantiate this with their TStrategy class type. The registry
// holds a map keyed by 5-segment methodId (ast-schema.md v0.1.0, ARCH-25) and
// is populated by framework-level register*Strategies() functions called at
// daemon boot.
//
// Validation: methodIds must match the 5-segment shape with optional @x.y.z
// SemVer suffix. The kernel does not enforce per-segment values — that is the
// framework's responsibility.

import {
  type BaseStrategy,
  type StrategyDisabledFlag,
  METHOD_ID_5_SEGMENT_REGEX,
} from "../ast/base-strategy.mjs";

// any: strategy class type — concrete subclasses extend BaseStrategy with their own
// input/output types. The registry stays purely structural to accommodate that
// variance; the recipe runner instantiates every strategy with no arguments.
type StrategyClass<TStrategy extends BaseStrategy = BaseStrategy> = (new (
  // any: per-strategy constructor args are open
  ...args: any[]
) => TStrategy) & {
  // Optional opt-out declared by the class itself — read once at registration.
  disabled?: StrategyDisabledFlag;
};

export function validateMethodId(methodId: string): void {
  if (!METHOD_ID_5_SEGMENT_REGEX.test(methodId)) {
    throw new Error(
      `Invalid methodId "${methodId}": expected 5 colon-separated segments {domain}:{tool}:{sous-domaine}:{command}:{strategie} with optional @x.y.z SemVer suffix, each segment lowercase alphanum/dash starting with a letter`,
    );
  }
}

/** What a registered methodId IS, from the catalogue's point of view.
 *  `mock` means the strategy answers with deterministic scaffold data so a
 *  recipe can run end-to-end; its output describes the I/O contract a future
 *  real strategy must honour, and describes nothing about the caller's map. */
export type StrategyImplementation = "real" | "mock";

/** One catalogue row: the methodId, whether it really computes, and why it
 *  refuses to resolve when it does. Everything a caller needs to decide
 *  whether to trust an answer BEFORE spending a call on it. */
export interface StrategyCatalogEntry {
  methodId: string;
  implementation: StrategyImplementation;
  /** Present only when the strategy is registered but refuses to resolve. */
  disabledReason?: string;
}

export class StrategyRegistry<TStrategy extends BaseStrategy = BaseStrategy> {
  private readonly map = new Map<string, StrategyClass<TStrategy>>();
  // methodId → reason. A disabled strategy stays in `map` (it IS part of the
  // catalogue) but is refused at resolution — see get().
  private readonly disabled = new Map<string, string>();
  // methodIds registered through registerMock(). Provenance is DECLARED at the
  // composition root that knows it (frameworks/fixtures-registry.mts), never
  // guessed from a class name: a naming convention is not a contract, and the
  // catalogue this feeds (CH-24) is read by third-party harnesses deciding
  // whether an answer is real.
  private readonly mocks = new Set<string>();

  register(methodId: string, strategyClass: StrategyClass<TStrategy>): void {
    validateMethodId(methodId);
    if (this.map.has(methodId)) {
      throw new Error(`Strategy "${methodId}" already registered`);
    }
    this.map.set(methodId, strategyClass);
    const flag = strategyClass.disabled;
    if (flag) {
      const reason =
        typeof flag === "object" && typeof flag.reason === "string" && flag.reason.length > 0
          ? flag.reason
          : "no reason given";
      this.disabled.set(methodId, reason);
    }
  }

  /**
   * Register a SCAFFOLD strategy — same registration, plus the provenance.
   * Behaviour on the wire is identical to `register()`; the only difference is
   * that `catalogue()` reports the entry as `mock`, so a caller can tell a
   * deterministic placeholder from a real computation without running it.
   */
  registerMock(methodId: string, strategyClass: StrategyClass<TStrategy>): void {
    this.register(methodId, strategyClass);
    this.mocks.add(methodId);
  }

  /** True when the methodId was registered as a scaffold (registerMock). */
  isMock(methodId: string): boolean {
    return this.mocks.has(methodId);
  }

  /**
   * The full catalogue, sorted by methodId: what is registered, what actually
   * computes, and what refuses to run. This is the kernel-side data the MCP
   * `labre://methods` resource serves (CH-24 / ARCH-28) and it is deliberately
   * a plain array of plain objects — no class, no handle, nothing to execute.
   */
  catalogue(): StrategyCatalogEntry[] {
    return this.list().map((methodId) => {
      const entry: StrategyCatalogEntry = {
        methodId,
        implementation: this.mocks.has(methodId) ? "mock" : "real",
      };
      const reason = this.disabled.get(methodId);
      if (reason !== undefined) entry.disabledReason = reason;
      return entry;
    });
  }

  /**
   * Resolve a strategy class. Refuses a disabled strategy — the caller gets the
   * declared reason rather than a run. This is the single resolution point of
   * the kernel: both `runCommand` and the recipe runner go through it, so a
   * strategy that opts out here cannot be reached from the wire.
   */
  get(methodId: string): StrategyClass<TStrategy> {
    const cls = this.map.get(methodId);
    if (!cls) {
      throw new Error(
        `Unknown strategy "${methodId}" (registered: ${this.list().join(", ") || "none"})`,
      );
    }
    const reason = this.disabled.get(methodId);
    if (reason !== undefined) {
      throw new Error(`Strategy "${methodId}" is disabled: ${reason}`);
    }
    return cls;
  }

  /** The reason a registered strategy refuses to resolve, or undefined if it is enabled. */
  disabledReason(methodId: string): string | undefined {
    return this.disabled.get(methodId);
  }

  /** Every disabled strategy with its reason, sorted by methodId. */
  listDisabled(): Array<{ methodId: string; reason: string }> {
    return [...this.disabled.entries()]
      .map(([methodId, reason]) => ({ methodId, reason }))
      .sort((a, b) => a.methodId.localeCompare(b.methodId));
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
