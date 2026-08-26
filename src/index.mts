// labre-mcp — LIB MODE, the package's programmatic entry point.
//
// WHAT THIS IS FOR (CH-23 / ARCH-27, human arbitration C1-A, 2026-08-25).
// labre-mcp is a product in its own right, consumable by another harness —
// Claude Code, a CLI, a third-party agent — AND by labre's own harness in
// process. MCP is ONE delivery of it, not its identity. Everything below is the
// kernel: the strategy registry, the recipe runner, the 5-segment grammar and
// the contracts. Import it, build a registry, run a command. No server starts,
// no port is bound, no quota is checked, no ledger row is written.
//
// THE RULE THIS FILE OBEYS. Nothing reachable from here may live under
// `src/transport/` or `src/mcp/`. That is not a convention: `lib-mode.test.mts`
// walks this module's transitive import graph and fails on either, and the
// import-boundary guard keeps the kernel itself clean.
//
// What is deliberately NOT here: `startHttpDaemon`, `startStdioServer`,
// `dispatch`, the MCP tool descriptors. A consumer that wants those wants the
// MCP delivery — `src/mcp/labre-daemon.mts` or the `labre-mcp` bin — not this.

// ─── Strategy catalogue ─────────────────────────────────────────────────────
// `buildStrategyRegistry()` returns the full catalogue (set LABRE_DISABLE_MOCKS=1
// for real strategies only). `StrategyRegistry` builds a narrower one by hand.
export { StrategyRegistry } from './core/registry/strategy-registry.mjs';
export type {
  StrategyCatalogEntry,
  StrategyImplementation,
} from './core/registry/strategy-registry.mjs';
export { buildStrategyRegistry } from './frameworks/registry-boot.mjs';

// ─── Data catalogues (CH-24 / ARCH-28) ──────────────────────────────────────
// What the MCP costume (prompts + resources) is SERVED FROM. They are plain
// data — a grammar constant, a listing of the shipped schemas and recipes, a
// listing of the prompt registry — so a lib-mode consumer gets the same
// discovery surface a third-party harness gets over the wire, with no daemon.
export { GRAMMAR, GRAMMAR_VERSION } from './core/catalog/grammar.mjs';
export type { Grammar, GrammarSegment } from './core/catalog/grammar.mjs';
export {
  listShippedRecipes,
  listShippedSchemas,
  readShippedSchema,
} from './core/catalog/shipped-assets.mjs';
export type {
  ShippedRecipeEntry,
  ShippedSchemaEntry,
} from './core/catalog/shipped-assets.mjs';
export { getPromptCatalogEntry, listPromptCatalog } from './lib/prompts/catalog.mjs';
export type { PromptCatalogEntry } from './lib/prompts/catalog.mjs';

// ─── Execution ──────────────────────────────────────────────────────────────
// `runCommand` invokes one 5-segment methodId; `runRecipe` orchestrates a
// multi-step recipe. Both return the JSON-labre envelope
// (signals / reasoning / insights / trace). `RunHooks` is the metering seam —
// pass nothing and the run stays offline (CH-23, fourth cut).
export { runCommand, runRecipe } from './core/recipe/recipe-runner.mjs';
export type {
  JsonLabreEnvelope,
  RunClock,
  RunCommandOptions,
  RunHooks,
  RunOptions,
  RunOutcome,
} from './core/recipe/recipe-runner.mjs';

// ─── Recipes ────────────────────────────────────────────────────────────────
export { loadRecipe } from './core/recipe/recipe-loader.mjs';
export { RecipeSchema } from './core/recipe/recipe.schema.mjs';
export type { Recipe, RecipeStep } from './core/recipe/recipe.schema.mjs';
/** Where this package's shipped recipes live — pass it as `shippedRoot`. */
export { SHIPPED_ROOT } from './core/shipped-root.mjs';

// ─── Contracts ──────────────────────────────────────────────────────────────
export { BaseStrategy } from './core/ast/base-strategy.mjs';
export type { StrategyResult } from './core/ast/base-strategy.mjs';
export { RequestContextSchema } from './core/context/request-context.mjs';
export type { RequestContext } from './core/context/request-context.mjs';
// The tool registry is a kernel contract since CH-23: a named-callable surface
// a host fills and any delivery serves. Exposed so an embedding harness can
// build its own surface without going through MCP.
export { ToolRegistry } from './core/registry/tool-registry.mjs';
export type { ToolDefinition } from './core/registry/tool-registry.mjs';
// The costume's two registries are kernel contracts for the same reason
// (CH-24): a host composes prompts and resources, a delivery serves them.
export { PromptRegistry, requireArguments } from './core/registry/prompt-registry.mjs';
export type {
  PromptArgumentDefinition,
  PromptDefinition,
  PromptMessage,
  PromptSummary,
} from './core/registry/prompt-registry.mjs';
export { ResourceRegistry } from './core/registry/resource-registry.mjs';
export type {
  ResourceDefinition,
  ResourceSummary,
} from './core/registry/resource-registry.mjs';

// ─── Observation ────────────────────────────────────────────────────────────
export { createEventBus } from './core/bus/event-bus.mjs';
export type { EventBus } from './core/bus/event-bus.mjs';
export type { PipelineEvent } from './core/bus/event.schema.mjs';
export { attachArtifactWriter } from './core/listeners/artifact-writer-listener.mjs';

// ─── Shared Utilities ───────────────────────────────────────────────────────
export { createLLMCall, createStructuredLLMCall } from './lib/llm/llm-call.mjs';
export { detectLanguage } from './lib/language-detect.mjs';
export { formatResponse } from './lib/response-formatter.mjs';
