// MCP tool wrapper for evaluateMap.
//
// Evaluates every component of a .wm Wardley Map file via the classification
// gate + estimateEvolution pipeline, then writes the updated file in place.

import { z } from 'zod';
import type { McpToolDefinition, JsonSchema } from '../types/mcp.mjs';
import { EvaluateMapInputSchema, type EvaluateMapInput } from '../schemas/evaluate-map.schema.mjs';
import { evaluateMapFile } from '#work-on-evolution/write/evaluate-map/evaluate-map.mjs';

export const EVALUATE_MAP_TOOL: McpToolDefinition = {
  name: 'evaluateMap',
  description:
    'Evaluate all components in a .wm Wardley Map file, estimate their evolution positions, ' +
    'and update the file with new maturity values. Uses the classification gate to skip non-economic ' +
    'components and runs pluggable evaluation strategies on economic ones.',
  inputSchema: z.toJSONSchema(EvaluateMapInputSchema, { io: 'input' }) as JsonSchema,
};

export async function handleEvaluateMap(args: Record<string, unknown>): Promise<unknown> {
  const input: EvaluateMapInput = EvaluateMapInputSchema.parse(args);
  return evaluateMapFile(input.filePath, {
    strategy: input.strategy,
    updateFile: input.updateFile,
  });
}
