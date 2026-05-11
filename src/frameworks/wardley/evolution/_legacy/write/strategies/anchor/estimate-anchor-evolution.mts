// Estimate the evolution position of an anchor (user need / stakeholder)
// in a Wardley Map using the consumption culture lens.
//
// Unlike components evaluated by technical maturity, anchors are assessed
// through two perception dimensions mapped to the 4 evolution phases:
//   1. User perception (how end-users perceive the offering)
//   2. Industry perception (how the market/industry views it)
//
// The MCP tool wrapper lives in src/mcp/estimate-anchor-evolution.tool.mts.

import { evolutionToStage } from '#lib/response-formatter.mjs';
import { parseKeyValueBlock } from '#lib/prompts/parsers.mjs';
import { getPrompt } from '#lib/prompts/registry.mjs';
import { tryDegradeAmbient, getCurrentCollector } from '#lib/degradation/index.mjs';

// ─── Anchor Perception Model ───────────────────────────────────────────────

const PHASE_MIDPOINTS = { 1: 0.09, 2: 0.29, 3: 0.55, 4: 0.85 };

const USER_PERCEPTION = {
  1: 'Différent / déroutant / excitant / surprenant',
  2: 'Avant-garde / émergente',
  3: 'Commun / Déçu de ne pas l\'utiliser / Déçu qu\'il ne soit pas disponible',
  4: 'Standard / Attendu',
};

const INDUSTRY_PERCEPTION = {
  1: 'Avantage concurrentiel / Imprévisible / Inconnu',
  2: 'Avantage concurrentiel / ROI / Cas d\'exemple',
  3: 'Avantage par l\'implémentation / fonctionnalités',
  4: 'Coût d\'entrée / Partie indéniable des affaires / Répandu',
};

// Prompt text lives in prompts/anchor-evolution.md. Resolved via getPrompt('anchor-evolution').

// ─── Response Parsing ──────────────────────────────────────────────────────

export function parseAnchorResponse(text: string): { phase: number; justification: string; confidence: number } {
  const raw = parseKeyValueBlock(text, ['phase', 'justification', 'confidence']);

  // Original regex captured only the first digit (/^phase=(\d)/), preserve by taking the first char.
  const phaseRaw = raw.phase?.[0];
  if (!phaseRaw || !/\d/.test(phaseRaw)) {
    throw new Error(`estimateAnchorEvolution: could not parse LLM response: ${text.slice(0, 200)}`);
  }

  const phase = parseInt(phaseRaw, 10);

  if (phase < 1 || phase > 4) {
    throw new Error(`estimateAnchorEvolution: phase out of range (user=${phase})`);
  }

  return {
    phase,
    justification: raw.justification ?? '',
    confidence: raw.confidence !== undefined ? parseFloat(raw.confidence) : 0.5,
  };
}

// ─── Core Evaluation ───────────────────────────────────────────────────────

// any: args is the raw MCP arguments bag; llmCall is a closure with diverse signatures
export async function estimateAnchorEvolution(args: any, llmCall: any): Promise<any> {
  const { name, context } = args;

  let phase, justification, source, confidence;

  if (args.phase != null) {
    phase = args.phase;
    justification = 'Provided by user';
    source = 'user';
    confidence = 1.0;
  } else {
    const p = getPrompt('anchor-evolution');
    const built = p.build({ anchor: name, context });
    // Wrap the LLM call: a failure flips the ambient MCP envelope's
    // degraded flag and falls back to phase 2 (Custom-built) at low
    // confidence rather than throwing.
    const response = await tryDegradeAmbient(
      'llm:anchor-evolution',
      () => llmCall(built.user, undefined, { systemPrompt: built.system }),
      '',
    );
    if (response) {
      const parsed = p.parse(response);
      phase = parsed.phase;
      justification = parsed.justification;
      source = 'llm';
      confidence = parsed.confidence;
    } else {
      // tryDegradeAmbient returned the empty fallback — record the
      // recovery decision and use a safe neutral default.
      phase = 2;
      justification = 'LLM call failed — defaulting to phase 2 (Custom-built)';
      source = 'fallback';
      confidence = 0.2;
      const collector = getCurrentCollector();
      if (collector) {
        collector.record({
          source: 'llm:anchor-evolution',
          reason: 'LLM returned empty response — using phase 2 fallback',
          severity: 'warning',
          recoverable: true,
        });
      }
    }
  }

  const evolution = (PHASE_MIDPOINTS as Record<number, number>)[phase];
  const stage = evolutionToStage(evolution);

  return {
    evolution: parseFloat(evolution.toFixed(3)),
    confidence,
    method: 'anchor-perception',
    name,
    context,
    perception: {
      phase,
      userDescriptor: (USER_PERCEPTION as Record<number, string>)[phase],
      industryDescriptor: (INDUSTRY_PERCEPTION as Record<number, string>)[phase],
      justification,
      source,
    },
    stage: { name: stage.name, rangeMin: stage.rangeMin, rangeMax: stage.rangeMax },
  };
}

// ─── Core BaseStrategy wrapper class ────────────────────────────────────────
//
// Wraps the `estimateAnchorEvolution` function in the core BaseStrategy
// contract. The function above stays exported for the MCP tool wrapper
// (`src/mcp/estimate-anchor-evolution.tool.mts`) and the legacy dispatcher.
// methodId follows the framework convention: this is a write operation
// against the anchor subdomain, using the consumption-culture phase model.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { LLMCall } from '#types/llm.mjs';
import { getStrategyLLM } from '#lib/llm/registry.mjs';

const NEW_METHOD_ID_ANCHOR = 'wardley:evolution:write:anchor:culture-phase';

// any: input is the raw MCP arguments bag for anchor evolution
export interface AnchorEvolutionInput {
  name: string;
  context?: string;
  phase?: number;
}

// any: output mirrors the legacy estimateAnchorEvolution return shape
export type AnchorEvolutionResult = Awaited<ReturnType<typeof estimateAnchorEvolution>>;

export class EstimateAnchorEvolutionStrategy
  extends CoreBaseStrategy<AnchorEvolutionInput, AnchorEvolutionResult>
{
  // any: llmCall closure shape is provider-dependent
  private readonly _llmCall: LLMCall | null;

  constructor(options: { llmCall?: LLMCall } = {}) {
    super();
    this._llmCall = options.llmCall ?? null;
  }

  static get method(): string {
    return NEW_METHOD_ID_ANCHOR;
  }

  async evaluate(
    input: AnchorEvolutionInput,
    _context: RequestContext,
  ): Promise<StrategyResult<AnchorEvolutionResult>> {
    // any: legacy registry id 'anchor-evolution' is not in the StrategyId enum yet.
    const llmCall: LLMCall = this._llmCall ?? (await getStrategyLLM('anchor-evolution' as any) as LLMCall);
    const result = await estimateAnchorEvolution(input, llmCall);

    const capturedAt = new Date().toISOString();
    return {
      signals: [
        { name: 'name', value: input.name, source: 'user-input', capturedAt },
        ...(input.context
          ? [{ name: 'context', value: input.context, source: 'user-input' as const, capturedAt }]
          : []),
        ...(input.phase != null
          ? [{ name: 'phase', value: input.phase, source: 'user-input' as const, capturedAt }]
          : []),
      ],
      reasoning: [],
      insights: result.perception?.justification
        ? [{
            text: result.perception.justification,
            by: NEW_METHOD_ID_ANCHOR,
            type: 'other' as const,
            confidence: result.confidence,
          }]
        : [],
      result,
    };
  }
}

