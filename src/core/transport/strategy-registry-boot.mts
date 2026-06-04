// Strategy registry boot wiring.
//
// Extracted from labre-daemon.mts to break the circular dependency that
// used to form when the recipe runner (loaded via the MCP tool handler in
// estimate-evolution-via-recipe.mts) reached back into the daemon to grab
// `buildStrategyRegistry`. Both the daemon and the recipe handler now
// depend on this leaf module instead.
//
// Side-effects-imports every framework's register function so adding a
// new framework only means appending one import + one call below.

import { StrategyRegistry } from "../registry/strategy-registry.mjs";
import type { BaseStrategy } from "../ast/base-strategy.mjs";
import { registerEvolutionStrategies } from "#frameworks/wardley/evolution/registry.mjs";
import { registerChainStrategies } from "#frameworks/wardley/chain/registry.mjs";
import { registerCommonStrategies } from "#frameworks/common/registry.mjs";
import { registerMocks } from "#frameworks/mocks-registry.mjs";

/**
 * Build the strategy registry by importing every framework's register
 * function. Each framework module side-effects-imports its strategy
 * classes at load time; the register function wires them into the shared
 * registry. Idempotent (throws on duplicate methodId — catches accidental
 * double-boot).
 *
 * Mocks (CP10) scaffold the rest of the v0.1.0 catalogue. Set
 * `LABRE_DISABLE_MOCKS=1` to skip — useful for prod runs where only real
 * strategies should be exposed.
 */
export function buildStrategyRegistry(): StrategyRegistry<BaseStrategy> {
  const registry = new StrategyRegistry<BaseStrategy>();
  registerEvolutionStrategies(registry);
  registerChainStrategies(registry);
  registerCommonStrategies(registry);
  if (process.env.LABRE_DISABLE_MOCKS !== "1") {
    registerMocks(registry);
  }
  return registry;
}
