// LLM Direct strategy: asks an LLM to directly estimate evolution for a
// Wardley Map component by reasoning about the underlying capability
// (activity, practice, knowledge, or data) it represents.
//
// Implements the core BaseStrategy contract with methodId
// `wardley:map:climate:position-functional-in-evolution:llm-direct`. Constructor `llmCall` is
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
import { getPrompt, type BuiltPrompt } from '#lib/prompts/registry.mjs';
import { getStrategyLLM } from '#lib/llm/registry.mjs';

const NEW_METHOD_ID = 'wardley:map:climate:position-functional-in-evolution:llm-direct';

/** The last line that opens with `<key>=`, ignoring leading blanks. The
 *  prompts ask for the value on the last lines of the reply, so the conclusion
 *  is read — not the first time the word appears in the reasoning. */
export function lastKeyLine(text: string, key: string): string | undefined {
  const line = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, 'i');
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(line);
    if (match !== null) return match[1].trim();
  }
  return undefined;
}

// Corrected from the wardley-evolution-benchmark port (llm-direct 2.0.0): the
// previous parser (parseKeyValueBlock, unanchored, separator 'any') kept the
// FIRST mention of the key anywhere in the prose — "the evolution of this
// market is fast" was read as the answer; 20 to 23 of 26 benchmark cases were
// refused or misread for it. A present but non-numeric value threw nowhere and
// flowed on as NaN; it now throws. An absent confidence still defaults to 0.6.
export function parseLLMDirectResponse(text: string): { evolution: number; confidence: number } {
  const rawEvolution = lastKeyLine(text, 'evolution');
  if (rawEvolution === undefined) {
    throw new Error(`LLMDirectStrategy: no "evolution=" line in the LLM response: ${text.slice(0, 200)}`);
  }
  const evolution = Number.parseFloat(rawEvolution);
  if (!Number.isFinite(evolution)) throw new Error(`LLMDirectStrategy: "evolution=${rawEvolution}" is not a number`);
  const rawConfidence = lastKeyLine(text, 'confidence');
  const confidence = rawConfidence === undefined ? 0.6 : Number.parseFloat(rawConfidence);
  if (!Number.isFinite(confidence)) throw new Error(`LLMDirectStrategy: "confidence=${rawConfidence}" is not a number`);
  return { evolution, confidence };
}

// any: llmCall closure shape is provider-dependent (see #lib/llm)
type LlmCallFn = (user: string, ...args: unknown[]) => Promise<string>;

/** A bare integer below 10000 is a year, not epoch milliseconds: the timeline
 *  strategy passes each milestone's year as a number, and `new Date(1995)` is
 *  1970 — every milestone was evaluated "in 1970" (found by the
 *  wardley-evolution-benchmark port). */
export function yearOf(date: string | number | Date): number {
  if (typeof date === 'number' && Number.isInteger(date) && Math.abs(date) < 10_000) return date;
  return new Date(date).getFullYear();
}

function buildPrompt(component: ComponentInput): BuiltPrompt {
  const hasCapability = component.capability != null;
  const dateStr = String(component.date ? yearOf(component.date) : 'unknown');
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

