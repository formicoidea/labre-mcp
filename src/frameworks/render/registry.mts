// Framework registry for the `render` domain (real strategies).
//
// At daemon boot, `strategy-registry-boot.mts` calls
// `registerRenderStrategies(coreRegistry)` to populate the shared registry.
// Render strategies bridge the canonical WardleyMap to renderable artifacts
// (SVG, …) through the anti-corruption layer.

import type { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';

import { RenderWardleyMapImageEmitSvgStrategy } from './wardley-map/image/emit/svg.mjs';

export function registerRenderStrategies(
  registry: StrategyRegistry<BaseStrategy>,
): void {
  registry.register(
    RenderWardleyMapImageEmitSvgStrategy.method,
    RenderWardleyMapImageEmitSvgStrategy,
  );
}
