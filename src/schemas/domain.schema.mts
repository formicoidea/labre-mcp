// Zod schemas for domain input/result types (ComponentInput, SolutionInput,
// EvolutionResult, SolutionEvolutionResult, PropertyEvaluation).
//
// Source of truth for the shapes consumed by capacity and solution strategies.
// Types are inferred via z.infer and re-exported from src/types/evolution.mts
// and src/types/solution.mts.

import { z } from 'zod';

/** Nature d'une capacité au sens Wardley. */
export const CapabilityNatureSchema = z.enum([
  'activite',
  'pratique',
  'connaissance',
  'donnee',
  'none',
]);
export type CapabilityNature = z.infer<typeof CapabilityNatureSchema>;

/** Phase discrète (1–4) du modèle Wardley. */
export const WardleyPhaseSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type WardleyPhase = z.infer<typeof WardleyPhaseSchema>;

/** Libellé de phase (aligné sur PHASE_LABELS). */
export const PhaseLabelSchema = z.enum(['Genesis', 'Custom', 'Product', 'Commodity']);
export type PhaseLabel = z.infer<typeof PhaseLabelSchema>;

/**
 * Component input shape shared by all capacity strategies.
 * All fields except `name` are optional — strategies consume only what they need.
 */
export const ComponentInputSchema = z.object({
  name: z.string(),
  certitude: z.number().min(0).max(1).optional(),
  ubiquity: z.number().min(0).max(1).optional(),
  wonder: z.number().min(0).max(1).optional(),
  build: z.number().min(0).max(1).optional(),
  operate: z.number().min(0).max(1).optional(),
  usage: z.number().min(0).max(1).optional(),
  description: z.string().optional(),
  context: z.string().optional(),
  date: z.union([z.string(), z.date(), z.number()]).optional(),
  capability: z.string().optional(),
  nature: CapabilityNatureSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ComponentInput = z.infer<typeof ComponentInputSchema>;

/** Input pour l'évaluation d'une solution nommée (e.g. Kubernetes). */
export const SolutionInputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  context: z.string().optional(),
  solutionContext: z.string().optional(),
  date: z.union([z.string(), z.date()]).optional(),
  capability: z.string().optional(),
  nature: CapabilityNatureSchema.optional(),
  isSolution: z.boolean().optional(),
  routerConfidence: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SolutionInput = z.infer<typeof SolutionInputSchema>;

/** Structured result returned by every capacity evolution strategy. */
export const EvolutionResultSchema = z.object({
  evolution: z.number(),
  confidence: z.number(),
  method: z.string(),
  trace: z.array(z.unknown()).optional(),
});
export type EvolutionResult = z.infer<typeof EvolutionResultSchema>;

/** Évaluation d'une propriété individuelle d'une solution. */
export const PropertyEvaluationSchema = z.object({
  property: z.string(),
  phase: WardleyPhaseSchema,
  label: PhaseLabelSchema,
  weight: z.number(),
  reason: z.string().optional(),
});
export type PropertyEvaluation = z.infer<typeof PropertyEvaluationSchema>;

/** Résultat d'évaluation solution — EvolutionResult + breakdown propriétés. */
export const SolutionEvolutionResultSchema = EvolutionResultSchema.extend({
  properties: z.array(PropertyEvaluationSchema).optional(),
});
export type SolutionEvolutionResult = z.infer<typeof SolutionEvolutionResultSchema>;
