// MCP tool definition for `generateValueChain` (roadmap B3).
//
// Dedicated wrapper around the multi-step `wardley:map:generate` recipe, which
// was previously reachable only through `runRecipe` with its 3-segment ref.
// The explicit input schema is what makes the flow discoverable by an agent.
// Same shape as `estimate-evolution.tool.mts`: the tool holds the schema +
// description, the bridge module runs the recipe.

import { z } from 'zod';
import type { ToolDefinition } from '#core/transport/mcp-handler.mjs';
import { GenerateValueChainInputSchema } from '#schemas/generate-value-chain.schema.mjs';
import { handleGenerateValueChainViaRecipe } from './generate-value-chain-via-recipe.mjs';

export const GENERATE_VALUE_CHAIN_TOOL: ToolDefinition = {
  name: 'generateValueChain',
  description:
    'Generate a complete Wardley value chain from a natural-language command and emit it as OWM DSL. ' +
    'Dispatches through the canonical generate recipe: value-chain:generate:top-down → ' +
    'prevent-collision (label layout) → audit:overlap-check → owm:emit:dsl. ' +
    'Input: { prompt, context? }. The X coordinate produced here is a READABILITY layout, ' +
    'never an evolution maturity — position the map in evolution afterwards with evaluateMap. ' +
    'Returns the emitted dsl, recipeRunId, the final AST, the JSON-labre envelope, the events ' +
    'trace, and the artefact path under ~/.labre-mcp/runs/.',
  // any: zod-to-json conversion — the schema is well-typed at the Zod layer
  inputSchema: z.toJSONSchema(GenerateValueChainInputSchema, { io: 'input' }) as Record<
    string,
    unknown
  >,
  // Returns a bare GenerateValueChainViaRecipeResult; the daemon dispatch wraps every
  // handler in withMcpDegradation (Degradable<T>) — do NOT self-wrap (hard rule #18).
  async handler(args, context) {
    // any: args is the open MCP arguments envelope; the bridge validates internally
    return handleGenerateValueChainViaRecipe({
      ...(args as Record<string, unknown>),
      _context: context,
    });
  },
};
