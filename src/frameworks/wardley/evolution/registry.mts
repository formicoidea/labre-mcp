// Framework registry for Wardley evolution strategies.
//
// At daemon boot, `labre-daemon.mts` calls `registerEvolutionStrategies(coreRegistry)`
// to populate the shared `StrategyRegistry` with every evolution strategy.
// A legacy `loadStrategies()` filesystem walker remains functional in parallel
// until V1.5 cleanup; both surfaces resolve to the same classes.

import type { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';

import { SCurveStrategy } from './_legacy/write/strategies/capacity/s-curve-strategy.mjs';
import { LLMDirectStrategy } from './_legacy/write/strategies/capacity/llm-direct-strategy.mjs';
import { PublicationAnalysisStrategy } from './_legacy/write/strategies/capacity/publication-analysis-strategy.mjs';
// Adapter: legacy class kept intact for 13 test/lib consumers.
import { CpcEvolutionStrategyCore } from './_legacy/write/strategies/capacity/cpc-evolution-strategy.mjs';
// Adapter: the legacy class stays disabled per its static getter.
import { TimelineBenchmarkStrategyCore } from './_legacy/write/strategies/capacity/timeline-benchmark-strategy.mjs';
import { LogprobDistributionStrategyCore } from './_legacy/write/strategies/capacity/logprob-distribution-strategy.mjs';
// Adapter for the solution-properties strategy.
import { PropertiesStrategyCore } from './_legacy/write/strategies/solution/properties-strategy.mjs';
// Wrapper class around the `identifyCapability` function (lives in chain framework).
import { IdentifyCapabilityStrategy } from '#frameworks/wardley/chain/_legacy/write/component/lib/capability/identify-capability.mjs';
// Wrapper class around the `estimateAnchorEvolution` function.
import { EstimateAnchorEvolutionStrategy } from './_legacy/write/strategies/anchor/estimate-anchor-evolution.mjs';

/**
 * Register every evolution strategy on the provided core registry.
 * Idempotent guard: throws if a methodId is already registered (catches double-boots).
 */
export function registerEvolutionStrategies(
  registry: StrategyRegistry<BaseStrategy>,
): void {
  registry.register(SCurveStrategy.method, SCurveStrategy);
  registry.register(LLMDirectStrategy.method, LLMDirectStrategy);
  registry.register(PublicationAnalysisStrategy.method, PublicationAnalysisStrategy);
  registry.register(CpcEvolutionStrategyCore.method, CpcEvolutionStrategyCore);
  registry.register(TimelineBenchmarkStrategyCore.method, TimelineBenchmarkStrategyCore);
  registry.register(LogprobDistributionStrategyCore.method, LogprobDistributionStrategyCore);
  registry.register(PropertiesStrategyCore.method, PropertiesStrategyCore);
  registry.register(IdentifyCapabilityStrategy.method, IdentifyCapabilityStrategy);
  // Anchor evolution: the existing logic is published under :culture-phase
  // (its specific perception-model variant) AND aliased under :default so
  // callers that want "whatever the default anchor positioning is" resolve
  // to the same implementation. Per ast-schema.md v0.1.0 § 3.3 the two
  // methodIds are intentionally distinct entries in the catalogue.
  registry.register(EstimateAnchorEvolutionStrategy.method, EstimateAnchorEvolutionStrategy);
  registry.register('wardley:map:climate:position-anchor-in-evolution:default', EstimateAnchorEvolutionStrategy);
}
