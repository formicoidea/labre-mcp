// Solution-side evolution types (discriminated from capability evolution).
//
// Transcribed from JSDoc @typedef blocks in
// src/work-on-evolution/strategies/solution/solution-base-strategy.mjs.

import type { EvolutionResult, CapabilityNature } from './evolution.mjs';

/** Phase discrète (1–4) du modèle Wardley. */
export type WardleyPhase = 1 | 2 | 3 | 4;

/** Libellé de phase (aligné sur PHASE_LABELS). */
export type PhaseLabel = 'Genesis' | 'Custom' | 'Product' | 'Commodity';

/** Input pour l'évaluation d'une solution nommée (e.g. Kubernetes). */
export interface SolutionInput {
  /** Solution / product name */
  name: string;
  /** Free-text context or business description */
  description?: string;
  /** Alternative to description */
  context?: string;
  /** Solution-specific business context (12-property evaluation) */
  solutionContext?: string;
  /** Optional date for temporal context */
  date?: string | Date;
  /** Underlying capability if already identified */
  capability?: string;
  /** Capability nature */
  nature?: CapabilityNature;
  /** Routing flag: true when the router determined this is a solution */
  isSolution?: boolean;
  /** Confidence of the solution/capability classification */
  routerConfidence?: number;
  /** Additional strategy-specific data */
  metadata?: Record<string, unknown>;
}

/** Évaluation d'une propriété individuelle d'une solution. */
export interface PropertyEvaluation {
  /** Property name (e.g. "Market") */
  property: string;
  /** Evaluated phase (1–4) */
  phase: WardleyPhase;
  /** Phase label (Genesis|Custom|Product|Commodity) */
  label: PhaseLabel;
  /** Weight used (default: 1/12) */
  weight: number;
  /** Optional reasoning for this property evaluation */
  reason?: string;
}

/** Résultat d'évaluation solution, aligné sur EvolutionResult + breakdown propriétés. */
export interface SolutionEvolutionResult extends EvolutionResult {
  /** Per-property breakdown (solution-specific extension) */
  properties?: PropertyEvaluation[];
}
