// Identify the true underlying capability or need behind a component label.
//
// Reusable module: can be called by any strategy or tool that needs to
// decode technical solution names (CRM, ERP, Kubernetes…) into the
// capability they serve, classified by type and nature.
//
// The MCP tool wrapper lives in src/mcp/identify-capability.tool.mts.

import type { ParsedCapabilityResponse } from '#schemas/parsed-llm.schema.mjs';
import { parseKeyValueBlock } from '#lib/prompts/parsers.mjs';
import { getPrompt } from '#lib/prompts/registry.mjs';
import { tryDegradeAmbient } from '#lib/degradation/index.mjs';

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

// ─── Core BaseStrategy wrapper class ────────────────────────────────────────
//
// Wraps the `identifyCapability` function in the core BaseStrategy contract.
// The function above stays exported because timeline-benchmark and the
// legacy dispatcher use it directly. This class lets recipes reference
// `wardley:map:node:identify:default` and dispatch
// through the kernel runner.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { LLMCall } from '#types/llm.mjs';
import { getStrategyLLM } from '#lib/llm/registry.mjs';

const NEW_METHOD_ID_IDENT = 'wardley:map:node:identify:default';

// any: input is the open MCP component shape (name/type/description/context)
export interface IdentifyCapabilityInput {
  name: string;
  type?: string;
  description?: string;
  context?: string;
}

export class IdentifyCapabilityStrategy
  extends CoreBaseStrategy<IdentifyCapabilityInput, ParsedCapabilityResponse>
{
  // any: llmCall closure shape is provider-dependent
  private readonly _llmCall: LLMCall | null;

  constructor(options: { llmCall?: LLMCall } = {}) {
    super();
    this._llmCall = options.llmCall ?? null;
  }

  static get method(): string {
    return NEW_METHOD_ID_IDENT;
  }

  async evaluate(
    component: IdentifyCapabilityInput,
    _context: RequestContext,
  ): Promise<StrategyResult<ParsedCapabilityResponse>> {
    const llmCall: LLMCall = this._llmCall ?? getStrategyLLM('identify-capability');
    const result = await identifyCapability(component, llmCall);

    const capturedAt = new Date().toISOString();
    return {
      signals: [
        { name: 'name', value: component.name, source: 'user-input', capturedAt },
        ...(component.type
          ? [{ name: 'type', value: component.type, source: 'user-input' as const, capturedAt }]
          : []),
        ...(component.context
          ? [{ name: 'context', value: component.context, source: 'user-input' as const, capturedAt }]
          : []),
      ],
      reasoning: [],
      insights: result.justification
        ? [{ text: result.justification, by: NEW_METHOD_ID_IDENT, type: 'other' as const, confidence: result.confidence }]
        : [],
      result,
    };
  }
}

