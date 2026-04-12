// Timeline benchmark strategy: evolution estimation based on historical
// capability analysis and iterative timeline reconstruction.
//
// Phase 1: Capability Identification — looks behind technical labels to
//          identify the true underlying capability or need
//          (delegated to src/tools/identify-capability.mjs)
// Phase 2: Recursive Historical Timeline — iteratively builds a chronological
//          timeline of solutions/manifestations until the current year,
//          each milestone evaluated by LLMDirectStrategy with date context
//
// Requires llmCall injection (shared with LLMDirectStrategy internally).

import { BaseStrategy } from './base-strategy.mjs';
import { identifyCapability } from '../../../work-on-value-chain/identify-capability.mjs';
import { LLMDirectStrategy } from './llm-direct-strategy.mjs';

const CURRENT_YEAR = new Date().getFullYear();
const MAX_HISTORY_ITERATIONS = 15;

const HISTORY_ITERATION_PROMPT = `You are an expert in technology history, the history of techniques, and Wardley Mapping.

You are building a chronological timeline of how a capability has been fulfilled throughout history, starting from its Genesis (earliest known manifestation) up to the present year (${CURRENT_YEAR}).

Underlying capability: {{capability}}
Original component: {{component}}
Context: {{context}}
Current year: ${CURRENT_YEAR}

{{history_section}}

{{pacing_guidance}}

Your task: identify the NEXT chronological milestone — the next significant solution, method, or manifestation of this capability that appeared AFTER the ones listed above.

Rules:
- Each milestone must be LATER than the previous one
- Focus on major inflection points, not minor incremental updates
- Space milestones to cover the remaining timeline proportionally

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
 * @param {Array<{ name: string, date: number, evolution: number, confidence: number }>} history
 * @returns {string}
 */
export function formatHistorySection(history) {
  if (history.length === 0) {
    return 'History so far: (none — identify the GENESIS-ERA origin: the EARLIEST known form of this capability, when it was first conceived or rudimentarily practiced. This should be in the Genesis stage of evolution: novel, poorly understood, rare.)';
  }
  const lines = history.map(
    h => `- ${h.name} (${h.date}): evolution=${h.evolution}`,
  );
  const last = history[history.length - 1];
  return `History so far (chronological):\n${lines.join('\n')}\n\nContinue from after ${last.name} (${last.date}).`;
}

/**
 * Generate adaptive pacing guidance so the LLM spaces milestones to reach the present.
 * @param {Array<{ date: number }>} history
 * @param {number} iteration - current iteration index (0-based)
 * @param {number} maxIterations
 * @returns {string}
 */
export function formatPacingGuidance(history, iteration, maxIterations) {
  const remaining = maxIterations - iteration - 1;
  const lastDate = history.length > 0 ? history[history.length - 1].date : null;
  const yearsToGo = lastDate != null ? CURRENT_YEAR - lastDate : null;

  if (remaining <= 1) {
    return `FINAL ITERATION: This must be the current or most recent manifestation of this capability in ${CURRENT_YEAR}.`;
  }
  if (remaining <= 3) {
    return `IMPORTANT: Only ${remaining} iterations remain to reach ${CURRENT_YEAR}. ${yearsToGo != null ? `You still need to cover ~${yearsToGo} years. ` : ''}Your next milestone should jump significantly forward in time.`;
  }
  if (lastDate != null && yearsToGo > 0) {
    const avgGap = Math.ceil(yearsToGo / remaining);
    return `PACING: ${remaining} iterations remaining to reach ${CURRENT_YEAR}. Last milestone was in ${lastDate} (~${yearsToGo} years to go). Aim for roughly ${avgGap}-year gaps between milestones.`;
  }
  return '';
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

  // Factor 4: temporal coverage — did the timeline reach the present?
  const firstDate = history[0].date;
  const lastDate = history[history.length - 1].date;
  const totalSpan = CURRENT_YEAR - firstDate;
  const coveredSpan = lastDate - firstDate;
  const coverageFactor = totalSpan > 0 ? Math.min(coveredSpan / totalSpan, 1) : 0;

  return Math.round(
    Math.max(0.2, Math.min(0.95,
      iterationFactor * 0.15 + monotonicityFactor * 0.20 + avgLlmConfidence * 0.40 + coverageFactor * 0.20 + 0.05,
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

  static get disabled() {
    return {
      reason: 'High LLM latency (>30 min/run) — disabled pending optimization',
    };
  }

  /**
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('./base-strategy.mjs').EvolutionResult>}
   */
  async evaluate(component) {
    if (!this._llmCall) {
      throw new Error('TimelineBenchmarkStrategy requires an llmCall function');
    }

    // ── Phase 1: Capability Identification (skip if pre-identified by orchestrator)
    const capability = component.capability
      ? { capability: component.capability, nature: component.nature || 'none' }
      : await identifyCapability(component, this._llmCall);

    // ── Phase 2: Recursive Historical Timeline Loop ─────────────────
    const llmDirect = new LLMDirectStrategy({ llmCall: this._llmCall });
    const history = []; // Array<{ name, date, evolution, confidence, certitude, ubiquity }>

    for (let i = 0; i < MAX_HISTORY_ITERATIONS; i++) {
      const historySection = formatHistorySection(history);
      const pacingGuidance = formatPacingGuidance(history, i, MAX_HISTORY_ITERATIONS);

      const iterationPrompt = HISTORY_ITERATION_PROMPT
        .replace('{{capability}}', capability.capability)
        .replace('{{component}}', component.name || '')
        .replace('{{context}}', component.description || component.context || '')
        .replace('{{history_section}}', historySection)
        .replace('{{pacing_guidance}}', pacingGuidance);

      let milestone;
      try {
        const response = await this._llmCall(iterationPrompt);
        milestone = parseHistoryIterationResponse(response);
      } catch (err) {
        // If LLM fails mid-loop and we have at least one result, use it
        if (history.length > 0) break;
        throw err;
      }

      // Evaluate evolution of the capability (not the milestone name) at the milestone date
      let evoResult;
      try {
        evoResult = await llmDirect.evaluate({
          name: milestone.name,
          capability: capability.capability,
          nature: capability.nature,
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
      });

      // Termination: reached current year
      if (milestone.date >= CURRENT_YEAR) {
        break;
      }
    }

    // ── Fallback: force present-day evaluation if loop didn't reach current year
    if (history.length > 0 && history[history.length - 1].date < CURRENT_YEAR) {
      try {
        const presentResult = await llmDirect.evaluate({
          name: component.name || capability.capability,
          capability: capability.capability,
          nature: capability.nature,
          context: component.description || component.context || '',
          date: CURRENT_YEAR,
        });
        history.push({
          name: `${component.name || capability.capability} (${CURRENT_YEAR})`,
          date: CURRENT_YEAR,
          evolution: presentResult.evolution,
          confidence: presentResult.confidence,
          _fallback: true,
        });
      } catch {
        // If fallback fails, proceed with accumulated history
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
