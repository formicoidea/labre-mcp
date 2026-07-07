// MCP tool definition for `runRecipe` — invoke a multi-step recipe by name.
//
// Generalises `estimate-evolution-via-recipe` (which runs one fixed recipe)
// to any shipped/override recipe addressed by a 3-segment ref
// `<domain>:<tool>:<name>`. The result carries the same JSON-labre envelope
// (signals / reasoning / insights / trace) as a runCommand call and persists
// an artefact under ~/.labre-mcp/runs/. Use `runCommand` for a single methodId.

import { z } from 'zod';
import type { ToolDefinition } from '#core/transport/mcp-handler.mjs';
import { RunRecipeCallSchema } from '#schemas/run-recipe.schema.mjs';
import { loadRecipe, getBundlePrompts } from '#core/recipe/recipe-loader.mjs';
import { runRecipe, type JsonLabreEnvelope } from '#core/recipe/recipe-runner.mjs';
import { buildStrategyRegistry } from '#core/transport/strategy-registry-boot.mjs';
import { attachArtifactWriter } from '#core/listeners/artifact-writer-listener.mjs';
import { attachPostHogTelemetry } from '#core/listeners/posthog-telemetry-listener.mjs';
import { getPostHogFlags } from '#lib/flags/state.mjs';
import { createEventBus } from '#core/bus/event-bus.mjs';
import { resolveContext } from './resolve-context.mjs';
import { SHIPPED_ROOT } from './shipped-root.mjs';

export interface RunRecipeResult {
  recipe: string;
  status: 'ok' | 'error';
  recipeRunId?: string;
  // any: final AST shape is recipe-specific — opaque at the tool boundary
  ast?: Record<string, unknown>;
  envelope?: JsonLabreEnvelope;
  artifactPath?: string | null;
  errors?: string[];
}

export const RUN_RECIPE_TOOL: ToolDefinition = {
  name: 'runRecipe',
  description:
    'Run a multi-step recipe by name and get its JSON-labre envelope (signals, reasoning, ' +
    'insights, trace) plus the final AST and the artefact path. ' +
    'Input: { recipe: "<domain>:<tool>:<name>", input: <recipe-specific> } ' +
    '(e.g. "wardley:map:draw-value-chain"). Shipped recipes live under recipes/<domain>/<tool>/; ' +
    'a same-named recipe under the project root overrides the shipped one. ' +
    'Use runCommand for a single methodId. An unknown recipe returns status "error".',
  // any: zod-to-json conversion — the schema is well-typed at the Zod layer
  inputSchema: z.toJSONSchema(RunRecipeCallSchema, { io: 'input' }) as Record<string, unknown>,
  // Returns a bare RunRecipeResult; the daemon dispatch wraps every handler in
  // withMcpDegradation (Degradable<T>) — do NOT self-wrap here (hard rule #18).
  async handler(args, context): Promise<RunRecipeResult> {
    const call = RunRecipeCallSchema.parse(args);
    // The regex guarantees exactly 3 colon-separated segments.
    const [framework, tool, name] = call.recipe.split(':') as [string, string, string];

    // Feature-flag gate (daemon with PostHog configured only). Flags are
    // rollout controls, not a security boundary — auth is; the flag module
    // fails open on any PostHog trouble. When no PostHog is configured
    // (stdio, local daemon) getPostHogFlags() is undefined and this block
    // costs nothing: no dynamic import, no network, no await.
    const flags = getPostHogFlags();
    if (flags) {
      const allowed = await flags.isRecipeEnabled(
        { domain: framework, tool, name },
        context.auth?.userId ?? 'anonymous',
      );
      if (!allowed) {
        return {
          recipe: call.recipe,
          status: 'error',
          errors: [
            `Recipe "${call.recipe}" is disabled by feature flag for this user (rollout gate)`,
          ],
        };
      }
    }

    const ctx = await resolveContext(context);

    let recipe;
    try {
      recipe = await loadRecipe({
        framework,
        tool,
        name,
        shippedRoot: SHIPPED_ROOT,
        projectRoot: ctx.projectRoot,
      });
    } catch (err) {
      return {
        recipe: call.recipe,
        status: 'error',
        errors: [(err as Error)?.message ?? String(err)],
      };
    }

    // Bundle recipes carry run-scoped prompt overrides (A/B testing); shipped
    // and user recipes return undefined here and run with the shipped prompts.
    // The loaded recipe is passed so a user recipe shadowing a bundle ref
    // (loadRecipe ranks user overrides above bundle recipes) never inherits
    // the bundle's prompts.
    const promptOverrides = getBundlePrompts({ framework, tool, name }, recipe);

    const registry = buildStrategyRegistry();
    const bus = createEventBus();

    // Caller-owned AST so the artefact-writer listener sees the live object
    // (mutated in place by the runner, read at run-end). $.input seeds the recipe.
    const ast: Record<string, unknown> = { input: call.input };
    const artifactHandle = attachArtifactWriter({ bus, context: ctx, getAst: () => ast });

    // Telemetry forwarder (run-end / step-error → PostHog, metadata only).
    // The bus is per-run, so the boot-installed PostHog instance is attached
    // here rather than at daemon boot — see posthog-telemetry-listener.mts.
    if (flags) {
      attachPostHogTelemetry({
        bus,
        flags,
        distinctId: context.auth?.userId ?? 'daemon',
      });
    }

    try {
      const outcome = await runRecipe({ recipe, ast, context: ctx, registry, bus, promptOverrides });
      const artifactPath = await artifactHandle.artifactPath;
      return {
        recipe: call.recipe,
        status: 'ok',
        recipeRunId: outcome.recipeRunId,
        ast: outcome.ast,
        envelope: outcome.envelope,
        artifactPath,
      };
    } catch (err) {
      const artifactPath = await artifactHandle.artifactPath;
      return {
        recipe: call.recipe,
        status: 'error',
        artifactPath,
        errors: [(err as Error)?.message ?? String(err)],
      };
    }
  },
};
