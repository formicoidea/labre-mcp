// MCP handler that invokes `generateValueChain` through the kernel recipe
// runner.
//
// Same bridge shape as `estimate-evolution-via-recipe.mts`, with one extra
// projection step up front: the recipe's first step
// (`wardley:map:value-chain:generate:top-down`) consumes a CANONICAL
// WardleyMap basemap and recovers the natural-language command from its
// `title` / `context`. The tool's surface is the natural-language pair, so the
// handler runs the deterministic `wardley:map:basemap:generate:default`
// strategy (no LLM, no I/O) to build that skeleton before seeding `$.input`.
// Reusing the strategy rather than inlining `{ title, components: [], relations: [] }`
// keeps a single definition of the basemap projection.

import { GenerateValueChainInputSchema } from '#schemas/generate-value-chain.schema.mjs';
import { loadRecipe } from '#core/recipe/recipe-loader.mjs';
import { runRecipe, type JsonLabreEnvelope } from '#core/recipe/recipe-runner.mjs';
import { buildStrategyRegistry } from '#core/transport/strategy-registry-boot.mjs';
import { attachArtifactWriter } from '#core/listeners/artifact-writer-listener.mjs';
import { attachRunTelemetryIfConfigured } from '#core/listeners/posthog-telemetry-listener.mjs';
import { createEventBus } from '#core/bus/event-bus.mjs';
import { WardleyMapBasemapGenerateDefaultStrategy } from '#frameworks/wardley/map/basemap/generate/default.mjs';
import { resolveContext } from './resolve-context.mjs';
import { SHIPPED_ROOT } from './shipped-root.mjs';

export interface GenerateValueChainViaRecipeResult {
  recipeRunId: string;
  // any: the final AST shape is recipe-specific — opaque at the tool boundary
  ast: Record<string, unknown>;
  /** OWM DSL emitted by the recipe's last step, when it produced one. */
  dsl: string | null;
  artifactPath: string | null;
  // any: events are typed PipelineEvent[] but kept open here for forward compat
  events: unknown[];
  envelope: JsonLabreEnvelope;
}

/** Read the OWM DSL out of the recipe's `$.output` step result. Absent or
 *  reshaped output degrades to `null` rather than throwing — the full AST is
 *  returned alongside, so nothing is lost. */
function readEmittedDsl(ast: Record<string, unknown>): string | null {
  const output = ast.output;
  if (!output || typeof output !== 'object') return null;
  const result = (output as { result?: unknown }).result;
  if (!result || typeof result !== 'object') return null;
  const dsl = (result as { dsl?: unknown }).dsl;
  return typeof dsl === 'string' ? dsl : null;
}

/** Recipe-based handler for the `generateValueChain` tool. The `_context`
 *  field in args (when present) is parsed as a RequestContext; otherwise a
 *  fresh dev-mode context is synthesised. */
export async function handleGenerateValueChainViaRecipe(
  rawInput: Record<string, unknown>,
): Promise<GenerateValueChainViaRecipeResult> {
  const { _context: rawContext, ...args } = rawInput;
  const validated = GenerateValueChainInputSchema.parse(args);

  const context = await resolveContext(rawContext);

  const recipe = await loadRecipe({
    framework: 'wardley',
    tool: 'map',
    name: 'generate',
    shippedRoot: SHIPPED_ROOT,
    projectRoot: context.projectRoot,
  });

  const registry = buildStrategyRegistry();
  const bus = createEventBus();

  // Project the natural-language pair onto the canonical basemap the recipe's
  // first step expects. Deterministic — no LLM call, no event on the bus.
  const basemap = await new WardleyMapBasemapGenerateDefaultStrategy().evaluate(
    { prompt: validated.prompt, context: validated.context },
    context,
  );

  const ast: Record<string, unknown> = { input: basemap.result };

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
    dsl: readEmittedDsl(outcome.ast),
    artifactPath,
    events: outcome.events,
    envelope: outcome.envelope,
  };
}
