// MCP tool definition for `evaluateMap` (roadmap B3).
//
// Dedicated wrapper around the multi-step `wardley:map:evaluate-map` recipe,
// which was previously reachable only through `runRecipe` with its 3-segment
// ref. The explicit input schema is what makes the flow discoverable by an
// agent. Same shape as `estimate-evolution.tool.mts`: the tool holds the
// schema + description, the bridge module runs the recipe.

import { z } from 'zod';
import type { ToolDefinition } from '#core/transport/mcp-handler.mjs';
import { EvaluateMapInputSchema } from '#schemas/evaluate-map.schema.mjs';
import { handleEvaluateMapViaRecipe } from './evaluate-map-via-recipe.mjs';

/** The one recipe this tool dispatches — kept beside the tool so the telemetry
 *  target and the bridge cannot drift apart silently. */
export const EVALUATE_MAP_RECIPE_REF = 'wardley:map:evaluate-map';

export const EVALUATE_MAP_TOOL: ToolDefinition = {
  name: 'evaluateMap',
  description:
    'Evaluate every component of an existing Wardley map given as OWM DSL. ' +
    'Dispatches through the canonical evaluate-map recipe: parses the DSL into the ' +
    'canonical WardleyMap (owm:parse:dsl), then fans out two independent per-component ' +
    'passes — evolution positioning (position-functional-in-evolution:llm-direct, primary, ' +
    'at $.evaluations) and capability identification (node:identify, observation, at $.identified). ' +
    'Input: { dsl } — the map SOURCE, not a file path. ' +
    'Returns recipeRunId, the final AST, the JSON-labre envelope, the events trace, ' +
    'and the artefact path under ~/.labre-mcp/runs/.',
  // any: zod-to-json conversion — the schema is well-typed at the Zod layer
  inputSchema: z.toJSONSchema(EvaluateMapInputSchema, { io: 'input' }) as Record<string, unknown>,
  // Telemetry target (CH-09): one fixed canonical recipe → constant target,
  // nothing caller-supplied reaches PostHog.
  telemetryTarget: () => EVALUATE_MAP_RECIPE_REF,
  // Returns a bare EvaluateMapViaRecipeResult; the daemon dispatch wraps every
  // handler in withMcpDegradation (Degradable<T>) — do NOT self-wrap (hard rule #18).
  async handler(args, context) {
    // any: args is the open MCP arguments envelope; the bridge validates internally
    return handleEvaluateMapViaRecipe({
      ...(args as Record<string, unknown>),
      _context: context,
    });
  },
};
