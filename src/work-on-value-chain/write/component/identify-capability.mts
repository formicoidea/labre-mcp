// Identify the true underlying capability or need behind a component label.
//
// Reusable module: can be called by any strategy or tool that needs to
// decode technical solution names (CRM, ERP, Kubernetes…) into the
// capability they serve, classified by type and nature.
//
// Also exposes an MCP tool definition (IDENTIFY_CAPABILITY_TOOL) and
// handler (handleIdentifyCapability) for direct invocation via MCP clients.

import { z } from 'zod';
import type { McpToolDefinition, JsonSchema } from '../../../types/mcp.mjs';
import { IdentifyCapabilityInputSchema, type IdentifyCapabilityInput } from '../../../schemas/identify-capability.schema.mjs';
import type { ParsedCapabilityResponse } from '../../../schemas/parsed-llm.schema.mjs';
import { getStrategyLLM } from '../../../lib/llm/registry.mjs';
import { logDebug } from '../../../lib/mcp-notifications.mjs';
import { parseKeyValueBlock } from '../../../lib/prompts/parsers.mjs';
import { getPrompt } from '../../../lib/prompts/registry.mjs';
import { tryDegradeAmbient } from '../../../lib/degradation/index.mjs';

const ELIGIBLE_TYPES = new Set(['component', 'pipeline']);

// Prompt text lives in prompts/identify-capability.md. Resolved via getPrompt().

/**
 * Parse LLM capability identification response.
 * Input type (from OWM DSL) always takes priority over LLM-estimated type.
 * @param {string} text - Raw LLM response
 * @param {{ name: string, type?: string, context?: string }} component - Input component
 * @returns {{ type: string, nature: string, capability: string, confidence: number, justification: string, context: string, name: string }}
 */
// any: component is the loose MCP input (name/type/description/context)
export function parseCapabilityResponse(text: string, component: any): ParsedCapabilityResponse {
  const raw = parseKeyValueBlock(text, ['type', 'nature', 'capability', 'confidence', 'justification']);

  if (raw.capability === undefined) {
    throw new Error(`identifyCapability: could not parse LLM response: ${text.slice(0, 200)}`);
  }

  // Original regex for `type` and `nature` captured \S+ (first token).
  // parseKeyValueBlock captures the full line; reduce to the first token to preserve semantics.
  const firstToken = (s: string | undefined) => s?.split(/\s+/)[0];
  const llmType = firstToken(raw.type)?.toLowerCase() ?? 'component';

  return {
    type: component.type || llmType,
    nature: firstToken(raw.nature)?.toLowerCase() ?? 'none',
    capability: raw.capability,
    context: component.context || '',
    name: component.name || '',
    confidence: raw.confidence !== undefined ? parseFloat(raw.confidence) : 0.5,
    justification: raw.justification ?? '',
  };
}

/**
 * Identify the true underlying capability or need behind a component label.
 *
 * When type is provided (from OWM DSL):
 *   - anchor/market/ecosystem → skip immediately, no LLM call
 *   - component/pipeline → LLM identifies nature/capability, input type is authoritative
 *
 * When type is absent:
 *   - LLM estimates type + nature + capability (no penalty)
 *
 * @param {{ name: string, type?: string, description?: string, context?: string }} component
 * @param {function(string): Promise<string>} llmCall
 * @returns {Promise<{ type: string, nature: string, capability: string, confidence: number, justification: string }>}
 */
// any: component is the loose MCP input; llmCall is a closure with diverse signatures
export async function identifyCapability(component: any, llmCall?: any): Promise<any> {
  // When type is known and non-eligible, skip immediately
  if (component.type && !ELIGIBLE_TYPES.has(component.type)) {
    return {
      type: component.type,
      nature: 'none',
      capability: component.name || '',
      context: component.context || '',
      name: component.name || '',
      confidence: 1,
      justification: `Type "${component.type}" is not eligible for capability identification (only component and pipeline are)`,
      skipped: true,
    };
  }

  const p = getPrompt('identify-capability');
  const built = p.build({
    component: component.name || '',
    description: component.description ?? '',
    context: component.context ?? '',
  });
  // Wrap the LLM call so a failure (rate limit, auth, network) surfaces
  // on the ambient degradation collector — the caller still receives a
  // valid capability shape, but the MCP envelope flips degraded:true.
  const response = await tryDegradeAmbient(
    'llm:identify-capability',
    () => llmCall(built.user, undefined, { systemPrompt: built.system }),
    '',
  );
  const result = p.parse(response, component);

  // When type was not provided, check if LLM-estimated type is non-eligible
  if (!component.type && !ELIGIBLE_TYPES.has(result.type)) {
    return {
      ...result,
      nature: 'none',
      capability: component.name || '',
      skipped: true,
    };
  }

  return result;
}

// ─── MCP Tool Definition ───────────────────────────────────────────────────

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
  // Map parsed input onto the legacy local `args` name for minimal downstream diff
  args = parsed as Record<string, unknown>;
  if (!args?.name || typeof args.name !== 'string' || args.name.trim().length === 0) {
    throw new Error('Required parameter "name" must be a non-empty string');
  }

  const name = args.name as string;
  const type = args.type as string | undefined;
  const description = args.description as string | undefined;
  const context = args.context as string | undefined;
  const component = {
    name: name.trim(),
    ...(type && { type }),
    ...(description && { description: description.trim() }),
    ...(context && { context: context.trim() }),
  };

  return identifyCapability(component, getStrategyLLM('identify-capability'));
}
