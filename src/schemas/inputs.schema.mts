// Zod schemas for component/solution inputs consumed by capacity and
// solution strategies. Also defines the canonical PhaseDistribution
// primitive shared across publication-analysis, logprob-distribution,
// and any future distribution-based strategy.
//
// Types are inferred via z.infer and re-exported from src/types/evolution.mts
// and src/types/solution.mts.

import { z } from 'zod';

/** Wardley capability nature. */
export const CapabilityNatureSchema = z.enum([
  'activity',
  'practice',
  'knowledge',
  'data',
  'none',
]);
export type CapabilityNature = z.infer<typeof CapabilityNatureSchema>;

/** Discrete phase (1-4) of the Wardley model. */
export const WardleyPhaseSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type WardleyPhase = z.infer<typeof WardleyPhaseSchema>;

/** Phase label aligned with PHASE_LABELS. */
export const PhaseLabelSchema = z.enum(['Genesis', 'Custom', 'Product', 'Commodity']);
export type PhaseLabel = z.infer<typeof PhaseLabelSchema>;

/**
 * Canonical 4-phase midpoints on the Wardley evolution axis [0, 1].
 * Single source of truth — previously duplicated as PUB_TYPE_CENTROIDS
 * in s-curve.mts and PHASE_CENTROIDS in logprob-distribution-strategy.mts.
 */
export const PHASE_CENTROIDS = {
  phase1: 0.09,  // Genesis   [0, 0.18]
  phase2: 0.29,  // Custom    [0.18, 0.40]
  phase3: 0.48,  // Product   [0.40, 0.70]
  phase4: 0.85,  // Commodity [0.70, 1.0]
} as const;

/**
 * Probability mass over the evolution axis [0, 1].
 * Consumed by strategies that estimate phase from a distribution
 * rather than a single (certitude, ubiquity) point.
 */
export const PhaseDistributionSchema = z.object({
  bins: z.array(z.object({
    position: z.number().min(0).max(1),
    probability: z.number().min(0).max(1),
  })).min(1),
}).refine(
  d => Math.abs(d.bins.reduce((s, b) => s + b.probability, 0) - 1) < 0.01,
  { message: 'Probabilities must sum to ~1' },
);
export type PhaseDistribution = z.infer<typeof PhaseDistributionSchema>;

/** Shorthand constructor for the canonical 4-phase discrete case. */
export function phase4Distribution(
  p1: number, p2: number, p3: number, p4: number,
): PhaseDistribution {
  return {
    bins: [
      { position: PHASE_CENTROIDS.phase1, probability: p1 },
      { position: PHASE_CENTROIDS.phase2, probability: p2 },
      { position: PHASE_CENTROIDS.phase3, probability: p3 },
      { position: PHASE_CENTROIDS.phase4, probability: p4 },
    ],
  };
}

/**
 * Component input shape shared by all capacity strategies.
 * All fields except `name` are optional — strategies consume only what they need.
 *
 * `context` = business environment where the component exists (user-provided).
 * `description` = label / semantic hint (enrichable by upstream tooling).
 * The two are intentionally distinct — never fall back from one to the other.
 *
 * `kind: 'capability'` is the discriminant of the EvaluationInput union.
 */
export const ComponentInputSchema = z.object({
  kind: z.literal('capability').default('capability'),
  name: z.string().min(1),
  context: z.string().optional(),
  description: z.string().optional(),
  certitude: z.number().min(0).max(1).optional(),
  ubiquity: z.number().min(0).max(1).optional(),
  phaseDistribution: PhaseDistributionSchema.optional(),
  date: z.union([z.string(), z.date(), z.number()]).optional(),
  capability: z.string().optional(),
  nature: CapabilityNatureSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ComponentInput = z.infer<typeof ComponentInputSchema>;

/**
 * Input for named-solution evaluation (e.g. Kubernetes, Stripe).
 * Market position / adoption pattern signals are composed into `context`
 * by the session layer — no separate metadata bag.
 *
 * `kind: 'solution'` is the discriminant of the EvaluationInput union.
 */
export const SolutionInputSchema = z.object({
  kind: z.literal('solution').default('solution'),
  name: z.string().min(1),
  context: z.string().optional(),
  description: z.string().optional(),
  date: z.union([z.string(), z.date()]).optional(),
  capability: z.string().optional(),
  nature: CapabilityNatureSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SolutionInput = z.infer<typeof SolutionInputSchema>;

/**
 * Discriminated union over `kind`. Consumers that accept either input type
 * should parse via this schema and narrow via `input.kind === 'solution'`.
 */
export const EvaluationInputSchema = z.discriminatedUnion('kind', [
  ComponentInputSchema,
  SolutionInputSchema,
]);
export type EvaluationInput = z.infer<typeof EvaluationInputSchema>;
