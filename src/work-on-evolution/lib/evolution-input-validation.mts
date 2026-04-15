// Input validation and classification resolution for one-shot evolution estimation
//
// Single responsibility:
//   - validateOneShotInput: Zod-validates the raw input bag (same schema as the
//     estimateEvolution MCP tool since both share the same public surface)
//   - resolveClassification: resolves classification via pre-set space or
//     classification gate
//   - VALID_SPACES: canonical list of valid Wardley spaces (kept for legacy imports)

import { classifyComponent } from '../routing/classification-gate.mjs';
import { EstimateEvolutionInputSchema } from '../../schemas/estimate-evolution.schema.mjs';

// ─── Valid Spaces ────────────────────────────────────────────────────────────

export const VALID_SPACES = ['economic', 'social_good', 'common_good'] as const;

// ─── Input Validation ────────────────────────────────────────────────────────

/**
 * Validate one-shot input parameters via Zod.
 * Throws a ZodError on invalid inputs (with structured `issues`).
 *
 * Delegates to EstimateEvolutionInputSchema — the MCP tool and the direct
 * programmatic API share the same input contract.
 */
export function validateOneShotInput(input: unknown) {
  return EstimateEvolutionInputSchema.parse(input);
}

// ─── Classification Resolution ──────────────────────────────────────────────

/**
 * Resolve classification: use provided space or auto-detect via classification gate.
 *
 * @param {string} name - Component name
 * @param {string} description - Context/description
 * @param {string|undefined} space - Pre-classified space or undefined
 * @returns {import('../routing/classification-gate.mjs').ClassificationResult}
 */
export function resolveClassification(name: string, description: string, space: string | undefined): any {
  if (space) {
    // Use the provided space directly — skip the classification gate
    const requiresReQuestion = space !== 'economic';
    const reasons: Record<string, string> = {
      economic: `"${name}" pre-classified as economic — suitable for Wardley evolution evaluation.`,
      social_good: `"${name}" pre-classified as social_good — naturally available resource outside economic space.`,
      common_good: `"${name}" pre-classified as common_good — collectively managed resource beyond economic space.`,
    };

    return {
      space,
      reason: reasons[space],
      requiresReQuestion,
    };
  }

  // Auto-detect via classification gate
  return classifyComponent(name, description);
}
