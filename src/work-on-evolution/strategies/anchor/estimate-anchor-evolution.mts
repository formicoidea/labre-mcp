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
import { createLLMCall } from '../../../lib/llm/llm-call.mjs';
import { logDebug } from '../../../lib/mcp-notifications.mjs';
import { evolutionToStage } from '../../../lib/response-formatter.mjs';

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

// ─── LLM Prompt ────────────────────────────────────────────────────────────

const ANCHOR_EVALUATION_PROMPT = `You are an expert in Wardley Mapping and Stakeholder consumption culture analysis.

An ANCHOR in a Wardley Map represents the stakeholder at the top of the value chain. Wardley Maps are user-centric.
It is NOT a technical component but a user-facing need or expectation.

Anchors are evaluated through their CONSUMPTION CULTURE in the provided context using two properties to guide you.

Anchor: {{anchor}}
Context: {{context}}

PROPERTY 1 — User Perception (Perception des utilisateurs):
  Phase 1: Different / Confusing / Exciting / Surprising
  Phase 2: Leading-edge / Emerging
  Phase 3: Common / Disappointed if not used / Disappointed if not available
  Phase 4: Standard / Expected

PROPERTY 2 — Industry Perception (Perception dans l'industrie):
  Phase 1: Competitive advantage / Unpredictable / Unknown
  Phase 2: Competitive advantage / ROI / Case studies
  Phase 3: Advantage through implementation / features
  Phase 4: Cost of doing business / Widespread

Determine which phase (1, 2, 3 or 4) best describes this anchor in its given context.

MANDATORY FORMAT: exactly three lines at the end, no additional text after them:
phase=N
justification=<brief explanation of why this phase was chosen>
confidence=X.XX (a number between 0 and 1 reflecting your overall confidence)`;

// ─── Response Parsing ──────────────────────────────────────────────────────

function parseAnchorResponse(text: string): { phase: number; justification: string; confidence: number } {
  const phaseMatch = text.match(/^phase=(\d)/mi);
  const justMatch = text.match(/^justification=(.*)/mi);
  const confidenceMatch = text.match(/^confidence=(.*)/mi);

  if (!phaseMatch) {
    throw new Error(`estimateAnchorEvolution: could not parse LLM response: ${text.slice(0, 200)}`);
  }

  const phase = parseInt(phaseMatch[1], 10);

  if (phase < 1 || phase > 4) {
    throw new Error(`estimateAnchorEvolution: phase out of range (user=${phase})`);
  }

  return {
    phase,
    justification: justMatch ? justMatch[1].trim() : '',
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5,
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
    const prompt = ANCHOR_EVALUATION_PROMPT
      .replace('{{anchor}}', name)
      .replace('{{context}}', context);

    const response = await llmCall(prompt);
    const parsed = parseAnchorResponse(response);
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

// ─── Lazy LLM Singleton ────────────────────────────────────────────────────

let _llmCall: ReturnType<typeof createLLMCall> | null = null;
function getLLMCall(): ReturnType<typeof createLLMCall> {
  if (!_llmCall) {
    const model = process.env.WARDLEY_LLM_MODEL || 'claude-sonnet-4-6';
    logDebug('estimateAnchorEvolution', `LLM backend: Agent SDK, model="${model}"`);
    _llmCall = createLLMCall({
      model,
      effort: 'high',
      maxBudgetUsd: 0.10,
    });
  }
  return _llmCall;
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
  return estimateAnchorEvolution(input, getLLMCall());
}
