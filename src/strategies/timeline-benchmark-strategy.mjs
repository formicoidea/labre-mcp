// Timeline benchmark strategy: evolution estimation based on historical
// capability analysis and iterative timeline reconstruction.
//
// Phase 1: Capability Identification — looks behind technical labels to
//          identify the true underlying capability or need
//          (delegated to src/identify-capability.mjs)
// Phase 2: Recursive Historical Timeline — iteratively builds a chronological
//          timeline of solutions/manifestations until the current year,
//          each milestone evaluated by LLMDirectStrategy with date context
//
// Requires llmCall injection (shared with LLMDirectStrategy internally).

import { BaseStrategy } from './base-strategy.mjs';
import { identifyCapability } from '../identify-capability.mjs';
import { LLMDirectStrategy } from './llm-direct-strategy.mjs';

const CURRENT_YEAR = new Date().getFullYear();
const MAX_HISTORY_ITERATIONS = 15;

const HISTORY_ITERATION_PROMPT = `You are an expert in technology history, the history of techniques, and Wardley Mapping.

You are building a chronological timeline of how a capability has been fulfilled throughout history.

Underlying capability: {{capability}}
Original component: {{component}}
Context: {{context}}
Current year: ${CURRENT_YEAR}

{{history_section}}

Your task: identify the NEXT chronological milestone — the next significant solution, method, or manifestation of this capability that appeared AFTER the ones listed above.

Rules:
- Each milestone must be LATER than the previous one
- Focus on major inflection points, not minor incremental updates

MANDATORY FORMAT: exactly two lines at the end, no additional text after them:
milestone_name=<name of the solution or manifestation>
milestone_date=<year as integer>`;

/**
 * Parse a single history iteration response from the LLM.
 * @param {string} text
 * @returns {{ name: string, date: number }}
 */
export function parseHistoryIterationResponse(text) {
  const nameMatch = text.match(/milestone_name[:\s=]*(.*)/i);
  const dateMatch = text.match(/milestone_date[:\s=]*(\d+)/i);

  if (!nameMatch || !dateMatch) {
    throw new Error(`TimelineBenchmarkStrategy: could not parse history iteration: ${text.slice(0, 200)}`);
  }

  return {
    name: nameMatch[1].trim(),
    date: parseInt(dateMatch[1], 10),
  };
}

/**
 * Format the accumulated history into a text section for the next prompt.
 * @param {Array<{ name: string, date: number, evolution: number, certitude: number, ubiquity: number }>} history
 * @returns {string}
 */
export function formatHistorySection(history) {
  if (history.length === 0) {
    return 'History so far: (none — you are identifying the OLDEST known solution for this capability)';
  }
  const lines = history.map(
    h => `- ${h.name} (${h.date}): evolution=${h.evolution}, certitude=${h.certitude}, ubiquity=${h.ubiquity}`,
  );
  const last = history[history.length - 1];
  return `History so far (chronological):\n${lines.join('\n')}\n\nContinue from after ${last.name} (${last.date}).`;
}

/**
 * Compute confidence from the richness, internal consistency, and LLM-direct confidence of the timeline.
 * @param {Array<{ name: string, date: number, evolution: number, confidence: number }>} history
 * @returns {number} confidence in [0.2, 0.95]
 */
export function computeTimelineConfidence(history) {
  if (history.length === 0) return 0.2;

  // Factor 1: iteration richness (more milestones = more grounded)
  const iterationFactor = Math.min(history.length / MAX_HISTORY_ITERATIONS, 1);

  // Factor 2: monotonicity of evolution values
  let monotonicSteps = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i].evolution >= history[i - 1].evolution) {
      monotonicSteps++;
    }
  }
  const monotonicityFactor = history.length > 1
    ? monotonicSteps / (history.length - 1)
    : 1;

  // Factor 3: average confidence from LLM-direct evaluations
  const avgLlmConfidence = history.reduce((s, h) => s + h.confidence, 0) / history.length;

  return Math.round(
    Math.max(0.2, Math.min(0.95,
      iterationFactor * 0.25 + monotonicityFactor * 0.25 + avgLlmConfidence * 0.45 + 0.05,
    )) * 1000,
  ) / 1000;
}

export class TimelineBenchmarkStrategy extends BaseStrategy {

  /**
   * @param {Object} [options]
   * @param {function(string): Promise<string>} [options.llmCall]
   *   Async function for LLM calls. Required for both phases.
   */
  constructor({ llmCall } = {}) {
    super();
    this._llmCall = llmCall || null;
  }

  static get method() {
    return 'timeline-benchmark';
  }

  /**
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('./base-strategy.mjs').EvolutionResult>}
   */
  async evaluate(component) {
    if (!this._llmCall) {
      throw new Error('TimelineBenchmarkStrategy requires an llmCall function');
    }

    // ── Phase 1: Capability Identification ──────────────────────────
    const capability = await identifyCapability(component, this._llmCall);

    // ── Phase 2: Recursive Historical Timeline Loop ─────────────────
    const llmDirect = new LLMDirectStrategy({ llmCall: this._llmCall });
    const history = []; // Array<{ name, date, evolution, confidence, certitude, ubiquity }>

    for (let i = 0; i < MAX_HISTORY_ITERATIONS; i++) {
      const historySection = formatHistorySection(history);

      const iterationPrompt = HISTORY_ITERATION_PROMPT
        .replace('{{capability}}', capability.capability)
        .replace('{{component}}', component.name || '')
        .replace('{{context}}', component.description || component.context || '')
        .replace('{{history_section}}', historySection);

      let milestone;
      try {
        const response = await this._llmCall(iterationPrompt);
        milestone = parseHistoryIterationResponse(response);
      } catch (err) {
        // If LLM fails mid-loop and we have at least one result, use it
        if (history.length > 0) break;
        throw err;
      }

      // Evaluate evolution via LLMDirectStrategy with date context
      let evoResult;
      try {
        evoResult = await llmDirect.evaluate({
          name: milestone.name,
          context: component.description || component.context || '',
          date: milestone.date,
        });
      } catch (err) {
        if (history.length > 0) break;
        throw err;
      }

      history.push({
        name: milestone.name,
        date: milestone.date,
        evolution: evoResult.evolution,
        confidence: evoResult.confidence,
        certitude: evoResult.certitude,
        ubiquity: evoResult.ubiquity,
      });

      // Termination: reached current year
      if (milestone.date >= CURRENT_YEAR) {
        break;
      }
    }

    // ── Compute final result ────────────────────────────────────────
    const lastMilestone = history[history.length - 1];
    const evolution = Math.round(
      Math.max(0, Math.min(1, lastMilestone.evolution)) * 1000,
    ) / 1000;
    const confidence = computeTimelineConfidence(history);

    const result = {
      evolution,
      confidence,
      method: TimelineBenchmarkStrategy.method,
      trace: history,
    };

    return BaseStrategy.validateResult(result);
  }
}
