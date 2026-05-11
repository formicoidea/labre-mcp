// Public surface of the labre-mcp kernel.
//
// Framework code (`src/frameworks/*`) and external integrations import from
// `#core/...` directly today. This barrel exists as a stable re-export point
// so future package extraction of the kernel does not break call sites.

export {
  BaseStrategy,
  METHOD_ID_5_SEGMENT_REGEX,
  methodIdSchema,
  type StrategyResult,
} from "./ast/base-strategy.mjs";
export { AnalysisRefSchema, type AnalysisRef } from "./ast/analysis-ref.mjs";
export type { BaseAST } from "./ast/base-ast.mjs";

export { StrategyRegistry, validateMethodId } from "./registry/strategy-registry.mjs";

export {
  type Recipe,
  type RecipeStep,
  RecipeSchema,
  RecipeStepSchema,
} from "./recipe/recipe.schema.mjs";
export { runRecipe } from "./recipe/recipe-runner.mjs";
export { loadRecipe, resetRecipeCache } from "./recipe/recipe-loader.mjs";

export {
  createEventBus,
  waitForEvent,
  type EventBus,
  type EventFilter,
} from "./bus/event-bus.mjs";
export { type PipelineEvent, PipelineEventSchema } from "./bus/event.schema.mjs";

export {
  type RequestContext,
  RequestContextSchema,
} from "./context/request-context.mjs";

export {
  attachArtifactWriter,
  ARTIFACT_WRITE_TIMEOUT_MS,
  type ArtifactWriterHandle,
  type WriteArtifactFn,
} from "./listeners/artifact-writer-listener.mjs";

export {
  writeArtifact,
  defaultArtifactDir,
  type ArtifactBody,
  type WriteArtifactOptions,
} from "./persistence/artifact-writer.mjs";
