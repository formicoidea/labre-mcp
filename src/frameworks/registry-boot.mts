// Strategy registry boot wiring — the frameworks' own composition root.
//
// Extracted from labre-daemon.mts to break the circular dependency that
// used to form when the recipe runner (loaded via the MCP tool handler in
// estimate-evolution-via-recipe.mts) reached back into the daemon to grab
// `buildStrategyRegistry`. Both the daemon and the recipe handler now
// depend on this leaf module instead.
//
// CH-23 moved it OUT of src/core/transport/ and into src/frameworks/, where it
// belongs: composing every framework's strategies is a framework concern, not
// a wire concern. The kernel keeps the empty `StrategyRegistry` class and knows
// no framework; the transport keeps no framework knowledge at all; a lib-mode
// consumer calls this function directly and gets a full registry with no
// server anywhere in the graph.
//
// Side-effects-imports every framework's register function so adding a
// new framework only means appending one import + one call below.

import { StrategyRegistry } from "#core/registry/strategy-registry.mjs";
import type { BaseStrategy } from "#core/ast/base-strategy.mjs";
import { registerEvolutionStrategies } from "#frameworks/wardley/evolution/registry.mjs";
import { registerChainStrategies } from "#frameworks/wardley/chain/registry.mjs";
import { registerIterationStrategies } from "#frameworks/wardley/iteration/registry.mjs";
import { registerCommonStrategies } from "#frameworks/common/registry.mjs";
import { registerRenderStrategies } from "#frameworks/render/registry.mjs";
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
  registerIterationStrategies(registry);
  registerCommonStrategies(registry);
  registerRenderStrategies(registry);
  if (process.env.LABRE_DISABLE_MOCKS !== "1") {
    registerMocks(registry);
  }
  return registry;
}
