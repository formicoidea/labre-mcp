// MCP tool wrapper for identifyCapability.
//
// Decodes a Wardley component label (e.g. "Kubernetes", "CRM") into the
// underlying capability/need it serves. Delegates to the lib function in
// component/lib/capability/identify-capability.mts.

import { z } from 'zod';
import type { McpToolDefinition, JsonSchema } from '../types/mcp.mjs';
import { IdentifyCapabilityInputSchema, type IdentifyCapabilityInput } from '../schemas/identify-capability.schema.mjs';
import { getStrategyLLM } from '../lib/llm/registry.mjs';
import { identifyCapability } from '#work-on-value-chain/write/component/lib/capability/identify-capability.mjs';

export const IDENTIFY_CAPABILITY_TOOL: McpToolDefinition = {
  name: 'identifyCapability',
  description:
    'Identify the true underlying capability or need behind a Wardley Map component label. ' +
    'Decodes technical solution names (CRM, ERP, Kubernetes...) into the capability they serve, ' +
    'classified by nature (activity, practice, knowledge, data). ' +
    'Only works for component and pipeline types — other types (anchor, market, ecosystem) are returned as-is.',
  inputSchema: z.toJSONSchema(IdentifyCapabilityInputSchema, { io: 'input' }) as JsonSchema,
};

export async function handleIdentifyCapability(args: Record<string, unknown>): Promise<unknown> {
  const parsed: IdentifyCapabilityInput = IdentifyCapabilityInputSchema.parse(args);
  if (!parsed?.name || typeof parsed.name !== 'string' || parsed.name.trim().length === 0) {
    throw new Error('Required parameter "name" must be a non-empty string');
  }

  const component = {
    name: parsed.name.trim(),
    ...(parsed.type && { type: parsed.type }),
    ...(parsed.description && { description: parsed.description.trim() }),
    ...(parsed.context && { context: parsed.context.trim() }),
  };

  return identifyCapability(component, getStrategyLLM('identify-capability'));
}
