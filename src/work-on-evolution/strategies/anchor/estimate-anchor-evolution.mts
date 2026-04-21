// Estimate the evolution position of an anchor (user need / stakeholder)
// in a Wardley Map using the consumption culture lens.
//
// Unlike components evaluated by technical maturity, anchors are assessed
// through two perception dimensions mapped to the 4 evolution phases:
//   1. User perception (how end-users perceive the offering)
//   2. Industry perception (how the market/industry views it)
//
// Exposes an MCP tool (estimateAnchorEvolution) for direct invocation.

import { z } from 'zod';
import type { McpToolDefinition, JsonSchema } from '../../../types/mcp.mjs';
import { EstimateAnchorEvolutionInputSchema, type EstimateAnchorEvolutionInput } from '../../../schemas/estimate-anchor-evolution.schema.mjs';
import { getStrategyLLM } from '../../../lib/llm/registry.mjs';
import { logDebug } from '../../../lib/mcp-notifications.mjs';
import { evolutionToStage } from '../../../lib/response-formatter.mjs';
import { parseKeyValueBlock } from '../../../lib/prompts/parsers.mjs';
import { getPrompt } from '../../../lib/prompts/registry.mjs';

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
    const response = await llmCall(p.build({ anchor: name, context }));
    const parsed = p.parse(response);
    phase = parsed.phase;
    justification = parsed.justification;
    source = 'llm';
    confidence = parsed.confidence;
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

// ─── MCP Tool Definition ───────────────────────────────────────────────────

export const ESTIMATE_ANCHOR_EVOLUTION_TOOL: McpToolDefinition = {
  name: 'estimateAnchorEvolution',
  description:
    'Estimate the evolution position of an anchor (user need / stakeholder) in a Wardley Map. ' +
    'Unlike components evaluated by technical maturity, anchors are evaluated through ' +
    'the consumption culture lens (user perception + industry perception). ' +
    'The LLM determines a single evolution phase (1–4, Genesis → Commodity). ' +
    'A phase can be provided directly to skip LLM assessment.',
  inputSchema: z.toJSONSchema(EstimateAnchorEvolutionInputSchema, { io: 'input' }) as JsonSchema,
};

export async function handleEstimateAnchorEvolution(args: Record<string, unknown>): Promise<unknown> {
  const input: EstimateAnchorEvolutionInput = EstimateAnchorEvolutionInputSchema.parse(args);
  return estimateAnchorEvolution(input, getStrategyLLM('anchor-evolution'));
}
