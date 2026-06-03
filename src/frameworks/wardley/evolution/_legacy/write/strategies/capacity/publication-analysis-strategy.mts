// Publication analysis strategy: estimates evolution from a probability
// distribution over the four Wardley phases.
//
// The distribution may be provided directly (component.phaseDistribution)
// or estimated by an injected LLM call from the component name + context.
//
// Implements the core BaseStrategy contract with methodId
// `wardley:map:climate:position-functional-in-evolution:publication-analysis`. Optional `llmCall`
// constructor; falls back to `getStrategyLLM('publication-analysis')`.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { ComponentInput, EvolutionResult, PhaseDistribution } from '#types/evolution.mjs';
import type { LLMCall } from '#types/llm.mjs';
import { phase4Distribution } from '#schemas/inputs.schema.mjs';
import {
  centroidEvolution,
  concentrationConfidence,
} from '#lib/phase-distribution.mjs';
import { getPrompt } from '#lib/prompts/registry.mjs';
import { getStrategyLLM } from '#lib/llm/registry.mjs';

const NEW_METHOD_ID = 'wardley:map:climate:position-functional-in-evolution:publication-analysis';

/**
 * Parse LLM response into phase probabilities.
 * Anchors on one `phaseN=value` line per phase, ignoring any prose above.
 */
function parsePubResponse(text: string): { p1: number; p2: number; p3: number; p4: number } {
  const NUM = '(\\d+(?:\\.\\d+)?|\\.\\d+)';
  const lineFor = (key: string) => new RegExp(`^\\s*${key}\\s*[:=]\\s*${NUM}\\s*$`, 'im');
  const m1 = text.match(lineFor('phase1'));
  const m2 = text.match(lineFor('phase2'));
  const m3 = text.match(lineFor('phase3'));
  const m4 = text.match(lineFor('phase4'));
  if (!m1 || !m2 || !m3 || !m4) {
    throw new Error(
      `PublicationAnalysisStrategy: could not parse response: ${text.slice(0, 200)}`,
    );
  }
  const vals = {
    p1: parseFloat(m1[1]),
    p2: parseFloat(m2[1]),
    p3: parseFloat(m3[1]),
    p4: parseFloat(m4[1]),
  };
  for (const [k, v] of Object.entries(vals)) {
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`PublicationAnalysisStrategy: invalid ${k} value parsed from LLM response`);
    }
  }
  return vals;
}

interface DistributionAndTrace {
  distribution: PhaseDistribution;
  llmResponse: string | null; // present when LLM was called, null when phaseDistribution was provided
}

async function obtainDistribution(
  component: ComponentInput,
  llmCall: LLMCall | null,
): Promise<DistributionAndTrace> {
  if (component.phaseDistribution) {
    return { distribution: component.phaseDistribution, llmResponse: null };
  }
  if (!llmCall) {
    throw new Error(
      'PublicationAnalysisStrategy: requires phaseDistribution on the component, or an llmCall function for estimation',
    );
  }
  const p = getPrompt('publication-analysis');
  const built = p.build({
    component: component.name || '',
    description: component.description ?? '',
    context: component.context ?? '',
  });
  const response = await llmCall(built.user, undefined, { systemPrompt: built.system });
  // any: prompt registry parse signature is dynamic
  const parsed = p.parse(response) as { p1: number; p2: number; p3: number; p4: number };
  const sum = parsed.p1 + parsed.p2 + parsed.p3 + parsed.p4;
  if (sum === 0) {
    throw new Error('PublicationAnalysisStrategy: all phase probabilities are zero');
  }
  const distribution = phase4Distribution(
    parsed.p1 / sum,
    parsed.p2 / sum,
    parsed.p3 / sum,
    parsed.p4 / sum,
  );
  return { distribution, llmResponse: response };
}

export class PublicationAnalysisStrategy extends CoreBaseStrategy<ComponentInput, EvolutionResult> {
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
    _context: RequestContext,
  ): Promise<StrategyResult<EvolutionResult>> {
    // any: getStrategyLLM returns an LLM call function — type intentionally open
    const llmCall: LLMCall =
      this._llmCall ?? (await getStrategyLLM('publication-analysis') as LLMCall);

    const { distribution, llmResponse } = await obtainDistribution(component, llmCall);
    const evolution = centroidEvolution(distribution);
    const confidence = concentrationConfidence(distribution);

    const capturedAt = new Date().toISOString();
    return {
      signals: [
        {
          name: 'distribution',
          value: distribution,
          source: component.phaseDistribution ? 'user-input' : 'llm-internal',
          capturedAt,
        },
        ...(component.context
          ? [{ name: 'context', value: component.context, source: 'user-input' as const, capturedAt }]
          : []),
      ],
      reasoning: llmResponse
        ? [{ by: NEW_METHOD_ID, text: llmResponse }]
        : [],
      insights: [],
      result: {
        evolution,
        confidence,
        method: NEW_METHOD_ID,
        // any: legacy contract included a `trace` field — preserve under result for legacy callers
        trace: [{ distribution }],
      } as EvolutionResult,
    };
  }
}


// Export internals for testing
export { parsePubResponse };
