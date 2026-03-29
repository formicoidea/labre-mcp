// LLM Direct strategy: asks an LLM to directly estimate certitude, ubiquity,
// and evolution for a Wardley Map component, then reconciles the LLM's direct
// evolution estimate with the S-curve model projection.
//
// This is a model-based strategy — it requires an LLM call function to be
// injected at construction time.
//
// The strategy:
//   1. Sends a structured prompt asking for certitude, ubiquity, and evolution
//   2. Parses the LLM's response
//   3. Computes S-curve evolution from (certitude, ubiquity)
//   4. Returns a weighted blend: 70% S-curve + 30% LLM direct estimate
//      with confidence derived from agreement between the two

import { BaseStrategy } from './base-strategy.mjs';
import { computeEvolution } from '../s-curve.mjs';

const PROMPT_TEMPLATE = `You are an expert in economic science and technology history.

For the given component, estimate THREE values:
- certitude: how well-understood and defined this component is (0 to 1)
- ubiquity: how widespread this component is (0 to 1)
- evolution: your direct estimate of evolution on the Wardley Maps axis (0 to 1)
  Genesis [0, 0.18] | Custom [0.18, 0.26] | Product [0.26, 0.70] | Commodity [0.70, 1.0]

Component: {{component}}
Context: {{context}}

MANDATORY FORMAT: exactly three lines, no additional text:
certitude=X.XX
ubiquity=Y.YY
evolution=Z.ZZ`;

/**
 * Parse the LLM response into certitude, ubiquity, and evolution values.
 * @param {string} text - Raw LLM response
 * @returns {{ certitude: number, ubiquity: number, evolution: number }}
 */
function parseLLMResponse(text) {
  const cMatch = text.match(/certitude[:\s=]*([\d.]+)/i);
  const uMatch = text.match(/ubiquit[éy][:\s=]*([\d.]+)/i);
  const evoMatch = text.match(/evolution[:\s=]*([\d.]+)/i);

  if (!cMatch || !uMatch || !evoMatch) {
    throw new Error(`LLMDirectStrategy: could not parse LLM response: ${text.slice(0, 200)}`);
  }

  return {
    certitude: parseFloat(cMatch[1]),
    ubiquity: parseFloat(uMatch[1]),
    evolution: parseFloat(evoMatch[1]),
  };
}

export class LLMDirectStrategy extends BaseStrategy {

  /**
   * @param {Object} options
   * @param {function(string): Promise<string>} options.llmCall
   *   Async function that takes a prompt string and returns the LLM's text response.
   *   This allows the strategy to be LLM-provider agnostic.
   * @param {number} [options.scurveWeight=0.7]
   *   Weight given to S-curve model (1 - this = LLM direct weight).
   */
  constructor({ llmCall, scurveWeight = 0.7 } = {}) {
    super();
    if (typeof llmCall !== 'function') {
      throw new Error('LLMDirectStrategy requires an llmCall function');
    }
    this._llmCall = llmCall;
    this._scurveWeight = scurveWeight;
  }

  static get method() {
    return 'llm-direct';
  }

  /**
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('./base-strategy.mjs').EvolutionResult>}
   */
  async evaluate(component) {
    const prompt = PROMPT_TEMPLATE
      .replace('{{component}}', component.name || '')
      .replace('{{context}}', component.description || component.context || '');

    const response = await this._llmCall(prompt);
    const parsed = parseLLMResponse(response);

    // S-curve model computation from LLM-estimated certitude/ubiquity
    const scurveResult = computeEvolution(parsed.certitude, parsed.ubiquity);

    // Blend: weighted average of S-curve projection and LLM direct estimate
    const llmWeight = 1 - this._scurveWeight;
    const blendedEvolution = Math.round(
      (this._scurveWeight * scurveResult.evolution + llmWeight * parsed.evolution) * 1000
    ) / 1000;

    // Confidence: high when S-curve and LLM agree, low when they diverge
    const agreement = 1 - Math.abs(scurveResult.evolution - parsed.evolution);
    const confidence = Math.round(
      Math.max(0.1, Math.min(1, agreement * 0.8 + 0.2)) * 1000
    ) / 1000;

    const result = {
      evolution: blendedEvolution,
      confidence,
      method: LLMDirectStrategy.method,
      // Expose LLM-estimated inputs for cross-strategy use (e.g. s-curve)
      certitude: parsed.certitude,
      ubiquity: parsed.ubiquity,
    };

    return BaseStrategy.validateResult(result);
  }
}
