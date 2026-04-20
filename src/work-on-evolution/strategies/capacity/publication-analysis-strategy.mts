// Publication analysis strategy: estimates evolution from a probability
// distribution over the four Wardley phases.
//
// The distribution may be provided directly (component.phaseDistribution)
// or estimated by an injected LLM call from the component name + context.
//
// The strategy:
//   1. Obtains a PhaseDistribution (provided or LLM-estimated)
//   2. Computes evolution as the probability-weighted centroid of phase positions
//   3. Derives confidence from the concentration of the distribution
//      (peaked = high confidence, uniform = low confidence)

import { BaseStrategy } from './base-strategy.mjs';
import type { ComponentInput, EvolutionResult, PhaseDistribution } from '../../../types/evolution.mjs';
import { phase4Distribution } from '../../../schemas/inputs.schema.mjs';
import {
  centroidEvolution,
  concentrationConfidence,
} from '../../../lib/phase-distribution.mjs';
import { interpolate } from '../../../lib/prompts/interpolate.mjs';

const PUB_PROMPT_TEMPLATE = `You are an expert analyst in Wardley Mapping and technology maturity.

Your task is to estimate a probability distribution over the four Wardley evolution phases for a technology component.
DO NOT guess — reason step by step from observable signals (market adoption, standardization, documentation depth, feature maturity).

Component: {{component}}
Description: {{description}}
Context: {{context}}

REASONING STEPS:
1. What is the level of conceptual novelty vs. established understanding?
2. How standardized are the implementations? How many competing approaches exist?
3. How mature are the operational practices (monitoring, SRE, incident management)?
4. How ubiquitous and commoditized is consumption (APIs, vendor docs, pricing pages)?
5. Observable phase characteristics:
   - phase1 (Genesis): novel, experimental, poorly defined, rapid change, wonder-type publications
   - phase2 (Custom): emerging understanding, build-type publications, tutorials, competing early implementations
   - phase3 (Product): well-understood, operational best practices, feature differentiation, operate-type publications
   - phase4 (Commodity): standardized, utility-like, cost-driven, usage-type documentation, ubiquitous
6. Consider temporal dynamics and ecosystem breadth.

Assign a probability to each phase. The four probabilities MUST sum to approximately 1.0.

MANDATORY FORMAT: exactly four lines at the end, no additional text after them:
phase1=P.PP
phase2=P.PP
phase3=P.PP
phase4=P.PP`;

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

export class PublicationAnalysisStrategy extends BaseStrategy {
  _llmCall: ((prompt: string) => Promise<string>) | null;

  // any: constructor options bag — injected dependencies vary by test/integration harness
  constructor({ llmCall }: any = {}) {
    super();
    this._llmCall = llmCall || null;
  }

  static get method() {
    return 'publication-analysis';
  }

  async evaluate(component: ComponentInput): Promise<EvolutionResult> {
    let distribution: PhaseDistribution;

    if (component.phaseDistribution) {
      distribution = component.phaseDistribution;
    } else if (this._llmCall) {
      const prompt = interpolate(PUB_PROMPT_TEMPLATE, {
        component: component.name || '',
        description: component.description ?? '',
        context: component.context ?? '',
      });

      if (!component.context) {
        console.warn(
          `[${PublicationAnalysisStrategy.method}] no context provided for "${component.name}" — evaluation accuracy may be degraded`,
        );
      }

      const response = await this._llmCall(prompt);
      const parsed = parsePubResponse(response);
      const sum = parsed.p1 + parsed.p2 + parsed.p3 + parsed.p4;
      if (sum === 0) {
        throw new Error('PublicationAnalysisStrategy: all phase probabilities are zero');
      }
      distribution = phase4Distribution(
        parsed.p1 / sum,
        parsed.p2 / sum,
        parsed.p3 / sum,
        parsed.p4 / sum,
      );
    } else {
      throw new Error(
        'PublicationAnalysisStrategy: requires phaseDistribution on the component, or an llmCall function for estimation',
      );
    }

    const result = {
      evolution: centroidEvolution(distribution),
      confidence: concentrationConfidence(distribution),
      method: PublicationAnalysisStrategy.method,
      trace: [{ distribution }],
    };

    return BaseStrategy.validateResult(result);
  }
}

// Export internals for testing
export { parsePubResponse, PUB_PROMPT_TEMPLATE };
