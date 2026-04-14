// LLM Direct strategy: asks an LLM to directly estimate evolution for a
// Wardley Map component by reasoning about the underlying capability
// (activity, practice, knowledge, or data) it represents.
//
// This is a model-based strategy — it requires an LLM call function to be
// injected at construction time.
//
// The strategy:
//   1. If a capability is provided, evaluates it directly
//   2. Otherwise, asks the LLM to identify the underlying capability first
//   3. Reasons about the state of the capability at the given date
//   4. Returns a direct evolution estimate with self-assessed confidence

import { BaseStrategy } from './base-strategy.mjs';

const PROMPT_WITH_CAPABILITY = `You are an expert in economic science and technology history.

Capability: {{capability}}
Context: {{context}}
Context date: {{date}}

First, reason briefly about the state of this capability at the given date:
- How was it practiced, known, or used at that time?
- Where would you place it on the Wardley evolution axis?
  Genesis [0, 0.18] | Custom [0.18, 0.40] | Product [0.40, 0.70] | Commodity [0.70, 1.0]

Important rules:
- Evaluate the capability itself, not a specific technical implementation.
- A capability may be old yet still be early in evolution.

MANDATORY FORMAT (last two lines, no text after them):
evolution=Z.ZZ
confidence=X.XX`;

const PROMPT_WITHOUT_CAPABILITY = `You are an expert in economic science and technology history.

Component: {{component}}
Context: {{context}}
Context date: {{date}}

First, identify the underlying capability (activity, practice, knowledge, or data) that this component represents. Then reason briefly about its state at the given date:
- What capability does this component fulfill?
- How was that capability practiced, known, or used at that time?
- Where would you place it on the Wardley evolution axis?
  Genesis [0, 0.18] | Custom [0.18, 0.40] | Product [0.40, 0.70] | Commodity [0.70, 1.0]

Important rules:
- Evaluate the underlying capability, not the specific technical label.
- A capability may be old yet still be early in evolution.

MANDATORY FORMAT (last two lines, no text after them):
evolution=Z.ZZ
confidence=X.XX`;

/**
 * Parse the LLM response into evolution and confidence values.
 * @param {string} text - Raw LLM response
 * @returns {{ evolution: number, confidence: number }}
 */
function parseLLMResponse(text) {
  const evoMatch = text.match(/evolution[:\s=]*([\d.]+)/i);
  const confMatch = text.match(/confidence[:\s=]*([\d.]+)/i);

  if (!evoMatch) {
    throw new Error(`LLMDirectStrategy: could not parse LLM response: ${text.slice(0, 200)}`);
  }

  return {
    evolution: parseFloat(evoMatch[1]),
    confidence: confMatch ? parseFloat(confMatch[1]) : 0.6,
  };
}

export class LLMDirectStrategy extends BaseStrategy {

  /**
   * @param {Object} options
   * @param {function(string): Promise<string>} options.llmCall
   *   Async function that takes a prompt string and returns the LLM's text response.
   *   This allows the strategy to be LLM-provider agnostic.
   */
  _llmCall: any;

  constructor({ llmCall }: any = {}) {
    super();
    if (typeof llmCall !== 'function') {
      throw new Error('LLMDirectStrategy requires an llmCall function');
    }
    this._llmCall = llmCall;
  }

  static get method() {
    return 'llm-direct';
  }

  /**
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('./base-strategy.mjs').EvolutionResult>}
   */
  async evaluate(component) {
    const hasCapability = component.capability != null;

    const prompt = hasCapability
      ? PROMPT_WITH_CAPABILITY
          .replace('{{capability}}', component.capability)
          .replace('{{context}}', component.description || component.context || '')
          .replace('{{date}}', String(component.date ? new Date(component.date).getFullYear() : 'unknown'))
      : PROMPT_WITHOUT_CAPABILITY
          .replace('{{component}}', component.name || '')
          .replace('{{context}}', component.description || component.context || '')
          .replace('{{date}}', String(component.date ? new Date(component.date).getFullYear() : 'unknown'));

    const response = await this._llmCall(prompt);
    const parsed = parseLLMResponse(response);

    const evolution = Math.round(
      Math.max(0, Math.min(1, parsed.evolution)) * 1000
    ) / 1000;

    const confidence = Math.round(
      Math.max(0.1, Math.min(1, parsed.confidence)) * 1000
    ) / 1000;

    return BaseStrategy.validateResult({
      evolution,
      confidence,
      method: LLMDirectStrategy.method,
    });
  }
}
