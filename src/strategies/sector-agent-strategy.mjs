// Sector agent strategy: agent-based evolution estimation that analyzes
// a component through sector/industry-specific reasoning.
//
// This is a model-based strategy — it requires an LLM call function to be
// injected at construction time.
//
// The strategy simulates a multi-perspective agent approach:
//   1. Asks the LLM to reason as a sector analyst, identifying:
//      - The industry/sector the component belongs to
//      - How mature the component is within that sector
//      - Market consolidation signals (number of providers, standardization)
//      - Adoption lifecycle position (innovators → laggards)
//   2. Extracts structured certitude, ubiquity, and evolution estimates
//   3. Computes S-curve evolution from (certitude, ubiquity) as anchor
//   4. Blends sector-specific estimate with S-curve model
//   5. Confidence reflects agreement between sector reasoning and model

import { BaseStrategy } from './base-strategy.mjs';
import { computeEvolution } from '../s-curve.mjs';

const SECTOR_PROMPT_TEMPLATE = `You are a sector analyst specializing in technology and industry evolution.

Analyze the following component from a sector/industry perspective:

1. Identify the primary sector or industry this component belongs to
2. Assess the component's maturity within that sector:
   - How many competing providers exist? (few = early, many = product, consolidating = commodity)
   - How standardized are the interfaces and practices?
   - Where is it on the adoption curve? (innovators, early adopters, early majority, late majority, laggards)
3. Based on your sector analysis, estimate:
   - certitude: how well-understood and defined (0 to 1)
   - ubiquity: how widespread within its sector (0 to 1)
   - evolution: your estimate on the Wardley Maps evolution axis (0 to 1)
     Genesis [0, 0.18] | Custom [0.18, 0.26] | Product [0.26, 0.70] | Commodity [0.70, 1.0]

Component: {{component}}
Context: {{context}}

MANDATORY FORMAT: exactly three lines of estimates, no additional text:
certitude=X.XX
ubiquity=Y.YY
evolution=Z.ZZ`;

/**
 * Parse the sector agent LLM response into numeric values.
 * @param {string} text - Raw LLM response
 * @returns {{ certitude: number, ubiquity: number, evolution: number }}
 */
function parseSectorResponse(text) {
  const cMatch = text.match(/certitude[:\s=]*([\d.]+)/i);
  const uMatch = text.match(/ubiquit[éy][:\s=]*([\d.]+)/i);
  const evoMatch = text.match(/evolution[:\s=]*([\d.]+)/i);

  if (!cMatch || !uMatch || !evoMatch) {
    throw new Error(`SectorAgentStrategy: could not parse LLM response: ${text.slice(0, 200)}`);
  }

  return {
    certitude: parseFloat(cMatch[1]),
    ubiquity: parseFloat(uMatch[1]),
    evolution: parseFloat(evoMatch[1]),
  };
}

/**
 * Adoption curve position → evolution adjustment factor.
 * Used to cross-validate the LLM's sector analysis.
 *
 * @param {number} evolution - Raw LLM evolution estimate
 * @param {number} certitude - Certitude score
 * @param {number} ubiquity - Ubiquity score
 * @returns {number} Adjusted evolution value
 */
function sectorAdjust(evolution, certitude, ubiquity) {
  // High ubiquity + high certitude signals commodity — floor the evolution
  if (ubiquity > 0.8 && certitude > 0.8 && evolution < 0.7) {
    return Math.max(evolution, 0.7);
  }
  // Low ubiquity + low certitude signals genesis — cap the evolution
  if (ubiquity < 0.2 && certitude < 0.3 && evolution > 0.26) {
    return Math.min(evolution, 0.26);
  }
  return evolution;
}

export class SectorAgentStrategy extends BaseStrategy {

  /**
   * @param {Object} options
   * @param {function(string): Promise<string>} options.llmCall
   *   Async function that takes a prompt string and returns the LLM's text response.
   * @param {number} [options.modelWeight=0.6]
   *   Weight given to S-curve model (1 - this = sector agent weight).
   */
  constructor({ llmCall, modelWeight = 0.6 } = {}) {
    super();
    if (typeof llmCall !== 'function') {
      throw new Error('SectorAgentStrategy requires an llmCall function');
    }
    this._llmCall = llmCall;
    this._modelWeight = modelWeight;
  }

  static get method() {
    return 'sector-agent';
  }

  /**
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('./base-strategy.mjs').EvolutionResult>}
   */
  async evaluate(component) {
    const prompt = SECTOR_PROMPT_TEMPLATE
      .replace('{{component}}', component.name || '')
      .replace('{{context}}', component.description || component.context || '');

    const response = await this._llmCall(prompt);
    const parsed = parseSectorResponse(response);

    // Apply sector-specific adjustments for consistency
    const adjustedEvolution = sectorAdjust(parsed.evolution, parsed.certitude, parsed.ubiquity);

    // S-curve model computation from sector-estimated certitude/ubiquity
    const scurveResult = computeEvolution(parsed.certitude, parsed.ubiquity);

    // Blend: weighted average of S-curve model and sector agent estimate
    const agentWeight = 1 - this._modelWeight;
    const blendedEvolution = Math.round(
      (this._modelWeight * scurveResult.evolution + agentWeight * adjustedEvolution) * 1000
    ) / 1000;

    // Confidence: derived from agreement between sector reasoning and model
    const agreement = 1 - Math.abs(scurveResult.evolution - adjustedEvolution);
    const confidence = Math.round(
      Math.max(0.1, Math.min(1, agreement * 0.7 + 0.3)) * 1000
    ) / 1000;

    const result = {
      evolution: blendedEvolution,
      confidence,
      method: SectorAgentStrategy.method,
      // Expose LLM-estimated inputs for cross-strategy use (e.g. s-curve)
      certitude: parsed.certitude,
      ubiquity: parsed.ubiquity,
    };

    return BaseStrategy.validateResult(result);
  }
}

// Export internals for testing
export { parseSectorResponse, sectorAdjust };
