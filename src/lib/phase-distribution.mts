// Utilities operating on PhaseDistribution: scalar reduction (centroid)
// and confidence measures (entropy, concentration).
//
// Single source of truth for the arithmetic that was previously duplicated in:
//   - work-on-evolution/write/s-curve/s-curve.mts (pubEvolution)
//   - work-on-evolution/write/strategies/capacity/publication-analysis-strategy.mts
//     (advancedPubEvolution, concentration)
//   - work-on-evolution/write/strategies/capacity/logprob-distribution-strategy.mts
//     (normalizedEntropy, centroid loop)

import type { PhaseDistribution } from '../schemas/inputs.schema.mjs';

/**
 * Probability-weighted centroid on the evolution axis.
 * Returns a value in [0, 1] rounded to 3 decimals.
 * Bins are normalized to sum=1 before averaging.
 */
export function centroidEvolution(dist: PhaseDistribution): number {
  const sum = dist.bins.reduce((s, b) => s + b.probability, 0);
  if (sum === 0) return 0;
  const centroid = dist.bins.reduce(
    (s, b) => s + (b.probability / sum) * b.position,
    0,
  );
  return Math.round(centroid * 1000) / 1000;
}

/**
 * Shannon entropy normalized to [0, 1] (0 = certain, 1 = uniform).
 * Used by logprob-based strategies where uncertainty is intrinsic.
 */
function normalizedEntropy(dist: PhaseDistribution): number {
  const sum = dist.bins.reduce((s, b) => s + b.probability, 0);
  if (sum === 0) return 1;
  const probs = dist.bins.map(b => b.probability / sum).filter(p => p > 0);
  if (probs.length <= 1) return 0;
  const maxEntropy = Math.log(probs.length);
  const entropy = -probs.reduce((s, p) => s + p * Math.log(p), 0);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/**
 * Confidence derived from distribution entropy.
 * Peaked distribution (low entropy) → high confidence.
 * Matches the shape used by logprob-distribution-strategy.
 */
export function entropyConfidence(dist: PhaseDistribution): number {
  const entropy = normalizedEntropy(dist);
  return Math.round(Math.max(0.1, 1 - entropy * 0.8) * 1000) / 1000;
}

/**
 * Confidence derived from the Herfindahl-Hirschman Index (sum of squared
 * proportions). Uniform over N bins = 1/N (min), single dominant = 1 (max).
 * The result is clamped to [0.2, 0.95] to match the prior publication-analysis
 * mapping where a pure uniform still reports a non-zero confidence.
 */
export function concentrationConfidence(dist: PhaseDistribution): number {
  const sum = dist.bins.reduce((s, b) => s + b.probability, 0);
  if (sum === 0) return 0.2;
  const n = dist.bins.length;
  const uniform = 1 / n;
  const hhi = dist.bins.reduce((s, b) => {
    const p = b.probability / sum;
    return s + p * p;
  }, 0);
  const normalized = (hhi - uniform) / (1 - uniform);
  const clamped = Math.max(0.2, Math.min(0.95, 0.3 + normalized * 0.65));
  return Math.round(clamped * 1000) / 1000;
}
