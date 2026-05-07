// MCP tool `generateValueChain` — exposes the TopDownChainStrategy to
// MCP clients as a single-shot tool that turns a natural-language command
// into an OWM DSL document plus the chain metadata.
//
// The handler is dispatched by mcp-server.mts and wrapped in
// `withMcpDegradation` by the server, so any failure inside
// `TopDownChainStrategy.buildFull` flows back to the client as a
// `Degradable<GenerateValueChainResult>` envelope.

import { z } from 'zod';
import type { McpToolDefinition, JsonSchema } from '../types/mcp.mjs';
import {
  GenerateValueChainInputSchema,
  type GenerateValueChainInput,
} from '../schemas/generate-value-chain.schema.mjs';
import { getStrategyLLM } from '../lib/llm/registry.mjs';
import { TopDownChainStrategy } from '../work-on-value-chain/write/chain/strategies/top-down/top-down-strategy.mjs';
import type { ChainMetadata } from '../types/value-chain.mjs';

export interface GenerateValueChainResult {
  owm: string;
  metadata: ChainMetadata;
  method: string;
}

export const GENERATE_VALUE_CHAIN_TOOL: McpToolDefinition = {
  name: 'generateValueChain',
  description:
    'Build a Wardley value chain from a natural-language command. ' +
    'Produces a complete OWM DSL document (component declarations + dependency links) ' +
    'ready to render at onlinewardleymaps.com, together with the chain metadata ' +
    '(angle, scope, objective, imperatives, temporality, contextSummary) extracted ' +
    'from the command. Covers phases 1–2 of the Wardley study cycle — downstream ' +
    'evolution refinement is delegated to estimateEvolution.',
  inputSchema: z.toJSONSchema(GenerateValueChainInputSchema, { io: 'input' }) as JsonSchema,
};

export async function handleGenerateValueChain(
  args: Record<string, unknown>,
): Promise<GenerateValueChainResult> {
  const parsed: GenerateValueChainInput = GenerateValueChainInputSchema.parse(args);
  const llmCall = getStrategyLLM('write-chain');
  const strategy = new TopDownChainStrategy({ llmCall });
  const full = await strategy.buildFull({
    nlCommand: parsed.nlCommand,
    emit: { style: parsed.style, size: parsed.size },
  });
  return { ...full, method: TopDownChainStrategy.method };
}
