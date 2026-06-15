// Framework registry for Wardley chain strategies.
//
// At daemon boot, `labre-daemon.mts` calls `registerChainStrategies(coreRegistry)`
// to populate the shared `StrategyRegistry` with every chain strategy. The legacy
// chain registry is local and unused by the core runner — it stays in place
// until V1.5 cleanup.

import type { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';

// OWM DSL parser (read) and serializer (emit).
import { OwmParserStrategy } from './read/map/owm-parser-strategy.mjs';
import { OwmEmitStrategy } from './emit/owm/owm-emit-strategy.mjs';
// Basemap skeleton generator (canonical WardleyMap entry point).
import { WardleyMapBasemapGenerateDefaultStrategy } from '#frameworks/wardley/map/basemap/generate/default.mjs';
// Canonical value-chain generation + Y layout (WardleyMap → WardleyMap).
import { WardleyMapValueChainGenerateTopDownStrategy } from '#frameworks/wardley/map/value-chain/generate/top-down.mjs';
import { WardleyMapValueChainOrganizedYPositionDefaultStrategy } from '#frameworks/wardley/map/value-chain/organized-y-position/default.mjs';
// Selector engine: builds the array of type:'component' nodes for per-component fan-out.
import { WardleyMapValueChainSelectByTypeComponentStrategy } from '#frameworks/wardley/map/value-chain/select-by-type/component.mjs';

/**
 * Register every chain strategy on the provided core registry.
 */
export function registerChainStrategies(
  registry: StrategyRegistry<BaseStrategy>,
): void {
  registry.register(OwmParserStrategy.method, OwmParserStrategy);
  registry.register(OwmEmitStrategy.method, OwmEmitStrategy);
  registry.register(
    WardleyMapBasemapGenerateDefaultStrategy.method,
    WardleyMapBasemapGenerateDefaultStrategy,
  );
  registry.register(
    WardleyMapValueChainGenerateTopDownStrategy.method,
    WardleyMapValueChainGenerateTopDownStrategy,
  );
  registry.register(
    WardleyMapValueChainOrganizedYPositionDefaultStrategy.method,
    WardleyMapValueChainOrganizedYPositionDefaultStrategy,
  );
  registry.register(
    WardleyMapValueChainSelectByTypeComponentStrategy.method,
    WardleyMapValueChainSelectByTypeComponentStrategy,
  );
}
