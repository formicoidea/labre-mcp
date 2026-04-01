// Logprob distribution strategy: uses LLM token-level log-probabilities
// to build a probability distribution over Wardley evolution phases, then
// computes a weighted evolution estimate from those probabilities.
//
// This is a model-based strategy — it requires an LLM logprob call function
// to be injected at construction time.
//
// The strategy:
//   1. Sends a prompt asking the LLM to classify the component into an
//      evolution phase (Genesis, Custom, Product, Commodity)
//   2. Extracts logprobs for the phase tokens from the response
//   3. Converts logprobs to probabilities via softmax
//   4. Computes evolution as a probability-weighted centroid of phase midpoints
//   5. Confidence is derived from the entropy of the distribution
//      (peaked = high confidence, uniform = low confidence)

import { BaseStrategy } from './base-strategy.mjs';

// Phase midpoints aligned with s-curve.mjs PUB_TYPE_CENTROIDS / phase boundaries
const PHASE_CENTROIDS = {
  genesis:   0.09,   // [0, 0.18]
  custom:    0.22,   // [0.18, 0.40]
  product:   0.48,   // [0.40, 0.70]
  commodity: 0.85,   // [0.70, 1.0]
};

const PHASE_NAMES = Object.keys(PHASE_CENTROIDS);

const PROMPT_TEMPLATE = `You are an expert in Wardley Mapping and technology evolution.

Classify the following component into exactly ONE evolution phase.

The four phases are:
- Genesis: novel, poorly understood, high uncertainty, experimental
- Custom: emerging understanding, being built to solve specific needs
- Product: well-understood, feature-rich, multiple competing implementations
- Commodity: standardized, utility, cost-driven, ubiquitous

Component: {{component}}
Context: {{context}}

Reply with EXACTLY ONE WORD — the phase name:`;

/**
 * Extract phase probabilities from logprobs data.
 *
 * @param {Array<{token: string, logprob: number}>} logprobs
 *   Array of token logprob objects from the LLM response.
 *   Typically the top logprobs for the first generated token.
 * @returns {Object<string, number>} Phase name → probability (sums to ~1)
 */
function extractPhaseProbabilities(logprobs) {
  // Map each phase to its best matching logprob
  const phaseLogprobs = {};

  for (const phase of PHASE_NAMES) {
    phaseLogprobs[phase] = -Infinity; // default: impossible
  }

  if (logprobs && logprobs.length > 0) {
    for (const entry of logprobs) {
      const token = entry.token.trim().toLowerCase();
      for (const phase of PHASE_NAMES) {
        // Match if the token starts with or equals the phase name
        if (phase.startsWith(token) || token.startsWith(phase)) {
          phaseLogprobs[phase] = Math.max(phaseLogprobs[phase], entry.logprob);
        }
      }
    }
  }

  // Convert logprobs to probabilities via softmax
  // If no logprobs matched at all, fall back to uniform distribution
  const hasAnyMatch = Object.values(phaseLogprobs).some(lp => lp > -Infinity);

  if (!hasAnyMatch) {
    // Uniform fallback
    const uniform = 1 / PHASE_NAMES.length;
    const result = {};
    for (const phase of PHASE_NAMES) {
      result[phase] = uniform;
    }
    return result;
  }

  // Softmax: exp(logprob) / sum(exp(logprobs))
  // logprobs are already in log-space, so exp gives probabilities
  const maxLp = Math.max(...Object.values(phaseLogprobs).filter(v => v > -Infinity));
  const expValues = {};
  let sumExp = 0;

  for (const phase of PHASE_NAMES) {
    // Shift by max for numerical stability, treat -Infinity as 0
    if (phaseLogprobs[phase] === -Infinity) {
      expValues[phase] = 0;
    } else {
      expValues[phase] = Math.exp(phaseLogprobs[phase] - maxLp);
    }
    sumExp += expValues[phase];
  }

  const probabilities = {};
  for (const phase of PHASE_NAMES) {
    probabilities[phase] = sumExp > 0 ? expValues[phase] / sumExp : 1 / PHASE_NAMES.length;
  }

  return probabilities;
}

/**
 * Compute Shannon entropy of a probability distribution (normalized to [0, 1]).
 * @param {Object<string, number>} probs
 * @returns {number} Normalized entropy in [0, 1] (0 = certain, 1 = uniform)
 */
function normalizedEntropy(probs) {
  const values = Object.values(probs).filter(p => p > 0);
  if (values.length <= 1) return 0;
  const maxEntropy = Math.log(values.length);
  const entropy = -values.reduce((s, p) => s + p * Math.log(p), 0);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

export class LogprobDistributionStrategy extends BaseStrategy {

  /**
   * @param {Object} options
   * @param {function(string): Promise<{text: string, logprobs: Array<{token: string, logprob: number}>}>} options.llmLogprobCall
   *   Async function that takes a prompt and returns both the text response
   *   and an array of top token logprobs for the first generated token(s).
   *   The logprobs array should contain objects with `token` and `logprob` fields.
   */
  constructor({ llmLogprobCall } = {}) {
    super();
    if (typeof llmLogprobCall !== 'function') {
      throw new Error('LogprobDistributionStrategy requires an llmLogprobCall function');
    }
    this._llmLogprobCall = llmLogprobCall;
  }

  static get method() {
    return 'logprob-distribution';
  }

  /**
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('./base-strategy.mjs').EvolutionResult>}
   */
  async evaluate(component) {
    const prompt = PROMPT_TEMPLATE
      .replace('{{component}}', component.name || '')
      .replace('{{context}}', component.description || component.context || '');

    const { text, logprobs } = await this._llmLogprobCall(prompt);

    // Extract phase probabilities from logprobs
    let phaseProbabilities;

    if (logprobs && logprobs.length > 0) {
      phaseProbabilities = extractPhaseProbabilities(logprobs);
    } else {
      // Fallback: if no logprobs available, parse the text response as a single phase
      phaseProbabilities = parseFallbackPhase(text);
    }

    // Compute evolution as probability-weighted centroid
    let evolution = 0;
    for (const phase of PHASE_NAMES) {
      evolution += (phaseProbabilities[phase] || 0) * PHASE_CENTROIDS[phase];
    }
    evolution = Math.round(evolution * 1000) / 1000;

    // Confidence from entropy: low entropy = high confidence
    const entropy = normalizedEntropy(phaseProbabilities);
    const confidence = Math.round(Math.max(0.1, 1 - entropy * 0.8) * 1000) / 1000;

    const result = {
      evolution,
      confidence,
      method: LogprobDistributionStrategy.method,
    };

    return BaseStrategy.validateResult(result);
  }
}

/**
 * Fallback when logprobs are not available: parse the text response
 * and create a one-hot probability distribution for the detected phase.
 * @param {string} text - Raw LLM response text
 * @returns {Object<string, number>}
 */
function parseFallbackPhase(text) {
  const lower = (text || '').toLowerCase().trim();
  const probs = {};

  // Try to match a phase name in the response
  let matched = null;
  for (const phase of PHASE_NAMES) {
    if (lower.includes(phase)) {
      matched = phase;
      break;
    }
  }

  for (const phase of PHASE_NAMES) {
    // Give 85% to matched phase, spread 15% across others for slight uncertainty
    if (phase === matched) {
      probs[phase] = 0.85;
    } else {
      probs[phase] = matched ? 0.05 : 0.25; // uniform if nothing matched
    }
  }

  return probs;
}

// Export internals for testing
export { extractPhaseProbabilities, normalizedEntropy, parseFallbackPhase, PHASE_CENTROIDS };
