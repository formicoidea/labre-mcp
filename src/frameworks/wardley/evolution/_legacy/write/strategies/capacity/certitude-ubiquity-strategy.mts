// Certitude × ubiquity → S-curve, with the two measures supplied by a model.
//
// SCurveStrategy is the instrument and takes certitude and ubiquity from its
// caller; until now only the promptfoo harness asked a model for them (prompt
// "D - sans mention de la temporalité" of promptfooconfig.yaml). This strategy
// makes that pairing a runtime strategy, as the wardley-evolution-benchmark
// measured it: one model call for seven values, of which only certitude and
// ubiquity place the component — the model's own evolution and its publication
// mix are other answers, kept as signals for comparison, never in its place.
//
// A certitude or ubiquity that is missing or outside [0, 1] throws: a guess
// must never pass as an answer. The prompt has no slot for a description, so
// `description` never reaches the model (a limit of the measured prompt).

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { ComponentInput, EvolutionResult } from '#types/evolution.mjs';
import { getPrompt } from '#lib/prompts/registry.mjs';
import { getStrategyLLM } from '#lib/llm/registry.mjs';
import type { LLMCall } from '#types/llm.mjs';
import { SCurveStrategy } from './s-curve-strategy.mjs';
import { lastKeyLine } from './llm-direct-strategy.mjs';

const NEW_METHOD_ID = 'wardley:map:climate:position-functional-in-evolution:certitude-ubiquity';

const OTHER_ANSWERS = ['evolution', 'pub_wonder', 'pub_build', 'pub_operate', 'pub_usage'] as const;

function require01(text: string, key: string): number {
  const raw = lastKeyLine(text, key);
  const value = raw === undefined ? NaN : Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`CertitudeUbiquityStrategy: "${key}=" missing or outside [0, 1] in the LLM response: ${text.slice(0, 200)}`);
  }
  return value;
}

export function parseCertitudeUbiquityResponse(text: string): {
  certitude: number;
  ubiquity: number;
  others: Partial<Record<(typeof OTHER_ANSWERS)[number], number>>;
} {
  const others: Partial<Record<(typeof OTHER_ANSWERS)[number], number>> = {};
  for (const key of OTHER_ANSWERS) {
    const value = Number.parseFloat(lastKeyLine(text, key) ?? '');
    if (Number.isFinite(value)) others[key] = value;
  }
  return { certitude: require01(text, 'certitude'), ubiquity: require01(text, 'ubiquity'), others };
}

export class CertitudeUbiquityStrategy extends CoreBaseStrategy<ComponentInput, EvolutionResult> {
  private readonly _llmCall: LLMCall | null;

  constructor(options: { llmCall?: LLMCall } = {}) {
    super();
    this._llmCall = options.llmCall ?? null;
  }

  static get method(): string {
    return NEW_METHOD_ID;
  }

  async evaluate(
    component: ComponentInput,
    context: RequestContext,
  ): Promise<StrategyResult<EvolutionResult>> {
    const llmCall = this._llmCall ?? getStrategyLLM('certitude-ubiquity');
    const p = getPrompt('certitude-ubiquity');
    const built = p.build({ component: component.name, context: component.context ?? '' });
    const response = await llmCall(built.user, undefined, built.system ? { systemPrompt: built.system } : undefined);
    const { certitude, ubiquity, others } = p.parse(response) as ReturnType<typeof parseCertitudeUbiquityResponse>;

    const projected = await new SCurveStrategy().evaluate({ ...component, certitude, ubiquity }, context);
    const capturedAt = new Date().toISOString();
    return {
      ...projected,
      signals: [
        ...projected.signals.map((s) => (s.name === 'certitude' || s.name === 'ubiquity' ? { ...s, source: 'llm-internal' as const } : s)),
        ...Object.entries(others).map(([name, value]) => ({ name: `llm_${name}`, value, source: 'llm-internal' as const, capturedAt })),
      ],
      reasoning: [{ by: NEW_METHOD_ID, text: response }],
      result: { ...projected.result, method: NEW_METHOD_ID },
    };
  }
}
