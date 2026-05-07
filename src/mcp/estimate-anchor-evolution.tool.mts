// MCP tool wrapper for estimateAnchorEvolution.
//
// Estimates the evolution position of an anchor (user need / stakeholder)
// through the consumption culture lens (user perception + industry perception).

import { z } from 'zod';
import type { McpToolDefinition, JsonSchema } from '../types/mcp.mjs';
import { EstimateAnchorEvolutionInputSchema, type EstimateAnchorEvolutionInput } from '../schemas/estimate-anchor-evolution.schema.mjs';
import { getStrategyLLM } from '../lib/llm/registry.mjs';
import { estimateAnchorEvolution } from '../work-on-evolution/write/strategies/anchor/estimate-anchor-evolution.mjs';

export const ESTIMATE_ANCHOR_EVOLUTION_TOOL: McpToolDefinition = {
  name: 'estimateAnchorEvolution',
  description:
    'Estimate the evolution position of an anchor (user need / stakeholder) in a Wardley Map. ' +
    'Unlike components evaluated by technical maturity, anchors are evaluated through ' +
    'the consumption culture lens (user perception + industry perception). ' +
    'The LLM determines a single evolution phase (1–4, Genesis → Commodity). ' +
    'A phase can be provided directly to skip LLM assessment.',
  inputSchema: z.toJSONSchema(EstimateAnchorEvolutionInputSchema, { io: 'input' }) as JsonSchema,
};

export async function handleEstimateAnchorEvolution(args: Record<string, unknown>): Promise<unknown> {
  const input: EstimateAnchorEvolutionInput = EstimateAnchorEvolutionInputSchema.parse(args);
  return estimateAnchorEvolution(input, getStrategyLLM('anchor-evolution'));
}
