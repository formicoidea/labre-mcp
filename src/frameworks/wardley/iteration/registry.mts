// Framework registry for Wardley iteration strategies.
//
// The iteration tree (wardley:iteration:* — the strategy cycle: purpose + OODA)
// is still largely scaffolded by fixtures (see fixtures-registry.mts). Real
// strategies are promoted here one at a time; each promotion deletes the
// matching line from `FIXTURE_METHOD_IDS`.
//
// `#frameworks/registry-boot.mts` calls `registerIterationStrategies(coreRegistry)`
// at boot, before the fixtures fill the rest of the catalogue.

import type { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';
import { WardleyIterationPurposeAuditPurposeQualityDefaultStrategy } from './purpose/audit-purpose-quality/default.mjs';
import { WardleyIterationPurposeGenerateDefaultStrategy } from './purpose/generate/default.mjs';

/**
 * Register every real iteration strategy on the provided core registry.
 */
export function registerIterationStrategies(
  registry: StrategyRegistry<BaseStrategy>,
): void {
  registry.register(
    WardleyIterationPurposeGenerateDefaultStrategy.method,
    WardleyIterationPurposeGenerateDefaultStrategy,
  );
  registry.register(
    WardleyIterationPurposeAuditPurposeQualityDefaultStrategy.method,
    WardleyIterationPurposeAuditPurposeQualityDefaultStrategy,
  );
}
