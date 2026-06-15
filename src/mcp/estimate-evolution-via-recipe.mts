// MCP handler that invokes `estimateEvolution` via the kernel recipe
// runner instead of the legacy dispatcher.
//
// Flow:
//   1. Validate the MCP arguments (same schema as the legacy handler).
//   2. Build a RequestContext (ARCH-15) — uses caller-supplied _context when
//      present, falls back to dev-mode defaults otherwise.
//   3. Load the canonical `estimate-component-evolution` recipe (shipped + override).
//   4. Build the strategy registry by importing every framework's register
//      function (boot wiring).
//   5. Attach the artefact writer listener (ARCH-12 core listener).
//   6. Run the recipe via `core/recipe-runner` and await completion.
//   7. Return the recipeRunId, the AST, and the artefact path.
//
// The legacy `handleEstimateEvolution` in estimate-evolution.tool.mts remains
// available for transition; V1.5 cleanup will decide whether to retire it or
// align it on this recipe-based path.

import { EstimateEvolutionInputSchema } from '../schemas/estimate-evolution.schema.mjs';
import { loadRecipe } from '#core/recipe/recipe-loader.mjs';
import { runRecipe } from '#core/recipe/recipe-runner.mjs';
import { buildStrategyRegistry } from '#core/transport/strategy-registry-boot.mjs';
import { attachArtifactWriter } from '#core/listeners/artifact-writer-listener.mjs';
import { createEventBus } from '#core/bus/event-bus.mjs';
import { resolveContext } from './resolve-context.mjs';
import { SHIPPED_ROOT } from './shipped-root.mjs';

export interface EstimateEvolutionViaRecipeResult {
  recipeRunId: string;
  ast: Record<string, unknown>;
  artifactPath: string | null;
  // any: events are typed PipelineEvent[] but kept open here for forward compat
  events: unknown[];
  envelope: import('#core/recipe/recipe-runner.mjs').JsonLabreEnvelope;
}

/**
 * Recipe-based handler. Equivalent to `handleEstimateEvolution` but
 * dispatched through the kernel. The `_context` field in args (if present)
 * is parsed as a RequestContext; otherwise a fresh context is synthesised.
 */
export async function handleEstimateEvolutionViaRecipe(
  rawInput: Record<string, unknown>,
): Promise<EstimateEvolutionViaRecipeResult> {
  // Validate the user-facing args using the existing Zod schema, then strip
  // the optional _context envelope (extracted separately).
  const { _context: rawContext, ...args } = rawInput;
  const validated = EstimateEvolutionInputSchema.parse(args);

  const context = await resolveContext(rawContext);

  // Load the canonical recipe (shipped) — user override consulted automatically
  // when projectRoot points to a different repo.
  const recipe = await loadRecipe({
    framework: 'wardley',
    tool: 'map',
    name: 'estimate-component-evolution',
    shippedRoot: SHIPPED_ROOT,
    projectRoot: context.projectRoot,
  });

  const registry = buildStrategyRegistry();
  const bus = createEventBus();

  // Initial AST seeds the recipe's `$.input` with the validated component shape.
  const ast: Record<string, unknown> = { input: validated };

  // Attach the artefact writer core listener BEFORE the run so it captures
  // every event including step-start and run-end.
  const artifactHandle = attachArtifactWriter({
    bus,
    context,
    getAst: () => ast,
  });

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
