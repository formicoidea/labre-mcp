// MCP tool definition for `estimateEvolution`.
//
// Extracted from labre-daemon.mts to keep the daemon a thin boot wrapper
// and to isolate the tool's Zod-to-JSON-Schema conversion and handler
// adaptation in its natural home (the MCP layer).
//
// The handler delegates to `handleEstimateEvolutionViaRecipe` which runs
// the canonical recipe through the kernel runner.

import { z } from "zod";
import type { ToolDefinition } from "#core/transport/mcp-handler.mjs";
import { EstimateEvolutionInputSchema } from "#schemas/estimate-evolution.schema.mjs";
import { handleEstimateEvolutionViaRecipe } from "./estimate-evolution-via-recipe.mjs";

export const ESTIMATE_EVOLUTION_TOOL: ToolDefinition = {
  name: "estimateEvolution",
  description:
    "Estimate the Wardley Map evolution position of a component via the recipe runner. " +
    "Dispatches through the canonical estimate-component-evolution recipe (node:identify → position-functional-in-evolution:llm-direct). " +
    "Returns recipeRunId, the AST, the events trace, and the artifact path under ~/.labre-mcp/runs/.",
  // any: zod-to-json conversion — the schema is well-typed at the Zod layer
  inputSchema: z.toJSONSchema(EstimateEvolutionInputSchema, { io: "input" }) as Record<string, unknown>,
  async handler(args, context) {
    // any: args is the open MCP arguments envelope; the handler validates internally
    return handleEstimateEvolutionViaRecipe({
      ...(args as Record<string, unknown>),
      _context: context,
    });
  },
};
