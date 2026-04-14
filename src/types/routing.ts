// Routing & mode-router types.
//
// Transcribed from JSDoc @typedef in
// src/work-on-evolution/routing/mode-router.mjs, with the conditional
// pipeline fields promoted to a proper discriminated union.

import type { EvolutionResult } from './evolution.js';
import type { ClassificationResult } from './classification.js';
import type { CapabilityPivotResult, SolutionDiscoveryResult } from './pipeline.js';

export type RoutingMode = 'oneshot' | 'guided';

/** Métadonnées de routing solution/capability émises par le router. */
export interface RoutingMetadata {
  type: 'solution' | 'capability';
  confidence: number;
  method?: string;
  evalMode?: 'fast' | 'thorough';
}

/** Question guidée retournée en mode conversationnel. */
export interface NextQuestion {
  property?: string;
  prompt: string;
  options?: string[];
  /** Autres champs tolérés — le formatter les passera tels quels. */
  [key: string]: unknown;
}

/** Payload d'évaluations : map strategy name → résultat (ou erreur). */
export type EvaluationsMap = Record<string, EvolutionResult | { error: string }>;

/**
 * Shape de base partagée par toutes les réponses du router.
 * Les variantes concrètes sont définies ci-dessous en union discriminée.
 */
interface RoutedResponseBase {
  mode: RoutingMode;
  /** Why this mode was selected */
  modeReason: string;
  classification: ClassificationResult;
  /** Re-questioning prompts (non-economic space) */
  reQuestions: string[] | null;
  evaluations: EvaluationsMap | null;
  /** Human-readable summary */
  message: string;
  /** Markdown-formatted output (shared formatter) */
  formatted: string;
  /** Session state for guided mode continuation */
  sessionState: string | null;
  /** Next question in guided mode */
  nextQuestion: NextQuestion | null;
  /** Current phase in guided mode */
  phase: string | null;
  /** Solution/capability routing metadata */
  routing: RoutingMetadata | null;
}

/** Réponse standard (ni pipeline enrichi). */
export interface StandardResponse extends RoutedResponseBase {
  pipeline?: false;
}

/** Réponse enrichie par le pipeline (capability pivot + SotA/legacy). */
export interface PipelineResponse extends RoutedResponseBase {
  pipeline: true;
  componentName: string;
  capabilityPivot: CapabilityPivotResult;
  sotaSolution: unknown | null;
  legacySolution: unknown | null;
  discoveredSolutions: SolutionDiscoveryResult;
  owm: string;
  owmOutput: string;
  standardResult: unknown;
}

/**
 * Union discriminée sur `pipeline: true`.
 * Consommateurs : `if (response.pipeline) { ... response.capabilityPivot ... }`.
 */
export type RoutedResponse = StandardResponse | PipelineResponse;
