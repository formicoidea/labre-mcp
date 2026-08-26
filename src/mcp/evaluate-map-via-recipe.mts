// MCP handler that invokes `evaluateMap` through the kernel recipe runner.
//
// Same bridge shape as `estimate-evolution-via-recipe.mts`:
//   1. Validate the MCP arguments with the tool's Zod schema.
//   2. Build a RequestContext (ARCH-15) — caller-supplied `_context` when
//      present, dev-mode fallback otherwise.
//   3. Load the canonical `evaluate-map` recipe (shipped + project override).
//   4. Build the strategy registry from the framework register functions.
//   5. Attach the artefact-writer core listener (ARCH-12) BEFORE the run.
//   6. Run the recipe and await completion.
//   7. Return the recipeRunId, the final AST, the events trace, the envelope
//      and the artefact path.
//
// The recipe parses the OWM DSL into the canonical WardleyMap, then fans out
// two independent per-component passes over `$.chain.result.map.components`:
// evolution positioning (primary, `$.evaluations`) and capability identification
// (observation, `$.identified`).

import { EvaluateMapInputSchema } from '#schemas/evaluate-map.schema.mjs';
import { loadRecipe } from '#core/recipe/recipe-loader.mjs';
import { runRecipe, type JsonLabreEnvelope } from '#core/recipe/recipe-runner.mjs';
import { buildStrategyRegistry } from '#frameworks/registry-boot.mjs';
import { attachArtifactWriter } from '#core/listeners/artifact-writer-listener.mjs';
import { attachRunTelemetryIfConfigured } from '#core/listeners/posthog-telemetry-listener.mjs';
import { createEventBus } from '#core/bus/event-bus.mjs';
import { resolveContext } from './resolve-context.mjs';
import { SHIPPED_ROOT } from '#core/shipped-root.mjs';

export interface EvaluateMapViaRecipeResult {
  recipeRunId: string;
  // any: the final AST shape is recipe-specific — opaque at the tool boundary
  ast: Record<string, unknown>;
  artifactPath: string | null;
  // any: events are typed PipelineEvent[] but kept open here for forward compat
  events: unknown[];
  envelope: JsonLabreEnvelope;
}

/** Recipe-based handler for the `evaluateMap` tool. The `_context` field in
 *  args (when present) is parsed as a RequestContext; otherwise a fresh
 *  dev-mode context is synthesised. */
export async function handleEvaluateMapViaRecipe(
  rawInput: Record<string, unknown>,
): Promise<EvaluateMapViaRecipeResult> {
  const { _context: rawContext, ...args } = rawInput;
  const validated = EvaluateMapInputSchema.parse(args);

  const context = await resolveContext(rawContext);

  const recipe = await loadRecipe({
    framework: 'wardley',
    tool: 'map',
    name: 'evaluate-map',
    shippedRoot: SHIPPED_ROOT,
    projectRoot: context.projectRoot,
  });

  const registry = buildStrategyRegistry();
  const bus = createEventBus();

  // `$.input` is what the recipe's parse step consumes verbatim: `{ dsl }`.
  const ast: Record<string, unknown> = { input: validated };

  // Attached BEFORE the run so the artefact captures every event, including
  // step-start and run-end.
  const artifactHandle = attachArtifactWriter({ bus, context, getAst: () => ast });
  // Run-level telemetry (mcp_run_end / mcp_step_error), metadata only. Same
  // kernel, same bus, same events as a runRecipe call — CH-09 removed the
  // accident that only runRecipe forwarded them (invariant I7).
  attachRunTelemetryIfConfigured({ bus, context });

  const outcome = await runRecipe({ recipe, ast, context, registry, bus });
  const artifactPath = await artifactHandle.artifactPath;

  return {
    recipeRunId: outcome.recipeRunId,
    ast: outcome.ast,
    artifactPath,
    events: outcome.events,
    envelope: outcome.envelope,
  };
}
