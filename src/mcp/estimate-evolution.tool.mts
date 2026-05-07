// MCP tool wrapper for estimateEvolution.
//
// Exposes a single MCP tool that:
//   1. Classifies the component via the classification gate (social/common/economic)
//   2. If economic, evaluates evolution using the selected strategy (or all strategies)
//   3. Returns structured results conforming to the MCP tool response format
//
// The tool is dispatched by mcp-server.mts via REGISTERED_TOOLS + TOOL_HANDLERS.

import { z } from 'zod';
import type { McpToolDefinition, JsonSchema } from '../types/mcp.mjs';
import { EstimateEvolutionInputSchema, type EstimateEvolutionInput } from '../schemas/estimate-evolution.schema.mjs';
import { routeEstimateEvolution } from '../work-on-evolution/write/routing/mode-router.mjs';

export const ESTIMATE_EVOLUTION_TOOL: McpToolDefinition = {
  name: 'estimateEvolution',
  description:
    'Estimate the Wardley Map evolution position of a component. ' +
    'Transparently handles both named solutions (e.g. "Kubernetes", "Salesforce") and abstract capabilities (e.g. "CRM", "container orchestration"). ' +
    'Solutions are evaluated against 12 Wardley evolution properties (Market, Knowledge, Perception, etc.); ' +
    'capabilities use pluggable strategies (s-curve, pub-distribution, etc.). ' +
    'Routing is automatic: naming convention detection (≥90% confidence) or LLM + web search fallback. ' +
    'Pre-filters by economic space (social good / common good / economic) via a classification gate. ' +
    'Social good and common good components trigger re-questioning instead of evaluation. ' +
    'Returns {evolution, confidence, method} for each strategy, plus routing metadata showing which pipeline was used.',
  inputSchema: z.toJSONSchema(EstimateEvolutionInputSchema, { io: 'input' }) as JsonSchema,
};

export async function handleEstimateEvolution(rawInput: Record<string, unknown>): Promise<unknown> {
  const validated: EstimateEvolutionInput = EstimateEvolutionInputSchema.parse(rawInput);
  const { name, context, strategy, ...componentData } = validated;

  const routerInput = {
    name,
    description: context,
    context,
    strategy,
    ...componentData,
    mode: rawInput?.mode,
    space: rawInput?.space,
    sessionState: rawInput?.sessionState,
    forceEstimate: rawInput?.forceEstimate,
    compact: rawInput?.compact,
    pipeline: rawInput?.pipeline,
  };

  return routeEstimateEvolution(routerInput);
}
