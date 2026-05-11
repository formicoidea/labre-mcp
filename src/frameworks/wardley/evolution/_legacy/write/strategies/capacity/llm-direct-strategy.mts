// LLM Direct strategy: asks an LLM to directly estimate evolution for a
// Wardley Map component by reasoning about the underlying capability
// (activity, practice, knowledge, or data) it represents.
//
// Implements the core BaseStrategy contract with methodId
// `wardley:evolution:write:capacity:llm-direct`. Constructor `llmCall` is
// optional — when omitted, the strategy falls back to `getStrategyLLM(method)`
// at evaluate time, so the kernel recipe runner can `new LLMDirectStrategy()`
// with no args.
//
// Progressive ARCH-22 capture: the raw LLM response is captured verbatim
// in `reasoning[0].text` (gratuitous — no extra cost). Signals capture
// the typed inputs (capability/date/context).

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { ComponentInput, EvolutionResult } from '#types/evolution.mjs';
import { parseKeyValueBlock } from '#lib/prompts/parsers.mjs';
import { getPrompt, type BuiltPrompt } from '#lib/prompts/registry.mjs';
import { getStrategyLLM } from '#lib/llm/registry.mjs';

const NEW_METHOD_ID = 'wardley:evolution:write:capacity:llm-direct';

// any: prompt-registry parse outputs are dynamically typed; the legacy parser
// returns {evolution: number, confidence: number}
export function parseLLMDirectResponse(text: string): { evolution: number; confidence: number } {
  const raw = parseKeyValueBlock(text, ['evolution', 'confidence'], { separator: 'any', anchored: false });
  if (raw.evolution === undefined) {
    throw new Error(`LLMDirectStrategy: could not parse LLM response: ${text.slice(0, 200)}`);
  }
  return {
    evolution: parseFloat(raw.evolution),
    confidence: raw.confidence !== undefined ? parseFloat(raw.confidence) : 0.6,
  };
}

// any: llmCall closure shape is provider-dependent (see #lib/llm)
type LlmCallFn = (user: string, ...args: unknown[]) => Promise<string>;

function buildPrompt(component: ComponentInput): BuiltPrompt {
  const hasCapability = component.capability != null;
  const dateStr = String(component.date ? new Date(component.date).getFullYear() : 'unknown');
  const p = hasCapability
    ? getPrompt('historical-evolution', 'with-capability')
    : getPrompt('historical-evolution', 'without-capability');
  return hasCapability
    ? p.build({
        capability: component.capability ?? '',
        description: component.description ?? '',
        context: component.context ?? '',
        date: dateStr,
      })
    : p.build({
        component: component.name || '',
        description: component.description ?? '',
        context: component.context ?? '',
        date: dateStr,
      });
}

function parseResponse(response: string, hasCapability: boolean): { evolution: number; confidence: number } {
  const p = hasCapability
    ? getPrompt('historical-evolution', 'with-capability')
    : getPrompt('historical-evolution', 'without-capability');
  // any: registry parse signature is dynamic
  return p.parse(response) as { evolution: number; confidence: number };
}

export class LLMDirectStrategy extends CoreBaseStrategy<ComponentInput, EvolutionResult> {
  private readonly _llmCall: LlmCallFn | null;

  // any: legacy constructor convention — options bag with optional llmCall
  constructor(options: { llmCall?: LlmCallFn } = {}) {
    super();
    this._llmCall = options.llmCall ?? null;
  }

  static get method(): string {
    return NEW_METHOD_ID;
  }

  async evaluate(
    component: ComponentInput,
    _context: RequestContext,
  ): Promise<StrategyResult<EvolutionResult>> {
    // any: getStrategyLLM returns an LLM call function — type intentionally open.
    // 'llm-direct' is the short strategy key in llm.config.json. The 5-segment
    // NEW_METHOD_ID is the canonical methodId for the core registry.
    const llmCall: LlmCallFn = this._llmCall ?? (await getStrategyLLM('llm-direct') as LlmCallFn);

    const hasCapability = component.capability != null;
    const built = buildPrompt(component);
    const response = await llmCall(built.user, undefined, { systemPrompt: built.system });
    const parsed = parseResponse(response, hasCapability);

    const evolution = Math.round(Math.max(0, Math.min(1, parsed.evolution)) * 1000) / 1000;
    const confidence = Math.round(Math.max(0.1, Math.min(1, parsed.confidence)) * 1000) / 1000;

    const capturedAt = new Date().toISOString();
    return {
      signals: [
        ...(component.capability ? [{ name: 'capability', value: component.capability, source: 'user-input' as const, capturedAt }] : []),
        ...(component.date ? [{ name: 'date', value: String(component.date), source: 'user-input' as const, capturedAt }] : []),
        ...(component.context ? [{ name: 'context', value: component.context, source: 'user-input' as const, capturedAt }] : []),
      ],
      reasoning: [
        { by: NEW_METHOD_ID, text: response },
      ],
      insights: [],
      result: {
        evolution,
        confidence,
        method: NEW_METHOD_ID,
      },
    };
  }
}

