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
import type { ComponentInput, EvolutionResult } from '../../../types/evolution.mjs';
import { parseKeyValueBlock } from '../../../lib/prompts/parsers.mjs';
import { getPrompt } from '../../../lib/prompts/registry.mjs';

// Prompt text lives in prompts/llm-direct.{with,without}-capability.md.

/**
 * Parse the LLM response into evolution and confidence values.
 * @param {string} text - Raw LLM response
 * @returns {{ evolution: number, confidence: number }}
 */
function parseLLMResponse(text: string): any {
  const raw = parseKeyValueBlock(text, ['evolution', 'confidence'], { separator: 'any', anchored: false });

  if (raw.evolution === undefined) {
    throw new Error(`LLMDirectStrategy: could not parse LLM response: ${text.slice(0, 200)}`);
  }

  return {
    evolution: parseFloat(raw.evolution),
    confidence: raw.confidence !== undefined ? parseFloat(raw.confidence) : 0.6,
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
  async evaluate(component: ComponentInput): Promise<EvolutionResult> {
    const hasCapability = component.capability != null;

    if (!component.context) {
      console.warn(
        `[${LLMDirectStrategy.method}] no context provided for "${component.name}" — evaluation accuracy may be degraded`,
      );
    }

    const dateStr = String(component.date ? new Date(component.date).getFullYear() : 'unknown');
    const prompt = hasCapability
      ? getPrompt('llm-direct', 'with-capability').build({
          capability: component.capability ?? '',
          description: component.description ?? '',
          context: component.context ?? '',
          date: dateStr,
        })
      : getPrompt('llm-direct', 'without-capability').build({
          component: component.name || '',
          description: component.description ?? '',
          context: component.context ?? '',
          date: dateStr,
        });

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
