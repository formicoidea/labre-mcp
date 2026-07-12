// Framework registry for Wardley iteration strategies.
//
// The iteration tree (wardley:iteration:* — the strategy cycle: purpose + OODA)
// is still largely scaffolded by mocks (see mocks-registry.mts). Real strategies
// are promoted here one at a time; each promotion deletes the matching
// `.mock-strategy.mts` and its two lines in mocks-registry.mts.
//
// `strategy-registry-boot.mts` calls `registerIterationStrategies(coreRegistry)`
// at boot, before the mocks fill the rest of the catalogue.

import type { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';
import { WardleyIterationPurposeAuditPurposeQualityDefaultStrategy } from './purpose/audit-purpose-quality/default.mjs';

/**
 * Register every real iteration strategy on the provided core registry.
 */
export function registerIterationStrategies(
  registry: StrategyRegistry<BaseStrategy>,
): void {
  registry.register(
    WardleyIterationPurposeAuditPurposeQualityDefaultStrategy.method,
    WardleyIterationPurposeAuditPurposeQualityDefaultStrategy,
  );
}
