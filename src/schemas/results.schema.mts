// Zod schemas for strategy results: EvolutionResult (capacity),
// PropertyEvaluation, SolutionEvolutionResult.
//
// Types are inferred via z.infer and re-exported from src/types/evolution.mts
// and src/types/solution.mts.

import { z } from 'zod';
import {
  PhaseDistributionSchema,
  PhaseLabelSchema,
  WardleyPhaseSchema,
} from './inputs.schema.mjs';

/**
 * Trace entry attached to EvolutionResult. Strategies may attach a produced
 * distribution for traceability / chaining with downstream consumers.
 * The `trace` array accepts heterogeneous per-strategy bags as well.
 */
export const EvolutionTraceEntrySchema = z.union([
  z.object({ distribution: PhaseDistributionSchema }).passthrough(),
  z.unknown(),
]);

/** Structured result returned by every capacity evolution strategy. */
export const EvolutionResultSchema = z.object({
  evolution: z.number(),
  confidence: z.number(),
  method: z.string(),
  trace: z.array(z.unknown()).optional(),
});
export type EvolutionResult = z.infer<typeof EvolutionResultSchema>;

/** Evaluation of a single solution property. */
export const PropertyEvaluationSchema = z.object({
  property: z.string(),
  phase: WardleyPhaseSchema,
  label: PhaseLabelSchema,
  weight: z.number(),
  reason: z.string().optional(),
});
export type PropertyEvaluation = z.infer<typeof PropertyEvaluationSchema>;

/** Solution evaluation = EvolutionResult + per-property breakdown. */
export const SolutionEvolutionResultSchema = EvolutionResultSchema.extend({
  properties: z.array(PropertyEvaluationSchema).optional(),
});
export type SolutionEvolutionResult = z.infer<typeof SolutionEvolutionResultSchema>;
