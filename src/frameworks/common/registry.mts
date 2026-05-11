// Framework registry for cross-framework `common:` strategies (ARCH-25).
//
// At daemon boot, `labre-daemon.mts` calls `registerCommonStrategies(coreRegistry)`
// to populate the shared `StrategyRegistry` with strategies that are
// framework-agnostic by design (e.g. 2D layout primitives).

import type { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';

import { PlaceLabelsStrategy } from './layout/write/place-labels-strategy.mjs';
import { OverlapCheckStrategy } from './layout/quality/overlap-check-strategy.mjs';

/**
 * Register every common-namespace strategy on the provided core registry.
 */
export function registerCommonStrategies(
  registry: StrategyRegistry<BaseStrategy>,
): void {
  registry.register(PlaceLabelsStrategy.method, PlaceLabelsStrategy);
  registry.register(OverlapCheckStrategy.method, OverlapCheckStrategy);
}
