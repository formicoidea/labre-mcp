// Logprob distribution strategy: uses LLM token-level log-probabilities
// to build a probability distribution over the 4 Wardley evolution phases,
// then reduces it to a scalar evolution + entropy-based confidence.
//
// Requires an LLM logprob call function to be injected at construction time.
//
// The strategy:
//   1. Asks the LLM to classify the component into exactly one phase
//      (phase1..phase4)
//   2. Extracts logprobs for the four phase tokens from the response
//   3. Converts logprobs to probabilities via softmax → PhaseDistribution
//   4. Computes evolution via centroidEvolution()
//   5. Confidence via entropyConfidence() (peaked = high, uniform = low)

import { BaseStrategy } from './base-strategy.mjs';
import type { ComponentInput, EvolutionResult } from '../../../../types/evolution.mjs';
import { PHASE_CENTROIDS, phase4Distribution } from '../../../../schemas/inputs.schema.mjs';
import {
  centroidEvolution,
  entropyConfidence,
} from '../../../../lib/phase-distribution.mjs';
import { getPrompt } from '../../../../lib/prompts/registry.mjs';

const PHASE_NAMES = ['phase1', 'phase2', 'phase3', 'phase4'] as const;
type PhaseName = (typeof PHASE_NAMES)[number];

// Prompt text lives in prompts/logprob-distribution.md. Resolved via getPrompt().

interface LogprobEntry {
  token: string;
  logprob: number;
}

/**
 * Extract per-phase probabilities from a top-logprobs response.
 * Matches tokens that contain or are contained by a phase name (lowercased).
 * Falls back to uniform when no token matches any phase.
 */
function extractPhaseProbabilities(logprobs: LogprobEntry[] | null | undefined): Record<PhaseName, number> {
  const phaseLogprobs: Record<PhaseName, number> = {
    phase1: -Infinity,
    phase2: -Infinity,
    phase3: -Infinity,
    phase4: -Infinity,
  };

  if (logprobs && logprobs.length > 0) {
    for (const entry of logprobs) {
      const token = entry.token.trim().toLowerCase();
      for (const phase of PHASE_NAMES) {
        if (phase.startsWith(token) || token.startsWith(phase)) {
          phaseLogprobs[phase] = Math.max(phaseLogprobs[phase], entry.logprob);
        }
      }
    }
  }

  const hasAnyMatch = Object.values(phaseLogprobs).some(lp => lp > -Infinity);
  if (!hasAnyMatch) {
    const uniform = 1 / PHASE_NAMES.length;
    return { phase1: uniform, phase2: uniform, phase3: uniform, phase4: uniform };
  }

  const maxLp = Math.max(
    ...Object.values(phaseLogprobs).filter(v => v > -Infinity),
  );
  const expValues: Record<PhaseName, number> = { phase1: 0, phase2: 0, phase3: 0, phase4: 0 };
  let sumExp = 0;
  for (const phase of PHASE_NAMES) {
    if (phaseLogprobs[phase] === -Infinity) {
      expValues[phase] = 0;
    } else {
      expValues[phase] = Math.exp(phaseLogprobs[phase] - maxLp);
    }
    sumExp += expValues[phase];
  }

  const out: Record<PhaseName, number> = { phase1: 0, phase2: 0, phase3: 0, phase4: 0 };
  for (const phase of PHASE_NAMES) {
    out[phase] = sumExp > 0 ? expValues[phase] / sumExp : 1 / PHASE_NAMES.length;
  }
  return out;
}

/**
 * Text-only fallback when logprobs are not available: parse the phase name
 * from the response and produce a peaked distribution.
 */
export function parseFallbackPhase(text: string): Record<PhaseName, number> {
  const lower = (text || '').toLowerCase().trim();
  let matched: PhaseName | null = null;
  for (const phase of PHASE_NAMES) {
    if (lower.includes(phase)) {
      matched = phase;
      break;
    }
  }
  const out: Record<PhaseName, number> = { phase1: 0, phase2: 0, phase3: 0, phase4: 0 };
  for (const phase of PHASE_NAMES) {
    if (phase === matched) out[phase] = 0.85;
    else out[phase] = matched ? 0.05 : 0.25;
  }
  return out;
}

export class LogprobDistributionStrategy extends BaseStrategy {
  _llmLogprobCall: import('../../../../types/llm.mjs').LogprobLLMCall;

  // any: constructor options bag — test/integration harness shape varies
  constructor({ llmLogprobCall }: any = {}) {
    super();
    if (typeof llmLogprobCall !== 'function') {
      throw new Error('LogprobDistributionStrategy requires an llmLogprobCall function');
    }
    this._llmLogprobCall = llmLogprobCall;
  }

  static get method() {
    return 'write:capacity:logprob-distribution';
  }

  async evaluate(component: ComponentInput): Promise<EvolutionResult> {
    const p = getPrompt('logprob-fallback');
    const built = p.build({
      component: component.name || '',
      description: component.description ?? '',
      context: component.context ?? '',
    });

    if (!component.context) {
      console.warn(
        `[${LogprobDistributionStrategy.method}] no context provided for "${component.name}" — evaluation accuracy may be degraded`,
      );
    }

    const { text, logprobs } = await this._llmLogprobCall(built.user, undefined, { systemPrompt: built.system });

    const probs = (logprobs && logprobs.length > 0)
      ? extractPhaseProbabilities(logprobs)
      : (p.parse(text) as Record<PhaseName, number>);

    const distribution = phase4Distribution(
      probs.phase1,
      probs.phase2,
      probs.phase3,
      probs.phase4,
    );

    const result = {
      evolution: centroidEvolution(distribution),
      confidence: entropyConfidence(distribution),
      method: LogprobDistributionStrategy.method,
      trace: [{ distribution }],
    };

    return BaseStrategy.validateResult(result);
  }
}

// Export internals for testing
export { extractPhaseProbabilities, PHASE_CENTROIDS };
