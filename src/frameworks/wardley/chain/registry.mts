// Framework registry for Wardley chain strategies.
//
// At daemon boot, `labre-daemon.mts` calls `registerChainStrategies(coreRegistry)`
// to populate the shared `StrategyRegistry` with every chain strategy. The legacy
// chain registry is local and unused by the core runner — it stays in place
// until V1.5 cleanup.

import type { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';

// Adapter for the chain top-down strategy, which returns { owm, metadata }.
import { TopDownChainStrategyCore } from './_legacy/write/chain/strategies/top-down/top-down-strategy.mjs';
// OWM DSL parser (read) and serializer (emit).
import { OwmParserStrategy } from './read/map/owm-parser-strategy.mjs';
import { OwmEmitStrategy } from './emit/owm/owm-emit-strategy.mjs';

/**
 * Register every chain strategy on the provided core registry.
 */
export function registerChainStrategies(
  registry: StrategyRegistry<BaseStrategy>,
): void {
  registry.register(TopDownChainStrategyCore.method, TopDownChainStrategyCore);
  registry.register(OwmParserStrategy.method, OwmParserStrategy);
  registry.register(OwmEmitStrategy.method, OwmEmitStrategy);
}
